import { formatBytes, formatCount } from '../format.js';
import { chunkEndLine, chunkingLines, chunkLabel, copyStartedLines, migrationTitle } from '../migration-view.js';
import { chunkId } from '../chunks.js';
import { createStyle, symbolsFor, visible } from './style.js';
import { clamp, compactDuration, compose, Dashboard, duration, HISTORY, NARROW_MIN, progressBar, rate, scanningBar } from './dashboard.js';
import { renderMigrationScreen } from './migration-screen.js';

/*
 * The live dashboard of `migrate` in the wizard.
 *
 *   renderMigrationDashboard(state, { columns, color, unicode })   pure: the compact lines of one frame, or the result panel
 *   renderMigrationScreen (migration-screen.js)                     pure: the lines of the full screen
 *   MigrationDashboard                                              a migration view (see ../migration-view.js)
 *
 * Phases: the inventory (animated bar and a running count) until the first chunk is closed, then the copy, with
 * a "listing" line while the listing still runs, and at the end the result panel, printed on the normal screen.
 * The compact lines (36+ columns, one line below) are what the full screen shows when the terminal is too small for it.
 */

const LOG_LINES = 500; // the lines of the log panel kept
const SPEED_WINDOW_MS = 10_000; // the speed of a chunk is over its last 10 seconds
const num = (v) => Number(v) || 0;

const TONES = { success: 'green', partial: 'yellow', interrupted: 'yellow', stopped: 'yellow', failed: 'red' };

function renderResult(state, { columns, st, sym }) {
  const { result } = state;
  const limit = Math.max(1, columns - 1);
  const tone = st[TONES[result.outcome] ?? 'red'];

  if (columns < NARROW_MIN) {
    return [compose([[`${formatCount(result.chunksSuccess)}/${formatCount(result.chunksTotal)} chunks · ${formatCount(result.failed)} failed`, tone]], limit)];
  }
  const bar = st.dim(sym.bar);
  const row = (parts) => `${bar}  ${compose(parts, limit - 3)}`;
  const labelled = (label, value, style) => row([[label.padEnd(13), st.dim], [value, style]]);
  const lines = [bar, `${tone(sym.end)}  ${compose([[migrationTitle(result.outcome), (t) => st.bold(tone(t))]], limit - 3)}`];
  lines.push(row([
    [`chunks ${formatCount(result.chunksSuccess)}/${formatCount(result.chunksTotal)} copied`, st.green], [' · ', st.dim],
    [`${formatCount(result.chunksExhausted)} with failed files`, result.chunksExhausted > 0 ? st.yellow : undefined], [' · ', st.dim],
    [`${formatCount(result.chunksOpen)} not finished`, result.chunksOpen > 0 ? st.yellow : undefined],
  ]));
  lines.push(row([
    [`copied ${formatCount(result.copied)}`, st.green], [' · ', st.dim], [`ignored ${formatCount(result.ignored)}`], [' · ', st.dim],
    ...(result.missing > 0 ? [[`missing ${formatCount(result.missing)}`, st.yellow], [' · ', st.dim]] : []),
    [`failed ${formatCount(result.failed)}`, result.failed > 0 ? st.red : undefined],
  ]));
  const average = result.elapsedSeconds > 0 ? ` (average ${rate(result.bytesCopied / result.elapsedSeconds)})` : '';
  lines.push(row([[`data ${formatBytes(result.bytesCopied)} in ${duration(result.elapsedSeconds)}${average}`]]));
  if (result.skipped > 0) {
    const archived = Number(result.archived) || 0;
    const kinds = [archived > 0 ? `${formatCount(archived)} archived` : '', result.skipped > archived ? `${formatCount(result.skipped - archived)} with a line break` : ''].filter(Boolean).join(', ');
    lines.push(labelled('not copied', `${formatCount(result.skipped)} key(s) (${kinds}), see ${result.skippedFile}`, st.yellow));
  }
  const codes = state.errorCodes ?? [];
  if (codes.length > 0) {
    const top = codes.slice(0, 3).map(([code, count]) => `${code} (${formatCount(count)})`);
    lines.push(labelled('errors', `${top.join(' · ')}${codes.length > 3 ? ` · +${codes.length - 3} more` : ''}`, st.yellow));
  }
  if (result.chunksOpen > 0 || result.chunksExhausted > 0 || result.outcome === 'stopped') lines.push(labelled('next', 'choose "Continue a migration" in the menu', st.cyan));
  lines.push(labelled('folder', result.dir), labelled('log', result.files.log));
  return lines;
}

