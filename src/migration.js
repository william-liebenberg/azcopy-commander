import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { buildSourceUrl, buildTargetBase, buildTargetUrl, Redactor } from './urls.js';
import { parseLastCopyDate, toAzcopyDate } from './dates.js';
import { EXIT } from './job.js';
import { readState, saveState, stateKey } from './state.js';
import { fileTimestamp, formatBytes, formatCount } from './format.js';
import { UsageError } from './errors.js';
import {
  askYesNo, azcopyCommand, azcopyFlags, copyArgs, deltaDateFor, execute, outputRoot, readManifest, readTarget, requireAwsCredentials,
  resolveLastCopyDate, resolveSource, runPaths, stateFile,
} from './commands.js';
import { analyseInventory, analysisLines, azcopyProvider, InventoryAborted, InventoryError, s3Provider, writeInventory } from './inventory.js';
import { chunkId, createChunks, parseCount, parseSize } from './chunks.js';
import { ChunkView, deltaLines, formatAggregate, isFinished, MigrationProgress, PlainMigrationView } from './migration-view.js';

/*
 * `migrate`: a large migration in phases, recorded in a migration folder so it can be stopped and continued.
 *
 *   inventory  the source is listed into inventory.jsonl           (azcopy dry-run, or S3 ListObjectsV2)
 *   analysis   inventory-summary.json                              (counts, sizes, prefixes)
 *   chunking   chunks/00001.txt ...                                (lists for azcopy --list-of-files)
 *   copying    a pool of --parallel azcopy jobs, chunks in order   (each chunk is an ordinary run directory)
 *
 * migration.json is the record: the options, the state of each phase and one entry per chunk
 * ({ id, list, files, bytes, status, attempts, runs, copied, ignored, failed, bytesCopied, carried? }).
 *
 * A delta migration (`includeAfter` set, folder <ts>-delta-migration) lists only the objects modified on/after a
 * date. Its `baseline` ({ startedAt, dir } or null) is the migration or run the date came from; when that is a
 * migration, the files it did not copy are `carried` into the delta as its first chunk(s) (see collectCarried).
 * Chunk status: pending, running, success, partial (some files failed), failed, interrupted, exhausted (out of attempts).
 * No secret is ever written to it, to the logs or to the lists: the SAS and the AWS keys stay in memory.
 */

const CLI = 'azcopy-commander';
export const MIGRATION_DEFAULTS = { inventorySource: 'azcopy', chunkFiles: 1_000_000, chunkBytes: 2 ** 40, parallel: 10, maxAttempts: 5 };
const LOG_INTERVAL_MS = 30_000;
const MIGRATION_DIR_RE = /^\d{8}T\d{6}Z-(delta-)?migration$/;
export const REPEAT_DEFAULTS = { until: 10_000, max: 10 };
const EXIT_BY_OUTCOME = { success: EXIT.OK, partial: EXIT.PARTIAL, failed: EXIT.FAILED, interrupted: EXIT.INTERRUPTED, stopped: EXIT.OK };
const STOP_AFTER = ['inventory', 'chunk'];

// ---------------------------------------------------------------- the migration folder

export const migrationFile = (dir) => path.join(dir, 'migration.json');

