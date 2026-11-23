import { PlainView } from './view.js';
import { formatBytes, formatCount, formatDuration } from './format.js';
import { chunkId } from './chunks.js';
import { sizeClassLines } from './size-classes.js';
import { throughputText } from './throughput.js';

const WINDOW_MS = 60_000; // throughput is averaged over the last minute, as for one job
const SAMPLE_EVERY_MS = 500;
const num = (v) => Number(v) || 0;

/** Chunks that need no more work: copied, or out of attempts. */
export const isFinished = (chunk) => chunk.status === 'success' || chunk.status === 'exhausted';

/** The bytes of a chunk counted as done: all of a copied chunk, else what its attempts copied or the live attempt reached. */
function doneBytes(c, live) {
  if (c.status === 'success') return num(c.bytes);
  if (!live) return Math.min(num(c.bytes), num(c.bytesCopied));
  const fraction = num(live.bytesTotal) > 0 ? Math.min(1, num(live.bytesDone) / num(live.bytesTotal)) : 0;
  return Math.min(num(c.bytes), Math.max(num(c.bytesCopied), fraction * num(c.bytes)));
}

/**
 * Adds up what the chunks of a migration have done, against the total of the chunks so far. While the listing runs
 * (`listing` set, with the objects listed so far) the total grows: it is shown with a `+`, and there is no ETA.
 *
 * `chunks` are the entries of migration.json, the array the orchestrator adds the closed chunks to (status, bytes of
 * the chunk, and `copied` / `ignored` / `missing` / `failed` / `bytesCopied` summed over the attempts that ended).
 * The running chunks report through `update(id, snapshot)` (see copyChunk) and are folded in on top.
 *
 * The snapshot also has `running` (the numbers of the attempt of each running chunk), `classes` (the totals of each
 * size class, in the order their first chunk was closed; none for a migration with uniform chunks) and
 * `averageThroughput` (the bytes done since this run started, over its elapsed time).
 */
export class MigrationProgress {
  constructor({ chunks, now = Date.now }) {
    this.chunks = chunks;
    this.listing = null; // { files } while the listing runs
    this.now = now;
    this.startedAt = now();
    this.live = new Map(); // chunk id -> latest job snapshot
    this.samples = []; // [timestamp, bytes done] within WINDOW_MS
    this.startBytes = chunks.reduce((s, c) => s + doneBytes(c, null), 0); // what earlier runs did
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
    let missing = 0;
    let failed = 0;
    let total = 0;
    let bytesDone = 0;
    let done = 0;
    const running = [];
    const classes = new Map(); // size class name -> its totals
    for (const c of this.chunks) {
      const live = this.live.get(c.id);
      copied += num(c.copied) + num(live?.copied);
      ignored += num(c.ignored) + num(live?.ignored);
      missing += num(c.missing) + num(live?.missing);
      total += num(c.bytes);
      failed += live ? num(live.failed) : num(c.failed);
      const chunkDone = doneBytes(c, live);
      bytesDone += chunkDone;
      const isRunning = Boolean(live) && c.status !== 'success';
      if (isRunning) {
        const fraction = num(live.bytesTotal) > 0 ? Math.min(1, num(live.bytesDone) / num(live.bytesTotal)) : 0;
        running.push({
          id: c.id,
          ...(c.sizeClass ? { sizeClass: c.sizeClass } : {}),
          percent: fraction * 100,
          filesDone: num(live.copied) + num(live.ignored) + num(live.missing) + num(live.failed),
          filesTotal: num(live.filesTotal),
          bytesDone: num(live.bytesDone),
          bytesTotal: num(live.bytesTotal),
          failed: num(live.failed),
        });
      }
      if (isFinished(c)) done++;
      if (c.sizeClass) {
        let cls = classes.get(c.sizeClass);
        if (!cls) classes.set(c.sizeClass, (cls = { name: c.sizeClass, chunks: 0, done: 0, running: 0, pending: 0, exhausted: 0, files: 0, bytes: 0, bytesDone: 0 }));
        cls.chunks++;
        if (isFinished(c)) cls.done++;
        else if (isRunning) cls.running++;
        else cls.pending++;
        if (c.status === 'exhausted') cls.exhausted++;
        cls.files += num(c.files);
        cls.bytes += num(c.bytes);
        cls.bytesDone += chunkDone;
      }
    }
    const last = this.samples.at(-1);
    if (!last || now - last[0] >= SAMPLE_EVERY_MS) this.samples.push([now, bytesDone]);
    while (this.samples.length > 2 && now - this.samples[0][0] > WINDOW_MS) this.samples.shift();
    const [t0, b0] = this.samples[0];
    const [t1, b1] = this.samples.at(-1);
    const throughput = t1 > t0 ? Math.max(0, ((b1 - b0) / (t1 - t0)) * 1000) : 0;
    const listing = Boolean(this.listing);
    return {
      listing,
      listed: num(this.listing?.files),
      chunksTotal: this.chunks.length,
      chunksDone: done,
      chunksRunning: running.length,
      chunksPending: this.chunks.length - done - running.length,
      chunksExhausted: this.chunks.filter((c) => c.status === 'exhausted').length,
      running,
      classes: [...classes.values()],
      copied,
      ignored,
      missing,
      failed,
      bytesDone,
      bytesTotal: total,
      percent: total > 0 ? Math.min(100, (bytesDone / total) * 100) : 0,
      throughput,
      averageThroughput: now > this.startedAt ? Math.max(0, bytesDone - this.startBytes) / ((now - this.startedAt) / 1000) : 0,
      etaSeconds: !listing && throughput > 0 ? Math.max(0, total - bytesDone) / throughput : NaN,
      elapsedSeconds: (now - this.startedAt) / 1000,
    };
  }
}

