import { PlainView } from './view.js';
import { formatBytes, formatCount, formatDuration } from './format.js';
import { chunkId } from './chunks.js';

const WINDOW_MS = 60_000; // throughput is averaged over the last minute, as for one job
const SAMPLE_EVERY_MS = 500;
const num = (v) => Number(v) || 0;

/** Chunks that need no more work: copied, or out of attempts. */
export const isFinished = (chunk) => chunk.status === 'success' || chunk.status === 'exhausted';

/**
 * Adds up what the chunks of a migration have done, against the inventory total (known from the start, so
 * the percentage and the ETA are meaningful from the first chunk on).
 *
 * `chunks` are the entries of migration.json (the orchestrator keeps them up to date: status, bytes of the
 * chunk, and `copied` / `ignored` / `failed` / `bytesCopied` summed over the attempts that ended). The running
 * jobs report through `update(id, snapshot)` (a Metrics snapshot) and are folded in on top.
 */
export class MigrationProgress {
  constructor({ chunks, totalBytes, now = Date.now }) {
    this.chunks = chunks;
    this.totalBytes = totalBytes;
    this.now = now;
    this.startedAt = now();
    this.live = new Map(); // chunk id -> latest job snapshot
    this.samples = []; // [timestamp, bytes done] within WINDOW_MS
  }

  update(id, snapshot) {
    this.live.set(id, snapshot);
  }

  /** The job of a chunk ended (its numbers are in the chunk entry now). */
  clear(id) {
    this.live.delete(id);
  }

  snapshot(now = this.now()) {
    let copied = 0;
    let ignored = 0;
    let failed = 0;
    let bytesDone = 0;
    let done = 0;
    const running = [];
    for (const c of this.chunks) {
      const live = this.live.get(c.id);
      copied += num(c.copied) + num(live?.copied);
      ignored += num(c.ignored) + num(live?.ignored);
      failed += live ? num(live.failed) : num(c.failed);
      if (c.status === 'success') bytesDone += c.bytes;
      else if (live) {
        const fraction = num(live.bytesTotal) > 0 ? Math.min(1, num(live.bytesDone) / num(live.bytesTotal)) : 0;
        bytesDone += Math.min(c.bytes, Math.max(num(c.bytesCopied), fraction * c.bytes));
        running.push({ id: c.id, percent: fraction * 100 });
      } else bytesDone += Math.min(c.bytes, num(c.bytesCopied));
      if (isFinished(c)) done++;
    }
    const last = this.samples.at(-1);
    if (!last || now - last[0] >= SAMPLE_EVERY_MS) this.samples.push([now, bytesDone]);
    while (this.samples.length > 2 && now - this.samples[0][0] > WINDOW_MS) this.samples.shift();
    const [t0, b0] = this.samples[0];
    const [t1, b1] = this.samples.at(-1);
    const throughput = t1 > t0 ? Math.max(0, ((b1 - b0) / (t1 - t0)) * 1000) : 0;
    const total = this.totalBytes;
    return {
      chunksTotal: this.chunks.length,
      chunksDone: done,
      chunksRunning: running.length,
      chunksPending: this.chunks.length - done - running.length,
      chunksExhausted: this.chunks.filter((c) => c.status === 'exhausted').length,
      running,
      copied,
      ignored,
      failed,
      bytesDone,
      bytesTotal: total,
      percent: total > 0 ? Math.min(100, (bytesDone / total) * 100) : 0,
      throughput,
      etaSeconds: throughput > 0 ? Math.max(0, total - bytesDone) / throughput : NaN,
      elapsedSeconds: (now - this.startedAt) / 1000,
    };
  }
}

/** The aggregate progress line (plain output and migration log). */
export function formatAggregate(s) {
  return [
    'COPYING',
    `chunks ${formatCount(s.chunksDone)}/${formatCount(s.chunksTotal)} done, ${formatCount(s.chunksRunning)} running`,
    `copied ${formatCount(s.copied)}`,
    `failed ${formatCount(s.failed)}`,
    `${formatBytes(s.bytesDone)} / ${formatBytes(s.bytesTotal)} (${s.percent.toFixed(1)}%)`,
    `${formatBytes(s.throughput)}/s`,
    `ETA ${formatDuration(s.etaSeconds)}`,
  ].join(' | ');
}

/** The line that says how a chunk ended. */
export function chunkEndLine(c) {
  return `chunk ${chunkId(c.id)} ${c.status}   copied ${formatCount(c.copied)}  ignored ${formatCount(c.ignored)}  failed ${formatCount(c.failed)}   ${formatBytes(c.bytesCopied)}  ${formatDuration(c.seconds ?? 0)}`;
}

const TITLES = { success: 'Migration completed', partial: 'Migration completed with failed files', failed: 'Migration failed', interrupted: 'Migration interrupted', stopped: 'Migration stopped' };
export const migrationTitle = (outcome) => TITLES[outcome] ?? outcome;