/**
 * The compact lines of one frame (or the result panel).
 *
 *   state    { title, phase, frame, elapsedSeconds, provider, inventory: { files, bytes }, analysis: [lines],
 *              chunkCount, parallel, snapshot (aggregate, see MigrationProgress), speeds, errorCodes, logFile, result }
 *            `result` (see migrateCommand) switches to the result panel.
 *   options  { columns, color, unicode }
 */
export function renderMigrationDashboard(state, { columns = 80, color = false, unicode = true } = {}) {
  const st = createStyle(color);
  const sym = symbolsFor(unicode);
  if (state.result) return renderResult(state, { columns, st, sym });

  const limit = Math.max(1, columns - 1);
  const spin = sym.spinner[(state.frame ?? 0) % sym.spinner.length];
  const elapsed = duration(state.elapsedSeconds ?? 0);
  const snap = state.snapshot;
  const copying = state.phase === 'copying' && snap;
  const phaseName = state.phase === 'copying' ? 'Migrating' : state.phase === 'inventory' ? 'Inventory' : 'Analysis';
  const inv = state.inventory ?? { files: 0, bytes: 0 };
  const ratio = copying && snap.bytesTotal > 0 ? clamp(snap.bytesDone / snap.bytesTotal, 0, 1) : 0;
  const listing = copying && snap.listing;
  const percent = copying ? (listing ? '' : `${snap.percent.toFixed(1)}%`) : '';
  const eta = listing ? 'after listing' : duration(snap?.etaSeconds);
  const total = copying ? `${formatBytes(snap.bytesTotal)}${listing ? '+' : ''}` : '';

  if (columns < NARROW_MIN) {
    if (!copying) return [compose([[`${phaseName.toLowerCase()} ${formatCount(inv.files)}`]], limit)];
    return [compose([[`${listing ? `+${formatCount(snap.listed)}` : percent} ${rate(snap.throughput).replace(' ', '')} ${listing ? '' : compactDuration(snap.etaSeconds)}`.trimEnd()]], limit)];
  }

  const gap = Math.max(1, limit - 2 - phaseName.length - elapsed.length - 1);
  const barWidth = clamp(limit - 13, 8, 30); // and " 184.20 TiB+"
  const lines = [compose([[spin, st.cyan], [` ${phaseName}`, st.bold], [' '.repeat(gap)], [elapsed, st.dim]], limit)];
  if (!copying) {
    lines.push(compose([...scanningBar(barWidth, state.frame ?? 0, st, sym)], limit), compose([[`${formatCount(inv.files)} objects · ${formatBytes(inv.bytes)}`]], limit));
    return lines;
  }
  if (listing) lines.push(compose([[`listing ${formatCount(snap.listed)} · ${formatCount(snap.chunksTotal)} chunks`, st.yellow]], limit));
  lines.push(
    compose([...progressBar(barWidth, ratio, st, sym), [` ${percent || total}`, st.bold]], limit),
    compose([[rate(snap.throughput), st.bold], [' · ', st.dim], [`ETA ${eta}`]], limit),
    compose([
      [`${sym.ok} ${formatCount(snap.chunksDone)}/${formatCount(snap.chunksTotal)}`, st.green], [' '],
      [`${sym.run} ${formatCount(snap.chunksRunning)}`, st.cyan], [' '],
      [`${sym.fail} ${formatCount(snap.failed)}`, snap.failed > 0 ? st.red : st.dim],
    ], limit),
  );
  return lines;
}