/** The aggregate progress line (plain output and migration log). */
export function formatAggregate(s) {
  return [
    s.listing ? 'LISTING+COPYING' : 'COPYING',
    ...(s.listing ? [`listed ${formatCount(s.listed)} (${formatCount(s.chunksTotal)} chunks)`] : []),
    `chunks ${formatCount(s.chunksDone)}/${formatCount(s.chunksTotal)} done, ${formatCount(s.chunksRunning)} running`,
    `copied ${formatCount(s.copied)}`,
    `ignored ${formatCount(s.ignored)}`,
    ...(s.missing > 0 ? [`missing ${formatCount(s.missing)}`] : []),
    `failed ${formatCount(s.failed)}`,
    s.listing ? `${formatBytes(s.bytesDone)} / ${formatBytes(s.bytesTotal)}+` : `${formatBytes(s.bytesDone)} / ${formatBytes(s.bytesTotal)} (${s.percent.toFixed(1)}%)`,
    `${formatBytes(s.throughput)}/s`,
    s.listing ? 'ETA after listing' : `ETA ${formatDuration(s.etaSeconds)}`,
  ].join(' | ');
}

/** `chunk 00042`, with its size class when it has one: `chunk 00042 (small)`. */
export const chunkLabel = (c) => `chunk ${chunkId(c.id)}${c.sizeClass ? ` (${c.sizeClass})` : ''}`;

/** The chunks of each size class: `very-small 3, small 1, ...` (classes without a chunk are left out). */
function classCounts(classes, chunks) {
  const parts = classes.map((cls) => [cls.name, chunks.filter((c) => c.sizeClass === cls.name).length]).filter(([, n]) => n > 0);
  return `by class: ${parts.length > 0 ? parts.map(([name, n]) => `${name} ${formatCount(n)}`).join(', ') : 'none'}`;
}

