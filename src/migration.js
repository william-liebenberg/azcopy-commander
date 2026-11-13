import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { buildSourceUrl, buildTargetBase, buildTargetUrl, Redactor } from './urls.js';
import { toAzcopyDate } from './dates.js';
import { EXIT } from './job.js';
import { saveState, stateKey } from './state.js';
import { fileTimestamp, formatBytes, formatCount } from './format.js';
import { UsageError } from './errors.js';
import {
  askYesNo, azcopyCommand, azcopyFlags, copyArgs, execute, outputRoot, readManifest, readTarget, requireAwsCredentials,
  resolveLastCopyDate, resolveSource, runPaths, stateFile,
} from './commands.js';
import { analyseInventory, analysisLines, azcopyProvider, InventoryAborted, InventoryError, s3Provider, writeInventory } from './inventory.js';
import { chunkId, createChunks, parseCount, parseSize } from './chunks.js';
import { ChunkView, formatAggregate, isFinished, MigrationProgress, PlainMigrationView } from './migration-view.js';

/*
 * `migrate`: a large migration in phases, recorded in a migration folder so it can be stopped and continued.
 *
 *   inventory  the source is listed into inventory.jsonl           (azcopy dry-run, or S3 ListObjectsV2)
 *   analysis   inventory-summary.json                              (counts, sizes, prefixes)
 *   chunking   chunks/00001.txt ...                                (lists for azcopy --list-of-files)
 *   copying    a pool of --parallel azcopy jobs, chunks in order   (each chunk is an ordinary run directory)
 *
 * migration.json is the record: the options, the state of each phase and one entry per chunk
 * ({ id, list, files, bytes, status, attempts, runs, copied, ignored, failed, bytesCopied }).
 * Chunk status: pending, running, success, partial (some files failed), failed, interrupted, exhausted (out of attempts).
 * No secret is ever written to it, to the logs or to the lists: the SAS and the AWS keys stay in memory.
 */

const CLI = 'azcopy-commander';
export const MIGRATION_DEFAULTS = { inventorySource: 'azcopy', chunkFiles: 1_000_000, chunkBytes: 2 ** 40, parallel: 10, maxAttempts: 5 };
const LOG_INTERVAL_MS = 30_000;
const MIGRATION_DIR_RE = /^\d{8}T\d{6}Z-migration$/;
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
 * `{ dir, startedAt, outcome, phase, chunksDone, chunksTotal, bucket, prefix, region, targetBase, overwriteModified }`.
 * `phase` is inventory, chunking, copying or done. Folders without a migration.json are not migrations.
 */
export function listMigrations(opts = {}) {
  const root = outputRoot(opts);
  const names = fs.existsSync(root) ? fs.readdirSync(root) : [];
  return names
    .filter((n) => MIGRATION_DIR_RE.test(n))
    .sort()
    .reverse()
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
        chunksDone: m.chunks.filter(isFinished).length,
        chunksTotal: m.chunks.length,
        bucket: m.bucket,
        prefix: m.prefix ?? '',
        region: m.region ?? '',
        targetBase: m.targetBase,
        overwriteModified: Boolean(m.overwriteModified),
      }];
    });
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

/** The relative paths in the failed-*.jsonl files of a run directory. */
function failedPaths(runDir) {
  const files = fs.existsSync(runDir) ? fs.readdirSync(runDir).filter((f) => /^failed-.*\.jsonl$/.test(f)) : [];
  return new Set(files.flatMap((f) => fs.readFileSync(path.join(runDir, f), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l).relativePath)));
}

// ---------------------------------------------------------------- migrate

/**
 * `migrate`: start a migration (with --source-bucket) or continue one (--migration <dir>, or the latest after
 * confirmation). Returns the exit code. `opts.view` is a migration view (see migration-view.js).
 * Test hooks: `opts.abortSignal` (acts like Ctrl+C), `opts.s3ListPage` (replaces the AWS SDK).
 */
export async function migrateCommand(opts, out = process.stdout) {
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
    const includeAfter = opts.lastCopyDate
      ? toAzcopyDate(resolveLastCopyDate(opts.lastCopyDate, { opts, key: stateKey(sourceBase, destBase), now: startedAt }))
      : null;
    dir = path.join(outputRoot(opts), `${fileTimestamp(startedAt)}-migration`);
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
    return EXIT.OK;
  }
  requireAwsCredentials(redactor);

  fs.mkdirSync(dir, { recursive: true });
  const view = opts.view ?? new PlainMigrationView(out);
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
      files: { log: logFile, migration: migrationFile(dir) },
    };
    log('INFO', `migration ${outcome}: ${result.chunksSuccess}/${result.chunksTotal} chunk(s) copied, ${result.chunksExhausted} exhausted, ${result.chunksOpen} open; copied ${result.copied}, failed ${result.failed}`);
    view.summary(result, hints);
    return EXIT_BY_OUTCOME[outcome];
  };

  try {
    view.start?.({ dir, logFile });
    log('INFO', `${continuing ? 'continuing' : 'starting'} migration ${dir}`);
    log('INFO', `options: ${JSON.stringify(options)}`);
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
      view.inventoryStarted?.({ provider: options.inventorySource === 's3' ? 'S3 ListObjectsV2' : 'azcopy dry-run', source: m.sourceBase });
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
      const { chunks, skipped } = await createChunks({ inventoryFile, chunksDir, maxFiles: options.chunkFiles, maxBytes: options.chunkBytes, dir });
      m.chunks = chunks.map((c) => ({ ...c, status: 'pending', attempts: 0, runs: [], copied: 0, ignored: 0, failed: 0, bytesCopied: 0 }));
      m.chunking = { status: 'done', chunks: chunks.length, skipped };
      save();
      log('INFO', `chunking done: ${chunks.length} chunk(s), ${skipped} skipped key(s)`);
      view.chunking?.({ chunks, skipped, maxFiles: options.chunkFiles, maxBytes: options.chunkBytes, chunksDir });
    }
    if (stopAfter === 'chunk') return finish('stopped');

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

        if (report.outcome === 'success' || report.outcome === 'partial') {
          // Only an attempt that ended adds its numbers: an interrupted or failed job is continued or repeated later.
          chunk.copied += report.copied;
          chunk.ignored += report.ignored;
          chunk.bytesCopied += report.bytesCopied;
          chunk.failed = report.failed;
        }
        chunk.status = report.outcome;
        log('INFO', `chunk ${chunkId(chunk.id)} attempt ${chunk.attempts}: ${report.outcome} (copied ${report.copied}, failed ${report.failed}, ignored ${report.ignored})`);
        if (report.outcome === 'success') {
          chunk.failed = 0;
          break;
        }
        if (report.outcome === 'interrupted') break;
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
    if (outcome === 'success' || outcome === 'partial') saveState(stateFile(opts), stateEntry, { startedAt: m.startedAt, runDir: dir });
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
      `  Folder:  ${dir}\n` +
      `  1. Inventory (${options.inventorySource === 's3' ? 'S3 ListObjectsV2, 1,000 keys per page' : 'azcopy dry-run'}), analysis${options.inventorySource === 's3' ? '' : `:\n       ${show(inventoryArgs())}`}\n` +
      `  2. Chunks of at most ${formatCount(options.chunkFiles)} objects or ${formatBytes(options.chunkBytes)}, lists in ${chunksDir}\n` +
      `  3. Copy the chunks with ${options.parallel} azcopy jobs at once (up to ${options.maxAttempts} attempts each), for example:\n       ${show(chunkCopyArgs(first))}\n` +
      `${stopAfter ? `  Stops after the ${stopAfter}.\n` : ''}`,
  );
}