/**
 * A migration view (see ../migration-view.js) that draws the full-screen dashboard on the alternate screen, with the
 * timer, resize handling, coalesced writes and cursor handling of `Dashboard`. It shows the inventory phase until the
 * first chunk is closed (or is ready when a migration is continued), then the copy. It keeps:
 *
 *   slots        one per worker: a chunk that starts takes the first free one (or the one it holds) and keeps it;
 *                a chunk that ends stays there, with its outcome, until the next chunk takes the slot
 *   logLines     the last 500 lines of the log panel: chunks listed, started and ended, failed files, warnings
 *   sizeClasses  the size classes of the migration, for the class table
 *
 * At the end, the normal screen comes back with the result panel.
 */
export class MigrationDashboard extends Dashboard {
  constructor({ delta = false, round, ...options } = {}) {
    super({ title: delta ? 'Delta migration' : 'Migrating', fullScreen: true, ...options });
    if (round > 0) this.title += ` · round ${round}`; // with --repeat
    this.phase = 'inventory';
    this.provider = null;
    this.inventory = { files: 0, bytes: 0 };
    this.analysisLines = [];
    this.chunkCount = undefined;
    this.parallel = 0;
    this.copying = false; // copyStarted was called: the copy phase starts with the first chunk
    this.slots = []; // null or { chunk, samples: [[time, bytesDone]], percent, endedAt?, outcome? }
    this.logLines = []; // [{ time, level, text }]
    this.sizeClasses = null;
  }

  /** Adds a line to the log panel (drawn by the caller or the timer). */
  addLog(level, text) {
    // eslint-disable-next-line no-control-regex
    const line = visible(text).replace(/[\x00-\x1f\x7f]+/g, ' ').trim();
    if (!line) return;
    this.logLines.push({ time: this.now(), level, text: line });
    if (this.logLines.length > LOG_LINES) this.logLines.splice(0, this.logLines.length - LOG_LINES);
  }

  /** What the renderer shows of a slot. */
  slotState(slot, live, now) {
    const { chunk } = slot;
    const base = { id: chunk.id, sizeClass: chunk.sizeClass, attempt: Math.max(1, num(chunk.attempts)) };
    if (slot.endedAt !== undefined) {
      return {
        ...base, state: 'ended', outcome: slot.outcome, percent: slot.outcome === 'success' ? 100 : slot.percent,
        agoSeconds: Math.max(0, (now - slot.endedAt) / 1000), copied: num(chunk.copied), failed: num(chunk.failed),
      };
    }
    const [first, last] = [slot.samples[0], slot.samples.at(-1)];
    return {
      ...base,
      state: 'running',
      percent: num(live?.percent),
      filesDone: num(live?.filesDone),
      filesTotal: live ? num(live.filesTotal) : num(chunk.files),
      bytesDone: num(live?.bytesDone),
      bytesTotal: live ? num(live.bytesTotal) : num(chunk.bytes),
      speed: first && last[0] > first[0] ? ((last[1] - first[1]) / (last[0] - first[0])) * 1000 : 0,
    };
  }

