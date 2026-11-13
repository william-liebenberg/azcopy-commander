import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { buildSourceUrl, buildTargetBase, Redactor } from './urls.js';
import { parseLastCopyDate, toUtcSeconds } from './dates.js';
import { EXIT, UsageError } from './errors.js';
import { readState, saveState, stateKey } from './state.js';
import { fileTimestamp, formatBytes, formatCount } from './format.js';
import { askYesNo, deltaDateFor, outputRoot, readTarget, requireAwsCredentials, resolveLastCopyDate, resolveSource, stateFile } from './commands.js';
import { analyseInventory, analysisLines, InventoryAborted, InventoryError, s3Provider } from './inventory.js';
import { ChunkWriter, chunkId, parseCount, parseSize, readChunkRecords, writeCarriedChunks } from './chunks.js';
import { containerFor, copyChunk, createCopier, DEFAULT_BLOCK_SIZE, targetDirectory } from './blob-copy.js';
import { withS3 } from './s3.js';
import { writeFileAtomic } from './files.js';
import { ChunkView, deltaLines, formatAggregate, isFinished, MigrationProgress, PlainMigrationView } from './migration-view.js';

/*
 * `migrate`: a large migration, recorded in a migration folder so it can be stopped and continued.
 *
 * The listing and the copy run together. S3 ListObjectsV2 pages are written into chunk files (chunks/00001.jsonl, ...)
 * as they come; each closed chunk goes to a queue that a pool of --parallel chunk workers copies, --concurrency objects
 * at once (see blob-copy.js). When the listing ends, the analysis (inventory-summary.json) is computed from the chunks.
 *
 * migration.json (`format: 2`) is the record: the options, the state of the listing (`inventory`: status, `resumeAfter`
 * the last key of the last closed chunk, counts, the size of skipped.jsonl) and one entry per chunk
 * ({ id, list, files, bytes, status, attempts, runs, copied, ignored, missing, failed, bytesCopied, carried? }).
 * A migration continued lists again from `resumeAfter` (S3 lists keys in order), after deleting the open chunk.
 *
 * A delta migration (`includeAfter` set, folder <ts>-delta-migration) lists only the objects modified on/after a
 * date. Its `baseline` ({ startedAt, dir } or null) is the migration or run the date came from; when that is a
 * migration, the files it did not copy are `carried` into the delta as its first chunk(s) (see collectCarried).
 * Chunk status: pending, running, success, partial (some files failed), failed, interrupted, exhausted (out of attempts).
 * No secret is ever written to it, to the logs or to the lists: the SAS and the AWS keys stay in memory.
 */

const CLI = 'azcopy-commander';
export const FORMAT = 2;
export const MIGRATION_DEFAULTS = { chunkFiles: 100_000, chunkBytes: 2 ** 40, chunkMinutes: 15, parallel: 4, concurrency: 32, blockSize: DEFAULT_BLOCK_SIZE, maxAttempts: 5 };
const LOG_INTERVAL_MS = 30_000;
const PROGRESS_INTERVAL_MS = 250;
const MIGRATION_DIR_RE = /^\d{8}T\d{6}Z-(delta-)?migration$/;
export const REPEAT_DEFAULTS = { until: 10_000, max: 10 };
const EXIT_BY_OUTCOME = { success: EXIT.OK, partial: EXIT.PARTIAL, failed: EXIT.FAILED, interrupted: EXIT.INTERRUPTED, stopped: EXIT.OK };
const STOP_AFTER = ['inventory'];

// ---------------------------------------------------------------- the migration folder

export const migrationFile = (dir) => path.join(dir, 'migration.json');