export function readMigration(dir) {
  const file = migrationFile(dir);
  if (!fs.existsSync(file)) throw new UsageError(`${file} not found: --migration must be a migration folder created by \`${CLI} migrate\`.`);
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

/** Write + rename, so a crash never leaves a half-written migration.json. */
export function writeMigration(dir, migration) {
  const file = migrationFile(dir);
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(migration, null, 2)}\n`);
  fs.renameSync(tmp, file);
}

const phaseOf = (m) => (m.inventory.status !== 'done' ? 'inventory' : m.chunking.status !== 'done' ? 'chunking' : m.chunks.every(isFinished) ? 'done' : 'copying');

/**
 * The migrations in the output directory, newest first:
 * `{ dir, startedAt, outcome, phase, mode, includeAfter, chunksDone, chunksTotal, bucket, prefix, region, targetBase, overwriteModified }`.
 * `phase` is inventory, chunking, copying or done; `mode` is full or delta. Folders without a migration.json are not migrations.
 */
export function listMigrations(opts = {}) {
  const root = outputRoot(opts);
  const names = fs.existsSync(root) ? fs.readdirSync(root) : [];
  return names
    .filter((n) => MIGRATION_DIR_RE.test(n))
    .flatMap((name) => {
      const dir = path.join(root, name);
      let m;
      try {
        m = JSON.parse(fs.readFileSync(migrationFile(dir), 'utf8'));
      } catch {
        return [];
      }
      return [{
        dir,
        startedAt: m.startedAt,
        outcome: m.outcome ?? 'unknown',
        phase: phaseOf(m),
        mode: m.includeAfter ? 'delta' : 'full',
        includeAfter: m.includeAfter ?? null,
        chunksDone: m.chunks.filter(isFinished).length,
        chunksTotal: m.chunks.length,
        bucket: m.bucket,
        prefix: m.prefix ?? '',
        region: m.region ?? '',
        targetBase: m.targetBase,
        overwriteModified: Boolean(m.overwriteModified),
      }];
    })
    // By their start: a delta and the migration before it can share the second of their folder names.
    .sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)) || b.dir.localeCompare(a.dir));
}

// ---------------------------------------------------------------- options

/** Validates the migrate options (CLI strings or numbers); `base` holds the values of a migration being continued. */
function parseOptions(opts, base = MIGRATION_DEFAULTS) {
  const inventorySource = opts.inventorySource ?? base.inventorySource;
  if (!['azcopy', 's3'].includes(inventorySource)) throw new UsageError(`Invalid --inventory-source "${inventorySource}": use azcopy or s3.`);
  return {
    inventorySource,
    chunkFiles: opts.chunkFiles === undefined ? base.chunkFiles : parseCount(opts.chunkFiles, '--chunk-files'),
    chunkBytes: opts.chunkBytes === undefined ? base.chunkBytes : parseSize(opts.chunkBytes, '--chunk-bytes'),
    parallel: opts.parallel === undefined ? base.parallel : parseCount(opts.parallel, '--parallel'),
    maxAttempts: opts.maxAttempts === undefined ? base.maxAttempts : parseCount(opts.maxAttempts, '--max-attempts'),
  };
}

function parseStopAfter(value) {
  if (value !== undefined && !STOP_AFTER.includes(value)) throw new UsageError(`Invalid --stop-after "${value}": use ${STOP_AFTER.join(' or ')}.`);
  return value;
}

/** --repeat, --repeat-until (0 or more), --repeat-max: `{ until, max }`, or null without --repeat. */
function parseRepeat(opts) {
  if (!opts.repeat) {
    for (const [key, flag] of [['repeatUntil', '--repeat-until'], ['repeatMax', '--repeat-max']]) {
      if (opts[key] !== undefined) throw new UsageError(`${flag} needs --repeat.`);
    }
    return null;
  }
  if (opts.stopAfter !== undefined) throw new UsageError('--repeat cannot be used with --stop-after: the deltas follow a migration that ran to its end.');
  let until = REPEAT_DEFAULTS.until;
  if (opts.repeatUntil !== undefined) {
    until = typeof opts.repeatUntil === 'number' ? opts.repeatUntil : /^\s*\d+\s*$/.test(String(opts.repeatUntil)) ? Number(opts.repeatUntil) : NaN;
    if (!Number.isSafeInteger(until) || until < 0) throw new UsageError(`Invalid --repeat-until "${opts.repeatUntil}": a whole number of objects (0 or more) is needed.`);
  }
  const max = opts.repeatMax === undefined ? REPEAT_DEFAULTS.max : parseCount(opts.repeatMax, '--repeat-max');
  return { until, max };
}

/**
 * The delta date of a new migration and where it comes from: `{ includeAfter, baseline }` (`baseline` is
 * `{ startedAt, dir }` or null).
 *   opts.baselineDir         a migration folder (the wizard, --repeat): its start minus the `auto` overlap, unless a
 *                            date is given too; the baseline is that migration
 *   --last-copy-date auto    the state.json entry of this source and target; the baseline is the run it names
 *   --last-copy-date <date>  no baseline
 */
export function resolveDelta(opts, key, now = new Date()) {
  if (opts.baselineDir) {
    const dir = path.resolve(opts.baselineDir);
    const b = readMigration(dir);
    const date = opts.lastCopyDate && opts.lastCopyDate !== 'auto' ? parseLastCopyDate(opts.lastCopyDate, now) : deltaDateFor(b);
    return { includeAfter: toAzcopyDate(date), baseline: { startedAt: b.startedAt, dir } };
  }
  if (!opts.lastCopyDate) return { includeAfter: null, baseline: null };
  const includeAfter = toAzcopyDate(resolveLastCopyDate(opts.lastCopyDate, { opts, key, now }));
  if (opts.lastCopyDate !== 'auto') return { includeAfter, baseline: null };
  const previous = readState(stateFile(opts))[key];
  return { includeAfter, baseline: { startedAt: previous.startedAt, dir: previous.runDir } };
}

/**
 * What a baseline migration did not copy, for a delta: `{ paths: Map(path -> size), files, bytes, fromChunks, migration }`,
 * or null when `baselineDir` is not a migration folder (a copy run). Only its exhausted chunks count:
 *   last outcome partial   the paths in the failed-*.jsonl of the chunk's last run, with their sizes
 *   last outcome failed    the whole chunk list (the job itself failed; what it did copy is skipped by azcopy,
 *                          since copying is append-only); the list has no sizes, so the chunk's bytes are spread over it
 */
export function collectCarried(baselineDir) {
  if (!baselineDir || !fs.existsSync(migrationFile(baselineDir))) return null;
  const migration = readMigration(baselineDir);
  const paths = new Map();
  const fromChunks = [];
  for (const c of migration.chunks ?? []) {
    if (c.status !== 'exhausted') continue;
    const before = paths.size;
    if (c.lastOutcome === 'failed') {
      const list = path.join(baselineDir, c.list ?? '');
      const lines = c.list && fs.existsSync(list) ? fs.readFileSync(list, 'utf8').split('\n').filter(Boolean) : [];
      const each = lines.length > 0 ? Math.round((Number(c.bytes) || 0) / lines.length) : 0;
      for (const p of lines) paths.set(p, each);
    } else {
      const lastRun = c.runs?.at(-1);
      for (const r of lastRun ? failedRecords(path.join(baselineDir, lastRun)) : []) paths.set(r.relativePath, Number(r.size) || 0);
    }
    if (paths.size > before) fromChunks.push(c.id);
  }
  let bytes = 0;
  for (const size of paths.values()) bytes += size;
  return { paths, files: paths.size, bytes, fromChunks, migration };
}

/** A new migration folder: <ts>-migration, or <ts>-delta-migration; a later second when the name is taken. */
function newMigrationDir(opts, startedAt, delta) {
  for (let date = startedAt; ; date = new Date(date.getTime() + 1000)) {
    const candidate = path.join(outputRoot(opts), `${fileTimestamp(date)}-${delta ? 'delta-' : ''}migration`);
    if (!fs.existsSync(candidate)) return candidate;
  }
}

const regionOf = (sourceBase) => /^s3\.([a-z0-9-]+)\.amazonaws\.com$/.exec(new URL(sourceBase).hostname)?.[1] ?? '';

/** The migration the user means: --migration, or else the latest one after confirmation (--yes skips the question). */
async function resolveMigrationDir(opts, out) {
  if (opts.migration) return path.resolve(opts.migration);
  const latest = listMigrations(opts)[0];
  if (!latest) throw new UsageError(`No earlier migration found in ${outputRoot(opts)}: pass --migration <dir>, or start one with --source-bucket.`);
  out.write(`Latest migration: ${latest.dir}\n  started ${latest.startedAt}, outcome ${latest.outcome}, ${latest.chunksDone}/${latest.chunksTotal} chunk(s) done\n`);
  if (!opts.yes && !(await (opts.confirm ?? askYesNo)('Continue this migration? [y/N] '))) throw new UsageError('Cancelled.');
  return latest.dir;
}

function newChunkRunDir(dir, chunk) {
  const base = path.join(dir, 'chunks', chunkId(chunk.id));
  // Run directory names have a one second resolution; a second attempt in the same second must not reuse one.
  for (let date = new Date(); ; date = new Date(date.getTime() + 1000)) {
    const candidate = path.join(base, `${fileTimestamp(date)}-chunk`);
    if (!fs.existsSync(candidate)) return candidate;
  }
}

/** The records ({ relativePath, size, ... }) of the failed-*.jsonl files of a run directory. */
function failedRecords(runDir) {
  const files = fs.existsSync(runDir) ? fs.readdirSync(runDir).filter((f) => /^failed-.*\.jsonl$/.test(f)) : [];
  return files.flatMap((f) => fs.readFileSync(path.join(runDir, f), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)));
}

/** The relative paths in the failed-*.jsonl files of a run directory. */
const failedPaths = (runDir) => new Set(failedRecords(runDir).map((r) => r.relativePath));

// ---------------------------------------------------------------- migrate

/**
 * `migrate`: start a migration (with --source-bucket) or continue one (--migration <dir>, or the latest after
 * confirmation). Returns the exit code. With --repeat, delta migrations follow one after another until one finds at
 * most --repeat-until objects, or --repeat-max deltas ran (see runOneMigration for one round).
 *   opts.view       a migration view (see migration-view.js), for the first round
 *   opts.makeView   ({ delta, round }) => a migration view, called for each round (the wizard's dashboard)
 *   opts.baselineDir  internal: the migration a new delta is based on (see resolveDelta)
 * Test hooks: `opts.abortSignal` (acts like Ctrl+C), `opts.s3ListPage` (replaces the AWS SDK).
 */
export async function migrateCommand(opts, out = process.stdout) {
  const repeat = parseRepeat(opts);
  if (!repeat) return (await runOneMigration(opts, out)).code;
  if (!opts.dryRun) out.write(`${roundHeader(0, repeat)}\n`);
  let last = await runOneMigration({ ...opts, round: 0 }, out);
  if (opts.dryRun) {
    out.write(`  Then:    delta migrations one after another, until one finds at most ${formatCount(repeat.until)} objects (at most ${formatCount(repeat.max)} deltas)\n`);
    return last.code;
  }
  const rounds = [last];
  let ending;
  for (let deltas = 0; ; ) {
    if (last.outcome !== 'success' && last.outcome !== 'partial') ending = 'stopped';
    else if (last.m.includeAfter && last.inventoryFiles <= repeat.until) ending = 'caught-up';
    else if (deltas >= repeat.max) ending = 'max';
    if (ending) break;
    deltas++;
    out.write(`\n${roundHeader(deltas, repeat)}\n`);
    last = await runOneMigration(nextDeltaOptions(opts, last, deltas), out);
    rounds.push(last);
  }
  repeatSummaryLines({ rounds, repeat, ending }).forEach((l) => out.write(`${l}\n`));
  return last.code;
}

const roundHeader = (round, repeat) => `────── ${round === 0 ? 'Round 0: the migration' : `Round ${round}: delta ${round} of at most ${repeat.max}`}, then deltas until one finds ≤ ${formatCount(repeat.until)} objects ──────`;

/** The options of the next delta: the source, target and settings of the migration that just ended, which is its baseline. */
function nextDeltaOptions(opts, previous, round) {
  const { m, options, dir } = previous;
  return {
    ...opts,
    ...options, // inventorySource, chunkFiles, chunkBytes, parallel, maxAttempts (as the previous round ran them)
    migration: undefined,
    view: undefined,
    lastCopyDate: undefined,
    sourceBucket: m.bucket,
    sourcePrefix: m.prefix,
    sourceRegion: m.region || undefined,
    overwriteModified: m.overwriteModified,
    baselineDir: dir,
    round,
  };
}

const quoted = (s) => (/[\s"]/.test(s) ? `"${s}"` : s);

/** The summary that closes a --repeat run: one row per round, then what to do next. */
export function repeatSummaryLines({ rounds, repeat, ending }) {
  const copied = (m) => m.chunks.reduce((s, c) => s + (Number(c.copied) || 0), 0);
  const lines = [
    '',
    '============== Repeat summary ==============',
    `${'Round'.padEnd(7)}${'Folder'.padEnd(40)}${'Objects'.padStart(12)}${'Copied'.padStart(12)}   Outcome`,
    ...rounds.map((r, i) => `${(i === 0 ? (r.m.includeAfter ? 'delta' : 'full') : String(i)).padEnd(7)}${path.basename(r.dir).padEnd(40)}${formatCount(r.inventoryFiles).padStart(12)}${formatCount(copied(r.m)).padStart(12)}   ${r.outcome}`),
  ];
  const last = rounds.at(-1);
  const { m } = last;
  const cutover = `${CLI} migrate --source-bucket ${quoted(m.bucket)}${m.prefix ? ` --source-prefix ${quoted(m.prefix)}` : ''}${m.region ? ` --source-region ${m.region}` : ''} --last-copy-date auto`;
  if (ending === 'caught-up') {
    lines.push(`Caught up: the last delta found ${formatCount(last.inventoryFiles)} objects (≤ ${formatCount(repeat.until)}). Stop the writers and run one more delta for cutover:`, `  ${cutover}`);
  } else if (ending === 'max') {
    lines.push(
      `Not caught up after ${formatCount(rounds.length - 1)} delta(s): the last one found ${formatCount(last.inventoryFiles)} objects (more than ${formatCount(repeat.until)}).`,
      'The source is still changing faster than the deltas catch up. Run more deltas later, or stop the writers and run one more delta:',
      `  ${cutover}`,
    );
  } else if (last.outcome === 'interrupted') {
    lines.push(`Interrupted in round ${rounds.length - 1}. Continue it, and the deltas after it, with:`, `  ${CLI} migrate --migration "${last.dir}" --repeat${repeat.until !== REPEAT_DEFAULTS.until ? ` --repeat-until ${repeat.until}` : ''}${repeat.max !== REPEAT_DEFAULTS.max ? ` --repeat-max ${repeat.max}` : ''}`);
  } else {
    lines.push(`Round ${rounds.length - 1} ended ${last.outcome}: no more deltas were started. See its summary above.`);
  }
  return lines;
}

/**
 * One migration, started or continued: returns `{ code, outcome, dir, m, options, inventoryFiles }` (`m` is the
 * migration.json record). `opts.round` (with --repeat) is passed to `opts.makeView`.
 */
async function runOneMigration(opts, out) {
  const redactor = new Redactor();
  const stopAfter = parseStopAfter(opts.stopAfter);
  const continuing = Boolean(opts.migration) || !opts.sourceBucket;

  let dir;
  let m;
  let target;
  let options;
  if (continuing) {
    dir = await resolveMigrationDir(opts, out);
    m = readMigration(dir);
    target = readTarget(opts, redactor, out);
    if (target.base !== m.targetBase) throw new UsageError(`Target ${target.base} does not match the migration's target ${m.targetBase}.`);
    options = parseOptions({ parallel: opts.parallel, maxAttempts: opts.maxAttempts }, m.options);
  } else {
    const { bucket, prefix } = resolveSource(opts);
    target = readTarget(opts, redactor, out);
    options = parseOptions(opts);
    const startedAt = new Date();
    const sourceBase = buildSourceUrl(bucket, prefix, opts.sourceRegion);
    const destBase = buildTargetBase(target, prefix);
    const { includeAfter, baseline } = resolveDelta(opts, stateKey(sourceBase, destBase), startedAt);
    // The files the baseline migration did not copy come along, when it copied the same source to the same target.
    const from = baseline ? collectCarried(baseline.dir) : null;
    const carried = from && from.files > 0 && from.migration.sourceBase === sourceBase && from.migration.destBase === destBase
      ? { files: from.files, bytes: from.bytes, fromChunks: from.fromChunks }
      : null;
    dir = newMigrationDir(opts, startedAt, Boolean(includeAfter));
    m = {
      kind: 'migration',
      startedAt: startedAt.toISOString(),
      outcome: 'running',
      bucket,
      prefix,
      region: opts.sourceRegion ?? '',
      sourceBase,
      targetBase: target.base, // container (+ directory) without SAS or prefix
      destBase,
      includeAfter,
      baseline,
      carried,
      overwriteModified: Boolean(opts.overwriteModified),
      options,
      inventory: { status: 'pending' },
      chunking: { status: 'pending' },
      chunks: [],
    };
  }
  const stateEntry = stateKey(m.sourceBase, m.destBase); // the key of this source and target in state.json

  const inventoryFile = path.join(dir, 'inventory.jsonl');
  const summaryFile = path.join(dir, 'inventory-summary.json');
  const chunksDir = path.join(dir, 'chunks');
  const inventoryArgs = () => copyArgs({ source: m.sourceBase, dest: buildTargetUrl(target, m.prefix), includeAfter: m.includeAfter, listOnly: true }, opts);
  const chunkCopyArgs = (listFile) => copyArgs({ source: m.sourceBase, dest: buildTargetUrl(target, m.prefix), listFile, overwriteModified: m.overwriteModified }, opts);

  if (opts.dryRun) {
    printDryRun({ opts, out, redactor, m, dir, options, continuing, inventoryArgs, chunkCopyArgs, stopAfter, chunksDir });
    return { code: EXIT.OK, outcome: 'dry-run', dir, m, options, inventoryFiles: 0 };
  }
  requireAwsCredentials(redactor);

  fs.mkdirSync(dir, { recursive: true });
  const view = opts.makeView?.({ delta: Boolean(m.includeAfter), round: opts.round }) ?? opts.view ?? new PlainMigrationView(out);
  const logFile = path.join(dir, `migration-${fileTimestamp()}.log`);
  const logStream = fs.createWriteStream(logFile, { flags: 'a' });
  const log = (level, msg) => logStream.write(`${new Date().toISOString()} ${level.padEnd(5)} ${redactor.redact(msg)}\n`);
  const save = () => writeMigration(dir, m);

  const abort = new AbortController();
  opts.abortSignal?.addEventListener('abort', () => abort.abort(), { once: true });
  const onSigint = () => {
    if (abort.signal.aborted) return;
    log('WARN', 'Interrupt received - stopping the azcopy jobs...');
    view.message('WARN', 'Interrupt received - stopping the azcopy jobs...');
    abort.abort();
  };
  process.on('SIGINT', onSigint);

  const startedMs = Date.now();
  const hints = { continue: `${CLI} migrate --migration "${dir}"` };
  const finish = (outcome) => {
    m.outcome = outcome;
    if (outcome !== 'stopped') m.finishedAt = new Date().toISOString();
    save();
    const chunks = m.chunks;
    const sum = (field) => chunks.reduce((s, c) => s + (Number(c[field]) || 0), 0);
    const result = {
      outcome,
      dir,
      maxAttempts: options.maxAttempts,
      chunksTotal: chunks.length,
      chunksSuccess: chunks.filter((c) => c.status === 'success').length,
      chunksExhausted: chunks.filter((c) => c.status === 'exhausted').length,
      chunksOpen: chunks.filter((c) => !isFinished(c)).length,
      copied: sum('copied'),
      ignored: sum('ignored'),
      failed: sum('failed'),
      bytesCopied: sum('bytesCopied'),
      elapsedSeconds: Math.round((Date.now() - startedMs) / 1000),
      skipped: m.chunking.skipped ?? 0,
      skippedFile: path.join(chunksDir, 'skipped.jsonl'),
      includeAfter: m.includeAfter ?? null,
      baseline: m.baseline ?? null,
      carried: m.carried ?? null,
      files: { log: logFile, migration: migrationFile(dir) },
    };
    log('INFO', `migration ${outcome}: ${result.chunksSuccess}/${result.chunksTotal} chunk(s) copied, ${result.chunksExhausted} exhausted, ${result.chunksOpen} open; copied ${result.copied}, failed ${result.failed}`);
    view.summary(result, hints);
    return { code: EXIT_BY_OUTCOME[outcome], outcome, dir, m, options, inventoryFiles: m.inventory.files ?? 0 };
  };

  // The start of the migration is the delta baseline of the next one (see `--last-copy-date auto`). It only moves
  // forward: a migration continued after a later one ended does not take the baseline back.
  const recordBaseline = () => {
    const file = stateFile(opts);
    const existing = readState(file)[stateEntry];
    if (existing && Date.parse(existing.startedAt) > Date.parse(m.startedAt)) {
      log('INFO', `state.json kept: a later run is recorded (started ${existing.startedAt}, ${existing.runDir})`);
      return;
    }
    saveState(file, stateEntry, { startedAt: m.startedAt, runDir: dir });
  };

  try {
    view.start?.({ dir, logFile, migration: m });
    log('INFO', `${continuing ? 'continuing' : 'starting'} migration ${dir}`);
    log('INFO', `options: ${JSON.stringify(options)}`);
    for (const [label, text] of deltaLines(m)) log('INFO', `${label.toLowerCase()}: ${text}`);
    m.outcome = 'running';
    save();

    // ---- inventory
    if (m.inventory.status !== 'done') {
      const began = Date.now();
      const provider = options.inventorySource === 's3'
        ? s3Provider({ bucket: m.bucket, prefix: m.prefix, region: m.region, includeAfter: m.includeAfter, listPage: opts.s3ListPage, signal: abort.signal })
        : azcopyProvider({
          command: azcopyCommand(opts),
          args: inventoryArgs(),
          env: process.env,
          redactor,
          bucket: m.bucket,
          prefix: m.prefix,
          signal: abort.signal,
          onStderr: (line) => {
            log('STDERR', line);
            view.log?.('STDERR', redactor.redact(line));
          },
        });
      view.inventoryStarted?.({ provider: options.inventorySource === 's3' ? 'S3 ListObjectsV2' : 'azcopy dry-run', source: m.sourceBase, includeAfter: m.includeAfter });
      log('INFO', `inventory (${provider.name}) of ${m.sourceBase}${m.includeAfter ? ` modified on/after ${m.includeAfter}` : ''}`);
      try {
        const { files, bytes } = await writeInventory({ file: inventoryFile, provider, onProgress: (p) => view.inventoryProgress?.(p) });
        m.inventory = { status: 'done', files, bytes, finishedAt: new Date().toISOString(), seconds: Math.round((Date.now() - began) / 1000) };
        fs.rmSync(summaryFile, { force: true });
        log('INFO', `inventory done: ${files} objects, ${bytes} bytes`);
      } catch (e) {
        if (e instanceof InventoryAborted) return finish('interrupted');
        if (e instanceof InventoryError) {
          log('ERROR', `inventory failed: ${e.message}`);
          view.message?.('ERROR', `Inventory failed: ${redactor.redact(e.message)}`);
          return finish('failed');
        }
        throw e;
      }
      save();
    }

    // ---- analysis
    const summary = fs.existsSync(summaryFile) ? JSON.parse(fs.readFileSync(summaryFile, 'utf8')) : await analyseInventory(inventoryFile, summaryFile);
    const lines = analysisLines(summary);
    lines.forEach((l) => log('INFO', `analysis: ${l}`));
    view.analysis?.(summary, lines);
    if (stopAfter === 'inventory') return finish('stopped');

    // ---- chunking
    if (m.chunking.status !== 'done') {
      // The carried paths are collected again here: a delta continued after an interrupted inventory has only their count.
      const carried = m.carried ? collectCarried(m.baseline.dir)?.paths ?? new Map() : null;
      const { chunks, skipped, carriedInInventory } = await createChunks({ inventoryFile, chunksDir, maxFiles: options.chunkFiles, maxBytes: options.chunkBytes, dir, carried });
      m.chunks = chunks.map((c) => ({ ...c, status: 'pending', attempts: 0, runs: [], copied: 0, ignored: 0, failed: 0, bytesCopied: 0 }));
      m.chunking = { status: 'done', chunks: chunks.length, skipped };
      if (m.carried) Object.assign(m.carried, { chunks: chunks.filter((c) => c.carried).length, inInventory: carriedInInventory });
      save();
      log('INFO', `chunking done: ${chunks.length} chunk(s), ${skipped} skipped key(s)${m.carried ? `; ${m.carried.chunks} carried-over chunk(s), ${carriedInInventory} carried file(s) left to the inventory chunks` : ''}`);
      view.chunking?.({ chunks, skipped, maxFiles: options.chunkFiles, maxBytes: options.chunkBytes, chunksDir });
    }
    if (stopAfter === 'chunk') return finish('stopped');

    // ---- nothing to copy (a delta with no modified object, or an empty source)
    if (m.chunks.length === 0) {
      const text = m.includeAfter
        ? `Nothing was modified on/after ${m.includeAfter}${m.carried ? '' : ' and nothing is carried over'}: no chunk to copy.`
        : 'The inventory is empty: no chunk to copy.';
      log('INFO', text);
      view.message?.('INFO', text);
      recordBaseline();
      return finish('success');
    }

    // ---- copying
    for (const c of m.chunks) {
      if (c.status === 'exhausted') Object.assign(c, { status: c.lastOutcome ?? 'failed', attempts: 0 }); // a new run tries them again
      else if (c.status === 'running') c.status = 'interrupted'; // the process died while it ran
    }
    save();
    const queue = m.chunks.filter((c) => c.status !== 'success');
    const progress = new MigrationProgress({ chunks: m.chunks, totalBytes: m.chunks.reduce((s, c) => s + c.bytes, 0) });
    let lastLog = 0;
    const changed = () => {
      const snapshot = progress.snapshot();
      const periodic = Date.now() - lastLog >= LOG_INTERVAL_MS;
      if (periodic) {
        lastLog = Date.now();
        log('STATS', formatAggregate(snapshot));
      }
      view.progress?.(snapshot, { periodic });
    };
    view.copyStarted?.({ chunks: queue.length, total: m.chunks.length, parallel: options.parallel });
    log('INFO', `copying ${queue.length} of ${m.chunks.length} chunk(s), ${options.parallel} at a time`);

    const runChunk = async (chunk) => {
      const began = Date.now();
      view.chunkStarted?.(chunk.id);
      log('INFO', `chunk ${chunkId(chunk.id)} started (status ${chunk.status}, attempts ${chunk.attempts})`);
      while (!abort.signal.aborted) {
        const lastRun = chunk.runs.at(-1);
        const lastManifest = lastRun ? safeManifest(path.join(dir, lastRun)) : null;
        let action = 'copy';
        if (chunk.status === 'partial') action = 'retry';
        else if ((chunk.status === 'interrupted' || chunk.status === 'failed') && lastManifest?.jobId && !(chunk.status === 'failed' && chunk.lastAction === 'resume')) action = 'resume';

        let runDir;
        let manifest;
        let args;
        let prepare;
        if (action === 'retry') {
          const paths = failedPaths(path.join(dir, lastRun));
          if (paths.size === 0) {
            chunk.status = 'success'; // nothing is recorded as failed: there is nothing to retry
            chunk.failed = 0;
            break;
          }
          runDir = newChunkRunDir(dir, chunk);
          const listFile = path.join(runDir, 'retry-input.txt');
          args = chunkCopyArgs(listFile);
          prepare = () => fs.writeFileSync(listFile, `${[...paths].join('\n')}\n`);
        } else if (action === 'copy') {
          runDir = newChunkRunDir(dir, chunk);
          args = chunkCopyArgs(path.join(dir, chunk.list));
        }
        if (action === 'resume') {
          runDir = path.join(dir, lastRun);
          manifest = lastManifest;
          // Job plans never store the SAS, so it is supplied again.
          args = ['jobs', 'resume', manifest.jobId, '--destination-sas', `?${target.query}`, ...azcopyFlags(opts)];
        } else {
          const stamp = path.basename(runDir);
          manifest = {
            kind: 'chunk',
            ...runPaths({ ...opts, planDir: opts.planDir ? path.join(opts.planDir, `${chunkId(chunk.id)}-${stamp}`) : undefined }, runDir),
            startedAt: new Date().toISOString(),
            bucket: m.bucket,
            prefix: m.prefix,
            sourceBase: m.sourceBase,
            targetBase: m.targetBase,
            destBase: m.destBase,
            includeAfter: null, // the list already names exactly the files to copy
            overwriteModified: m.overwriteModified,
            jobId: null,
            migration: dir,
            chunk: chunk.id,
          };
          chunk.runs.push(path.relative(dir, runDir).split(path.sep).join('/'));
        }
        chunk.status = 'running';
        chunk.attempts++;
        chunk.lastAction = action;
        save();
        log('INFO', `chunk ${chunkId(chunk.id)} attempt ${chunk.attempts}/${options.maxAttempts}: ${action} in ${path.relative(dir, runDir)}`);

        const view_ = new ChunkView({ id: chunk.id, progress, view, changed });
        const report = await execute({ opts: { ...opts, view: view_ }, out, redactor, manifest: { ...manifest, attempt: chunk.attempts }, args, prepare, signal: abort.signal });
        progress.clear(chunk.id);

        // azcopy ends a job as `Failed` (not CompletedWithErrors) when every transfer in it failed. On a retry pass that is the
        // files that keep failing, after an earlier attempt copied the rest: still partial, so the failed files are
        // retried or carried, and not the whole chunk. (A `Cancelled` job stays failed: its counters cannot be trusted.)
        let outcome = report.outcome;
        if (action === 'retry' && outcome === 'failed' && report.jobStatus === 'Failed' && report.failed > 0 && report.files.failed) outcome = 'partial';

        if (outcome === 'success' || outcome === 'partial') {
          // Only an attempt that ended adds its numbers: an interrupted or failed job is continued or repeated later.
          chunk.copied += report.copied;
          chunk.ignored += report.ignored;
          chunk.bytesCopied += report.bytesCopied;
          chunk.failed = report.failed;
        }
        chunk.status = outcome;
        log('INFO', `chunk ${chunkId(chunk.id)} attempt ${chunk.attempts}: ${outcome} (copied ${report.copied}, failed ${report.failed}, ignored ${report.ignored})`);
        if (outcome === 'success') {
          chunk.failed = 0;
          break;
        }
        if (outcome === 'interrupted') break;
        if (chunk.attempts >= options.maxAttempts) {
          chunk.lastOutcome = chunk.status;
          chunk.status = 'exhausted';
          break;
        }
      }
      if (chunk.status === 'running') chunk.status = 'interrupted'; // aborted before the next attempt started
      chunk.seconds = Math.round((Date.now() - began) / 1000);
      save();
      view.chunkEnded?.(chunk);
      changed();
    };

    let fatal = null;
    const worker = async () => {
      while (!abort.signal.aborted && queue.length > 0) {
        try {
          await runChunk(queue.shift());
        } catch (e) {
          fatal ??= e;
          abort.abort(); // the other jobs stop and can be continued
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(options.parallel, queue.length) }, worker));
    for (const c of m.chunks) if (c.status === 'running') c.status = 'interrupted';
    save();
    if (fatal) throw fatal;

    if (abort.signal.aborted) return finish('interrupted');
    const exhausted = m.chunks.filter((c) => c.status === 'exhausted');
    const outcome = exhausted.length === 0 ? 'success' : m.chunks.every((c) => c.status === 'exhausted' && c.lastOutcome === 'failed') ? 'failed' : 'partial';
    // The start of the inventory is the delta baseline: objects written later are not in any chunk (see `--last-copy-date auto`).
    if (outcome === 'success' || outcome === 'partial') recordBaseline();
    return finish(outcome);
  } finally {
    process.off('SIGINT', onSigint);
    view.close?.();
    logStream.end();
    await new Promise((resolve) => logStream.once('close', resolve));
  }
}