  migrationState(extra = {}) {
    const now = this.now();
    const live = new Map((this.snapshot?.running ?? []).map((r) => [r.id, r]));
    return {
      title: this.title,
      phase: this.phase,
      frame: this.frame,
      elapsedSeconds: (now - this.startedAt) / 1000,
      provider: this.provider,
      inventory: this.inventory,
      analysis: this.analysisLines,
      chunkCount: this.chunkCount,
      parallel: this.parallel,
      snapshot: this.snapshot,
      speeds: this.speeds,
      errorCodes: [...this.errorCounts].sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0]))),
      logFile: this.logFile,
      slots: this.slots.map((slot) => (slot ? this.slotState(slot, live.get(slot.chunk.id), now) : null)),
      sizeClasses: this.sizeClasses,
      log: this.logLines,
      ...extra,
    };
  }

  draw() {
    if (!this.active) return;
    this.paintScreen(renderMigrationScreen(this.migrationState(), this.options()));
  }

  // ---- the migration view interface (log() and close() are the ones of Dashboard)

  /** A warning or error: a line of the log panel (printed as it is once the dashboard has ended). */
  message(level, text) {
    if (!this.active) {
      this.out.write(`${text}\n`);
      return;
    }
    this.addLog(level, text);
    this.draw();
  }

  inventoryStarted({ provider, source, includeAfter, resumeAfter }) {
    this.provider = provider;
    this.addLog('INFO', `Inventory (${provider}) of ${source ?? 'the source'}${includeAfter ? `, modified on/after ${includeAfter}` : ''}${resumeAfter ? ', continued after the last closed chunk' : ''}`);
    this.draw();
  }

  inventoryProgress(progress) {
    this.inventory = progress;
  } // drawn by the timer

  analysis(summary, lines) {
    if (this.phase !== 'copying') this.phase = 'analysis';
    this.analysisLines = lines;
    for (const l of lines) this.addLog(/^WARNING/.test(l) ? 'WARN' : 'INFO', `analysis: ${l}`);
    this.draw();
  }

  chunking(info) {
    this.chunkCount = info.chunks.length;
    this.sizeClasses ??= info.sizeClasses ?? null;
    chunkingLines(info).forEach((l) => this.addLog('INFO', l));
    this.draw();
  }

  copyStarted(info) {
    const { chunks, parallel } = info;
    this.copying = true;
    if (chunks > 0) this.phase = 'copying';
    this.parallel = parallel;
    this.sizeClasses = info.sizeClasses ?? null;
    while (this.slots.length < parallel) this.slots.push(null);
    copyStartedLines(info).forEach((l) => this.addLog('INFO', l));
    this.draw();
  }

  chunkClosed(chunk) {
    if (this.copying) this.phase = 'copying';
    this.addLog('INFO', `${chunkLabel(chunk)} listed: ${formatCount(chunk.files)} objects, ${formatBytes(chunk.bytes)}`);
    this.draw();
  }

  chunkStarted(id, chunk) {
    const entry = chunk ?? { id };
    this.addLog('INFO', `${chunkLabel(entry)} started`);
    let at = this.slots.findIndex((s) => s?.chunk.id === id);
    if (at < 0) at = this.slots.findIndex((s) => !s || s.endedAt !== undefined);
    const slot = { chunk: entry, samples: [], percent: 0 };
    if (at < 0) this.slots.push(slot);
    else this.slots[at] = slot;
    this.draw();
  }

  chunkEnded(chunk) {
    const slot = this.slots.find((s) => s?.chunk.id === chunk.id && s.endedAt === undefined);
    if (slot) Object.assign(slot, { chunk, endedAt: this.now(), outcome: chunk.status });
    this.addLog(chunk.status === 'success' ? 'INFO' : chunk.status === 'interrupted' ? 'WARN' : 'ERROR', chunkEndLine(chunk));
    this.draw();
  }

  progress(snapshot) {
    this.snapshot = snapshot;
    this.speeds = [...this.speeds, snapshot.throughput].slice(-HISTORY);
    const now = this.now();
    for (const r of snapshot.running ?? []) {
      const slot = this.slots.find((s) => s?.chunk.id === r.id && s.endedAt === undefined);
      if (!slot) continue;
      const bytes = num(r.bytesDone);
      if (bytes < (slot.samples.at(-1)?.[1] ?? 0)) slot.samples = []; // a new attempt
      slot.samples.push([now, bytes]);
      while (slot.samples.length > 2 && now - slot.samples[0][0] > SPEED_WINDOW_MS) slot.samples.shift();
      slot.percent = num(r.percent);
    }
    this.draw();
  }

  failure(id, relativePath, errorCode) {
    const code = errorCode ? String(errorCode) : 'unknown';
    this.errorCounts.set(code, (this.errorCounts.get(code) ?? 0) + 1);
    // The error code comes before the path: it is the part that must survive when a long path is shortened.
    this.addLog('FAIL', `chunk ${chunkId(id)}  ${code}  ${relativePath}`);
  } // drawn by the timer: a burst of failures is one redraw

  /** Leaves the full screen and prints the result panel on the normal screen. */
  summary(result) {
    if (!this.active) return;
    this.stop();
    const lines = renderMigrationDashboard(this.migrationState({ result }), this.options());
    this.leaveScreen(lines.map((l) => `${l}\n`).join(''));
  }
}