export function readMigration(dir) {
  const file = migrationFile(dir);
  if (!fs.existsSync(file)) throw new UsageError(`${file} not found: --migration must be a migration folder created by \`${CLI} migrate\`.`);
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

/** Write + rename, so a crash never leaves a half-written migration.json. */
export function writeMigration(dir, migration) {
  writeFileAtomic(migrationFile(dir), `${JSON.stringify(migration, null, 2)}\n`);
}

const phaseOf = (m) => (m.inventory.status !== 'done' ? 'inventory' : m.chunking && m.chunking.status !== 'done' ? 'chunking' : m.chunks.every(isFinished) ? 'done' : 'copying');

/**
 * The migrations in the output directory, newest first:
 * `{ dir, startedAt, format, outcome, phase, mode, includeAfter, chunksDone, chunksTotal, bucket, prefix, region, targetBase, overwriteModified }`.
 * `format` is 2, or 1 for a migration made with azcopy (not continued). `phase` is inventory (the listing, with the
 * copy of the chunks closed so far), chunking (format 1), copying or done; `mode` is full or delta. Folders without a migration.json are not migrations.
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
        format: m.format ?? 1,
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
  const pick = (key, flag, parse) => (opts[key] === undefined ? base[key] ?? MIGRATION_DEFAULTS[key] : parse(opts[key], flag));
  return {
    chunkFiles: pick('chunkFiles', '--chunk-files', parseCount),
    chunkBytes: pick('chunkBytes', '--chunk-bytes', parseSize),
    chunkMinutes: pick('chunkMinutes', '--chunk-minutes', parseCount),
    parallel: pick('parallel', '--parallel', parseCount),
    concurrency: pick('concurrency', '--concurrency', parseCount),
    blockSize: pick('blockSize', '--block-size', parseSize),
    maxAttempts: pick('maxAttempts', '--max-attempts', parseCount),
  };
}

function parseStopAfter(value) {
  if (value !== undefined && !STOP_AFTER.includes(value)) throw new UsageError(`Invalid --stop-after "${value}": use ${STOP_AFTER.join(' or ')} (list into chunks and analyse, copy nothing).`);
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
    return { includeAfter: toUtcSeconds(date), baseline: { startedAt: b.startedAt, dir } };
  }
  if (!opts.lastCopyDate) return { includeAfter: null, baseline: null };
  const includeAfter = toUtcSeconds(resolveLastCopyDate(opts.lastCopyDate, { opts, key, now }));
  if (opts.lastCopyDate !== 'auto') return { includeAfter, baseline: null };
  const previous = readState(stateFile(opts))[key];
  return { includeAfter, baseline: { startedAt: previous.startedAt, dir: previous.runDir } };
}

/**
 * What a baseline migration did not copy, for a delta: `{ paths: Map(path -> size), files, bytes, fromChunks, migration }`,
 * or null when `baselineDir` is not a migration folder (a copy run). Only its exhausted chunks count:
 *   last outcome partial   the paths in the failed-*.jsonl of the chunk's last run, with their sizes
 *   last outcome failed    the whole chunk list (what it did copy is ignored, since copying is append-only); a list of
 *                          paths (format 1) has no sizes, so the chunk's bytes are spread over it
 * Both formats are read: the chunks of a migration made with azcopy are lists of paths (.txt), the others JSON lines.
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
      const records = c.list ? readChunkRecords(path.join(baselineDir, c.list)) : [];
      const each = records.length > 0 ? Math.round((Number(c.bytes) || 0) / records.length) : 0;
      for (const r of records) paths.set(r.path, r.size === undefined ? each : Number(r.size) || 0);
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
 * Test hooks: `opts.abortSignal` (acts like Ctrl+C), `opts.s3` (replaces S3 calls, see src/s3.js), `opts.container` (the
 * target container), `opts.now` (the clock of --chunk-minutes).
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
    ...options, // chunkFiles, chunkBytes, chunkMinutes, parallel, concurrency, blockSize, maxAttempts (as the previous round ran them)
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

/** A chunk entry of migration.json for a chunk just written. */
const newEntry = (chunk) => ({ ...chunk, status: 'pending', attempts: 0, runs: [], copied: 0, ignored: 0, missing: 0, failed: 0, bytesCopied: 0 });

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
    if (m.format !== FORMAT) {
      throw new UsageError(`${dir} was made by an earlier version of ${CLI} (with azcopy) and cannot be continued. Start a new migration; this one still works as the baseline of a delta (--last-copy-date auto).`);
    }
    target = readTarget(opts, redactor, out);
    if (target.base !== m.targetBase) throw new UsageError(`Target ${target.base} does not match the migration's target ${m.targetBase}.`);
    options = parseOptions({ parallel: opts.parallel, concurrency: opts.concurrency, maxAttempts: opts.maxAttempts }, m.options);
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
      format: FORMAT,
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
      inventory: { status: 'pending', resumeAfter: null, files: 0, bytes: 0, skipped: 0, archived: 0, skippedFileBytes: 0 },
      chunks: [],
    };
  }
  m.options = options;
  const stateEntry = stateKey(m.sourceBase, m.destBase); // the key of this source and target in state.json
  const summaryFile = path.join(dir, 'inventory-summary.json');
  const chunksDir = path.join(dir, 'chunks');

  if (opts.dryRun) {
    printDryRun({ out, m, dir, options, continuing, stopAfter });
    return { code: EXIT.OK, outcome: 'dry-run', dir, m, options, inventoryFiles: 0 };
  }
  requireAwsCredentials(redactor);
  const s3 = await withS3(opts, { bucket: m.bucket, region: m.region || undefined, maxSockets: options.parallel * options.concurrency + 8 }, stopAfter ? ['listPage'] : undefined);
  const { container, directory } = stopAfter ? {} : opts.container ? { container: opts.container, directory: targetDirectory(target) } : await containerFor(target);

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
    log('WARN', 'Interrupt received - stopping the listing and the copies...');
    view.message('WARN', 'Interrupt received - stopping the listing and the copies...');
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
      missing: sum('missing'),
      failed: sum('failed'),
      bytesCopied: sum('bytesCopied'),
      elapsedSeconds: Math.round((Date.now() - startedMs) / 1000),
      skipped: m.inventory.skipped ?? 0,
      archived: m.inventory.archived ?? 0,
      skippedFile: path.join(chunksDir, 'skipped.jsonl'),
      includeAfter: m.includeAfter ?? null,
      baseline: m.baseline ?? null,
      carried: m.carried ?? null,
      files: { log: logFile, migration: migrationFile(dir) },
    };
    log('INFO', `migration ${outcome}: ${result.chunksSuccess}/${result.chunksTotal} chunk(s) copied, ${result.chunksExhausted} exhausted, ${result.chunksOpen} open; copied ${result.copied}, ignored ${result.ignored}, missing ${result.missing}, failed ${result.failed}`);
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
    if (s3.region) log('INFO', `source region: ${s3.region}`);
    for (const [label, text] of deltaLines(m)) log('INFO', `${label.toLowerCase()}: ${text}`);
    m.outcome = 'running';
    for (const c of m.chunks) {
      if (c.status === 'exhausted') Object.assign(c, { status: c.lastOutcome ?? 'failed', attempts: 0 }); // a new run tries them again
      else if (c.status === 'running') c.status = 'interrupted'; // the process died while it ran
    }
    // ---- the carried files of a delta: the first chunks, written before the listing starts
    if (m.carried && m.carried.chunks === undefined) {
      const paths = collectCarried(m.baseline.dir)?.paths ?? new Map();
      const chunks = writeCarriedChunks({ carried: paths, chunksDir, maxFiles: options.chunkFiles, dir });
      m.chunks = chunks.map(newEntry);
      m.carried.chunks = chunks.length;
      log('INFO', `${chunks.length} carried-over chunk(s), ${paths.size} file(s)`);
    }
    save();

    const inv = m.inventory;
    const progress = new MigrationProgress({ chunks: m.chunks });
    let lastLog = 0;
    let lastShown = 0;
    const changed = ({ force = false } = {}) => {
      const now = Date.now();
      const periodic = now - lastLog >= LOG_INTERVAL_MS;
      if (!force && !periodic && now - lastShown < PROGRESS_INTERVAL_MS) return;
      lastShown = now;
      const snapshot = progress.snapshot();
      if (periodic) {
        lastLog = now;
        log('STATS', formatAggregate(snapshot));
      }
      view.progress?.(snapshot, { periodic });
    };

    // ---- the queue of chunks to copy, and the wake-up of the workers that wait for one
    const queue = stopAfter ? [] : m.chunks.filter((c) => !isFinished(c));
    const waiters = [];
    const wake = () => waiters.splice(0).forEach((resolve) => resolve());
    abort.signal.addEventListener('abort', wake, { once: true });
    let listingRuns = inv.status !== 'done';
    let listingFailed = false;
    let fatal = null;
    const fail = (e) => {
      fatal ??= e;
      abort.abort(); // everything stops and can be continued
    };

    // ---- the listing, into chunks
    const listing = async () => {
      const exclude = new Set(m.chunks.filter((c) => c.carried).flatMap((c) => readChunkRecords(path.join(dir, c.list)).map((r) => r.path)));
      const base = { files: inv.files ?? 0, bytes: inv.bytes ?? 0, skipped: inv.skipped ?? 0, archived: inv.archived ?? 0, excluded: inv.excluded ?? 0 };
      const writer = new ChunkWriter({
        chunksDir,
        dir,
        maxFiles: options.chunkFiles,
        maxBytes: options.chunkBytes,
        maxAgeMs: options.chunkMinutes * 60_000,
        now: opts.now ?? Date.now,
        nextId: m.chunks.reduce((max, c) => Math.max(max, c.id), 0) + 1,
        skippedBytes: inv.skippedFileBytes ?? 0,
        exclude,
        onClosed: async (chunk, resumeAfter) => {
          const entry = newEntry(chunk);
          m.chunks.push(entry);
          Object.assign(inv, {
            resumeAfter,
            files: base.files + writer.files,
            bytes: base.bytes + writer.bytes,
            skipped: base.skipped + writer.skipped,
            archived: base.archived + writer.archived,
            excluded: base.excluded + writer.excluded,
            skippedFileBytes: writer.skippedBytes,
          });
          save(); // with resumeAfter: a continued listing starts after this chunk
          log('INFO', `chunk ${chunkId(chunk.id)} closed: ${chunk.files} objects, ${chunk.bytes} bytes`);
          view.chunkClosed?.(entry);
          if (!stopAfter) queue.push(entry);
          wake();
          changed({ force: true });
        },
      }).open();
      const began = Date.now();
      inv.status = 'running';
      save();
      progress.listing = { files: inv.files };
      view.inventoryStarted?.({ provider: 'S3 ListObjectsV2', source: m.sourceBase, includeAfter: m.includeAfter, resumeAfter: inv.resumeAfter });
      log('INFO', `listing ${m.sourceBase}${m.includeAfter ? ` modified on/after ${m.includeAfter}` : ''}${inv.resumeAfter ? ' after the last closed chunk' : ''}`);
      const maxAgeMs = options.chunkMinutes * 60_000;
      const timer = setInterval(() => writer.closeIfOld().catch(fail), Math.max(1000, Math.min(60_000, maxAgeMs / 4)));
      timer.unref?.();
      let lastProgress = 0;
      const provider = s3Provider({
        bucket: m.bucket,
        prefix: m.prefix,
        includeAfter: m.includeAfter,
        listPage: s3.listPage,
        signal: abort.signal,
        startAfter: inv.resumeAfter ?? undefined,
        onPage: () => writer.closeIfOld(),
      });
      try {
        await provider.list(async (record) => {
          await writer.add(record);
          progress.listing.files = base.files + writer.files;
          if (Date.now() - lastProgress >= PROGRESS_INTERVAL_MS) {
            lastProgress = Date.now();
            view.inventoryProgress?.({ files: base.files + writer.files, bytes: base.bytes + writer.bytes, chunks: m.chunks.length });
            changed();
          }
        });
        await writer.end();
        Object.assign(inv, { status: 'done', finishedAt: new Date().toISOString(), seconds: (inv.seconds ?? 0) + Math.round((Date.now() - began) / 1000) });
        delete inv.error;
        if (m.carried) m.carried.inListing = inv.excluded ?? 0;
        save();
        log('INFO', `listing done: ${inv.files} objects, ${inv.bytes} bytes, ${m.chunks.length} chunk(s), ${inv.skipped} skipped key(s)`);
        fs.rmSync(summaryFile, { force: true });
        view.chunking?.({ chunks: m.chunks, skipped: inv.skipped, archived: inv.archived, maxFiles: options.chunkFiles, maxBytes: options.chunkBytes, chunksDir });
      } catch (e) {
        await writer.abandon();
        if (e instanceof InventoryAborted) return;
        if (e instanceof InventoryError) {
          listingFailed = true;
          inv.status = 'failed';
          inv.error = redactor.redact(e.message);
          save();
          log('ERROR', `listing failed: ${e.message}`);
          view.message?.('ERROR', `Listing failed: ${redactor.redact(e.message)}. The closed chunks are copied; continue the migration to list again from the last closed chunk.`);
          return;
        }
        throw e;
      } finally {
        clearInterval(timer);
        progress.listing = null;
        listingRuns = false;
        wake();
      }
    };

    const showAnalysis = async () => {
      const files = [...m.chunks.filter((c) => !c.carried).map((c) => path.join(dir, c.list)), path.join(chunksDir, 'skipped.jsonl')];
      const summary = fs.existsSync(summaryFile) ? JSON.parse(fs.readFileSync(summaryFile, 'utf8')) : await analyseInventory(files, summaryFile);
      const lines = analysisLines(summary);
      lines.forEach((l) => log('INFO', `analysis: ${l}`));
      view.analysis?.(summary, lines);
    };

    // ---- the copy of one chunk, attempt after attempt
    const copier = stopAfter ? null : createCopier({ s3, container, directory, prefix: m.prefix, blockSize: options.blockSize, overwriteModified: m.overwriteModified });
    const runChunk = async (chunk) => {
      const began = Date.now();
      view.chunkStarted?.(chunk.id);
      log('INFO', `chunk ${chunkId(chunk.id)} started (status ${chunk.status}, attempts ${chunk.attempts})`);
      while (!abort.signal.aborted) {
        let records = readChunkRecords(path.join(dir, chunk.list));
        let action = 'copy';
        const lastRun = chunk.runs.at(-1);
        if (chunk.status === 'partial' && lastRun) {
          const paths = failedPaths(path.join(dir, lastRun));
          if (paths.size === 0) {
            chunk.status = 'success'; // nothing is recorded as failed: there is nothing to retry
            chunk.failed = 0;
            break;
          }
          records = records.filter((r) => paths.has(r.path));
          action = 'retry';
        }
        const runDir = newChunkRunDir(dir, chunk);
        chunk.runs.push(path.relative(dir, runDir).split(path.sep).join('/'));
        chunk.status = 'running';
        chunk.attempts++;
        chunk.lastAction = action;
        save();
        log('INFO', `chunk ${chunkId(chunk.id)} attempt ${chunk.attempts}/${options.maxAttempts}: ${action} of ${records.length} object(s) in ${path.relative(dir, runDir)}`);

        const chunkView = new ChunkView({ id: chunk.id, progress, view, changed });
        const report = await copyChunk({
          records,
          concurrency: options.concurrency,
          signal: abort.signal,
          copy: copier,
          runDir,
          manifest: { kind: 'chunk', migration: dir, chunk: chunk.id, attempt: chunk.attempts, action, bucket: m.bucket, prefix: m.prefix, sourceBase: m.sourceBase, targetBase: m.targetBase, destBase: m.destBase, overwriteModified: m.overwriteModified },
          sourceBase: m.sourceBase,
          destBase: m.destBase,
          onProgress: (snapshot) => chunkView.progress(snapshot),
          onFailure: (relativePath, code) => chunkView.failure(relativePath, code),
          redact: (text) => redactor.redact(text),
        });
        progress.clear(chunk.id);
        const outcome = report.outcome;
        // What was copied counts in every case. An interrupted attempt is repeated whole: its other numbers come again.
        chunk.copied += report.copied;
        chunk.bytesCopied += report.bytesCopied;
        if (outcome !== 'interrupted') {
          chunk.ignored += report.ignored;
          chunk.missing = (chunk.missing ?? 0) + report.missing;
          chunk.failed = report.failed;
        }
        chunk.status = outcome;
        log('INFO', `chunk ${chunkId(chunk.id)} attempt ${chunk.attempts}: ${outcome} (copied ${report.copied}, ignored ${report.ignored}, missing ${report.missing}, failed ${report.failed})`);
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
      chunk.seconds = (chunk.seconds ?? 0) + Math.round((Date.now() - began) / 1000);
      save();
      view.chunkEnded?.(chunk);
      changed({ force: true });
    };

    const worker = async () => {
      while (!abort.signal.aborted) {
        const chunk = queue.shift();
        if (chunk) {
          try {
            await runChunk(chunk);
          } catch (e) {
            fail(e);
          }
        } else if (listingRuns) {
          await new Promise((resolve) => waiters.push(resolve));
        } else return;
      }
    };

    if (!stopAfter) {
      view.copyStarted?.({ chunks: queue.length, parallel: options.parallel, concurrency: options.concurrency });
      log('INFO', `copying as the chunks close: ${queue.length} ready, ${options.parallel} chunk(s) at a time, ${options.concurrency} object(s) at once in each`);
    }
    const listed = listingRuns ? listing().catch(fail) : Promise.resolve();
    await Promise.all([listed, ...(stopAfter ? [] : Array.from({ length: options.parallel }, worker))]);
    for (const c of m.chunks) if (c.status === 'running') c.status = 'interrupted';
    save();
    if (fatal) throw fatal;
    if (abort.signal.aborted) return finish('interrupted');
    if (listingFailed) return finish('failed');
    await showAnalysis();
    if (stopAfter === 'inventory') return finish('stopped');

    // ---- nothing to copy (a delta with no modified object, or an empty source)
    if (m.chunks.length === 0) {
      const text = m.includeAfter
        ? `Nothing was modified on/after ${m.includeAfter}${m.carried ? '' : ' and nothing is carried over'}: no chunk to copy.`
        : 'The source is empty: no chunk to copy.';
      log('INFO', text);
      view.message?.('INFO', text);
      recordBaseline();
      return finish('success');
    }
    const exhausted = m.chunks.filter((c) => c.status === 'exhausted');
    const outcome = exhausted.length === 0 ? 'success' : m.chunks.every((c) => c.status === 'exhausted' && c.lastOutcome === 'failed') ? 'failed' : 'partial';
    // The start of the migration is the delta baseline: objects written later are not in any chunk (see `--last-copy-date auto`).
    if (outcome === 'success' || outcome === 'partial') recordBaseline();
    return finish(outcome);
  } finally {
    process.off('SIGINT', onSigint);
    view.close?.();
    logStream.end();
    await new Promise((resolve) => logStream.once('close', resolve));
    s3.destroy?.();
  }
}