/** What the listing made of the chunks, when it ended (the plain output and the dashboard's log). */
export function chunkingLines({ chunks, skipped, archived = 0, maxFiles, maxBytes, sizeClasses, chunksDir }) {
  const carried = chunks.filter((c) => c.carried).length;
  const split = carried > 0 ? ` (${formatCount(carried)} carried over + ${formatCount(chunks.length - carried)} from the inventory)` : '';
  const limits = sizeClasses ? `by size class, each ≤ its files per chunk or ≤ ${formatBytes(maxBytes)}` : `≤ ${formatCount(maxFiles)} objects or ≤ ${formatBytes(maxBytes)} each`;
  const lines = [`Listing done. Chunks: ${formatCount(chunks.length)}${split} (${limits}) in ${chunksDir}`];
  if (sizeClasses) lines.push(`  ${classCounts(sizeClasses, chunks)}`);
  if (skipped > 0) lines.push(`  ${formatCount(skipped)} key(s) cannot be copied (${formatCount(archived)} archived, ${formatCount(skipped - archived)} with a line break); they are listed in skipped.jsonl`);
  return lines;
}

/** How the copy runs, when it starts (the plain output and the dashboard's log). */
export function copyStartedLines({ chunks, parallel, concurrency, sizeClasses }) {
  const each = sizeClasses ? 'the objects at once of its size class in each:' : `${concurrency} object(s) at once in each`;
  return [
    `Copying as the chunks close${chunks > 0 ? ` (${formatCount(chunks)} ready)` : ''}: ${parallel} chunk(s) at a time, ${each}`,
    ...(sizeClasses ? sizeClassLines(sizeClasses) : []).map((l) => `  ${l}`),
  ];
}

/** The line that says how a chunk ended, with its last attempt's throughput unless `throughput` is false. */
export function chunkEndLine(c, { throughput = true } = {}) {
  return `${chunkLabel(c)} ${c.status}   copied ${formatCount(c.copied)}  ignored ${formatCount(c.ignored)}  ${num(c.missing) > 0 ? `missing ${formatCount(c.missing)}  ` : ''}failed ${formatCount(c.failed)}   ${formatBytes(c.bytesCopied)}  ${formatDuration(c.seconds ?? 0)}${throughput && c.throughput ? `   ${throughputText(c.throughput)}` : ''}`;
}

const TITLES = { success: 'Migration completed', partial: 'Migration completed with failed files', failed: 'Migration failed', interrupted: 'Migration interrupted', stopped: 'Migration stopped' };
export const migrationTitle = (outcome) => TITLES[outcome] ?? outcome;

/**
 * What makes a migration a delta, as [label, text] pairs (none for a full migration): the date and where it came
 * from, and the files carried over from the baseline. `m` has `includeAfter`, `baseline` and `carried` (migration.json).
 */
export function deltaLines(m) {
  if (!m.includeAfter) return [];
  const from = m.baseline ? ` (start of ${m.baseline.dir}, minus 10 min)` : ' (date given)';
  const lines = [['Delta', `objects modified on/after ${m.includeAfter}${from}`]];
  const c = m.carried;
  if (c) {
    const where = c.chunks === undefined ? 'in the first chunk(s)' : `in ${formatCount(c.chunks)} chunk(s)${c.inListing ? `, ${formatCount(c.inListing)} of them modified since (copied from their carried chunk)` : ''}`;
    lines.push(['Carried', `${formatCount(c.files)} file(s) that ${m.baseline.dir} did not copy (${formatCount(c.fromChunks.length)} chunk(s)), ${formatBytes(c.bytes)}, ${where}`]);
  }
  return lines;
}