/** The final summary of a migration (console and migration log). `result` is built by migrateCommand. */
export function migrationSummaryLines(result, hints = {}) {
  const lines = [
    '',
    '============== Migration summary ==============',
    `Status:           ${migrationTitle(result.outcome)}`,
    `Chunks:           ${formatCount(result.chunksSuccess)} copied, ${formatCount(result.chunksExhausted)} with failed files after ${formatCount(result.maxAttempts)} attempt(s), ${formatCount(result.chunksOpen)} not finished (of ${formatCount(result.chunksTotal)})`,
    `Files copied:     ${formatCount(result.copied)}`,
    `Files failed:     ${formatCount(result.failed)}`,
    `Files ignored:    ${formatCount(result.ignored)}  (skipped by azcopy, e.g. already at the target)`,
    `Data copied:      ${formatBytes(result.bytesCopied)}`,
    `Elapsed:          ${formatDuration(result.elapsedSeconds)}`,
    `Migration folder: ${result.dir}`,
  ];
  if (result.skipped > 0) lines.push(`Not copied:       ${formatCount(result.skipped)} key(s) with a line break, listed in ${result.skippedFile}`);
  if (result.failed > 0 || result.chunksExhausted > 0) lines.push('Failed files:     see the failed-*.jsonl in the chunk folders; `migrate --migration` tries them again');
  if (result.outcome === 'interrupted' || result.outcome === 'stopped' || result.chunksOpen > 0) lines.push(`Continue:         ${hints.continue}`);
  return lines;
}

/**
 * What `migrateCommand` shows while a migration runs (the wizard's MigrationDashboard implements the same
 * methods). All of them are optional to call from a test; the orchestrator always calls `start` first and
 * `close` last.
 *
 *   start({ dir, logFile })
 *   inventoryStarted({ provider, source })     inventoryProgress({ files, bytes })
 *   analysis(summary, lines)                   chunking({ chunks, skipped, maxFiles, maxBytes, chunksDir })
 *   copyStarted({ chunks, total, parallel })   chunkStarted(id)   chunkEnded(chunkEntry)
 *   progress(aggregateSnapshot, { periodic })  failure(id, path, code)
 *   message(level, text)   log(level, text)    summary(result, hints)   close()
 */
export class PlainMigrationView extends PlainView {
  start({ dir }) {
    this.print(`Migration: ${dir}`);
  }

  inventoryStarted({ provider, source }) {
    this.print(`Inventory (${provider}) of ${source} ...`);
  }

  inventoryProgress({ files, bytes }) {
    this.status(`inventory | ${formatCount(files)} objects | ${formatBytes(bytes)}`);
  }

  analysis(summary, lines) {
    lines.forEach((l) => this.print(`  ${l}`));
  }

  chunking({ chunks, skipped, maxFiles, maxBytes, chunksDir }) {
    this.print(`Chunks: ${formatCount(chunks.length)} (≤ ${formatCount(maxFiles)} objects or ≤ ${formatBytes(maxBytes)} each) in ${chunksDir}`);
    if (skipped > 0) this.print(`  ${formatCount(skipped)} key(s) with a line break cannot be copied; they are listed in skipped.jsonl`);
  }

  copyStarted({ chunks, total, parallel }) {
    this.print(`Copying ${formatCount(chunks)} chunk(s)${chunks < total ? ` (of ${formatCount(total)})` : ''}, ${parallel} at a time`);
  }

  chunkStarted(id) {
    this.print(`  chunk ${chunkId(id)} started`);
  }

  chunkEnded(chunk) {
    this.print(`  ${chunkEndLine(chunk)}`);
  }

  progress(snapshot, { periodic = false } = {}) {
    const line = formatAggregate(snapshot);
    this.status(line);
    if (periodic && !this.out.isTTY) this.print(line);
  }

  failure() {}

  summary(result, hints) {
    migrationSummaryLines(result, hints).forEach((l) => this.print(l));
  }
}

/**
 * The `view` one chunk's job gets (see view.js): it forwards what the job reports to the one migration
 * view, so N jobs never write status lines over each other.
 *   progress   the aggregator and `changed()`, which shows the new aggregate
 */
export class ChunkView {
  constructor({ id, progress, view, changed }) {
    this.id = id;
    this.progress_ = progress;
    this.view = view;
    this.changed = changed;
  }

  start() {}

  jobStarted() {}

  progress(snapshot, opts) {
    this.progress_.update(this.id, snapshot);
    this.changed(opts);
  }

  message(level, text) {
    this.view.message(level, `chunk ${chunkId(this.id)}: ${text}`);
  }

  failure(relativePath, errorCode) {
    this.view.failure(this.id, relativePath, errorCode);
  }

  log(level, text) {
    this.view.log(level, `chunk ${chunkId(this.id)}: ${text}`);
  }

  summary() {}

  close() {}
}