function printDryRun({ out, m, dir, options, continuing, stopAfter }) {
  if (continuing) {
    const left = m.chunks.filter((c) => !isFinished(c)).length;
    const listing = m.inventory.status === 'done' ? 'done' : m.inventory.resumeAfter ? 'continued after the last closed chunk' : 'started again';
    out.write(`\nDry run - would continue migration ${dir}\n  listing ${listing}, ${left} of ${m.chunks.length} chunk(s) to copy, ${options.parallel} at a time, ${options.concurrency} object(s) at once in each\n`);
    return;
  }
  out.write(
    `\nDry run - would run a migration (nothing is created):\n` +
      `  Source:  ${m.sourceBase}\n  Target:  ${m.destBase}\n` +
      `  Mode:    ${m.includeAfter ? `delta (objects modified on/after ${m.includeAfter})` : 'full (everything not already at the target)'}${m.overwriteModified ? ', blobs older than their object are written again' : ', append-only'}\n` +
      deltaLines(m).slice(m.baseline ? 0 : 1).map(([label, text]) => `  ${`${label}:`.padEnd(9)}${text}\n`).join('') +
      `  Folder:  ${dir}\n` +
      `  1. List the source (S3 ListObjectsV2, 1,000 keys per page) into chunks of at most ${formatCount(options.chunkFiles)} objects or ${formatBytes(options.chunkBytes)}, closed after ${formatCount(options.chunkMinutes)} minute(s) at most\n` +
      (stopAfter
        ? '  2. Analyse the listing. Stops there: nothing is copied.\n'
        : `  2. Copy each chunk as it closes: ${options.parallel} chunk(s) at once, ${options.concurrency} object(s) at once in each, up to ${options.maxAttempts} attempts per chunk\n` +
          `     (Put Blob From URL from a presigned S3 URL; in blocks above ${formatBytes(options.blockSize)})\n` +
          '  3. Analyse the listing when it ends\n'),
  );
}