/** The final summary of a migration (console and migration log). `result` is built by migrateCommand. */
export function migrationSummaryLines(result, hints = {}) {
  const lines = [
    '',
    '============== Migration summary ==============',
    `Status:           ${migrationTitle(result.outcome)}`,
    ...deltaLines(result).map(([label, text]) => `${`${label}:`.padEnd(18)}${text}`),
    `Chunks:           ${formatCount(result.chunksSuccess)} copied, ${formatCount(result.chunksExhausted)} with failed files after ${formatCount(result.maxAttempts)} attempt(s), ${formatCount(result.chunksOpen)} not finished (of ${formatCount(result.chunksTotal)})`,
    `Files copied:     ${formatCount(result.copied)}`,
    `Files failed:     ${formatCount(result.failed)}`,
    `Files ignored:    ${formatCount(result.ignored)}  (already at the target)`,
    ...(result.missing > 0 ? [`Files missing:    ${formatCount(result.missing)}  (deleted from the source after the listing)`] : []),
    `Data copied:      ${formatBytes(result.bytesCopied)}`,
    `Elapsed:          ${formatDuration(result.elapsedSeconds)}`,
    `Migration folder: ${result.dir}`,
  ];
  if (result.skipped > 0) {
    const archived = num(result.archived);
    const kinds = [archived > 0 ? `${formatCount(archived)} archived (not restored)` : '', result.skipped > archived ? `${formatCount(result.skipped - archived)} with a line break` : ''].filter(Boolean).join(', ');
    lines.push(`Not copied:       ${formatCount(result.skipped)} key(s) (${kinds}), listed in ${result.skippedFile}`);
  }
  if (result.failed > 0 || result.chunksExhausted > 0) lines.push('Failed files:     see the failed-*.jsonl in the chunk folders; `migrate --migration` tries them again');
  if (result.outcome === 'interrupted' || result.outcome === 'stopped' || result.chunksOpen > 0) lines.push(`Continue:         ${hints.continue}`);
  return lines;
}

/**
 * What `migrateCommand` shows while a migration runs (the wizard's MigrationDashboard implements the same
 * methods). All of them are optional to call from a test; the orchestrator always calls `start` first and
 * `close` last.
 *
 *   start({ dir, logFile, migration })         `migration` is the migration.json record
 *   inventoryStarted({ provider, source, includeAfter, resumeAfter })   inventoryProgress({ files, bytes, chunks })
 *   copyStarted({ chunks, parallel, concurrency, sizeClasses })   `chunks`: the closed chunks left to copy when copying
 *                              starts; `sizeClasses` (a migration chunked by size class) replaces `concurrency`
 *   chunking({ chunks, skipped, archived, maxFiles, maxBytes, sizeClasses, chunksDir })   the listing ended (`chunks`: all)
 *   chunkClosed(chunkEntry)   analysis(summary, lines)   chunkStarted(id, chunkEntry)   chunkEnded(chunkEntry)
 *   progress(aggregateSnapshot, { periodic })  failure(id, path, code)
 *   message(level, text)   log(level, text)    summary(result, hints)   close()
 */
export class PlainMigrationView extends PlainView {
  start({ dir, migration }) {
    this.print(`Migration: ${dir}`);
    for (const [label, text] of migration ? deltaLines(migration) : []) this.print(`${`${label}:`.padEnd(11)}${text}`);
  }

  inventoryStarted({ provider, source, includeAfter, resumeAfter }) {
    this.print(`Inventory (${provider}) of ${source}${includeAfter ? `, modified on/after ${includeAfter}` : ''}${resumeAfter ? ', continued after the last closed chunk' : ''} ...`);
  }

  inventoryProgress() {} // the aggregate progress line has the listing count

  analysis(summary, lines) {
    lines.forEach((l) => this.print(`  ${l}`));
  }

  chunking(info) {
    chunkingLines(info).forEach((l) => this.print(l));
  }

  copyStarted(info) {
    copyStartedLines(info).forEach((l) => this.print(l));
  }

  chunkClosed(chunk) {
    this.print(`  ${chunkLabel(chunk)} listed: ${formatCount(chunk.files)} objects, ${formatBytes(chunk.bytes)}`);
  }

  chunkStarted(id, chunk) {
    this.print(`  ${chunkLabel(chunk ?? { id })} started`);
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
 * What one chunk's copy reports goes to the one migration view through this, so N chunks never write status lines
 * over each other.
 *   progress   the aggregator and `changed()`, which shows the new aggregate
 */
export class ChunkView {
  constructor({ id, progress, view, changed }) {
    this.id = id;
    this.progress_ = progress;
    this.view = view;
    this.changed = changed;
  }

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
}