function safeManifest(runDir) {
  try {
    return readManifest(runDir);
  } catch {
    return null;
  }
}

function printDryRun({ opts, out, redactor, m, dir, options, continuing, inventoryArgs, chunkCopyArgs, stopAfter, chunksDir }) {
  const command = azcopyCommand(opts);
  const show = (args) => redactor.redact([command.bin, ...args].join(' '));
  if (continuing) {
    const left = m.chunks.filter((c) => c.status !== 'success').length;
    out.write(`\nDry run - would continue migration ${dir}\n  inventory ${m.inventory.status}, chunking ${m.chunking.status}, ${left} of ${m.chunks.length} chunk(s) to copy, ${options.parallel} at a time\n`);
    return;
  }
  const first = path.join(chunksDir, `${chunkId(1)}.txt`);
  out.write(
    `\nDry run - would run a migration (nothing is created):\n` +
      `  Source:  ${m.sourceBase}\n  Target:  ${m.destBase}\n` +
      `  Mode:    ${m.includeAfter ? `delta (objects modified on/after ${m.includeAfter})` : 'full (everything not already at the target)'}\n` +
      deltaLines(m).slice(m.baseline ? 0 : 1).map(([label, text]) => `  ${`${label}:`.padEnd(9)}${text}\n`).join('') +
      `  Folder:  ${dir}\n` +
      `  1. Inventory (${options.inventorySource === 's3' ? 'S3 ListObjectsV2, 1,000 keys per page' : 'azcopy dry-run'}), analysis${options.inventorySource === 's3' ? '' : `:\n       ${show(inventoryArgs())}`}\n` +
      `  2. Chunks of at most ${formatCount(options.chunkFiles)} objects or ${formatBytes(options.chunkBytes)}, lists in ${chunksDir}\n` +
      `  3. Copy the chunks with ${options.parallel} azcopy jobs at once (up to ${options.maxAttempts} attempts each), for example:\n       ${show(chunkCopyArgs(first))}\n` +
      `${stopAfter ? `  Stops after the ${stopAfter}.\n` : ''}`,
  );
}
