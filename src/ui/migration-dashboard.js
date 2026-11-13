import { formatBytes, formatCount } from '../format.js';
import { migrationTitle } from '../migration-view.js';
import { chunkId } from '../chunks.js';
import { createStyle, symbolsFor } from './style.js';
import {
  clamp, compactDuration, compose, Dashboard, duration, HISTORY, MAX_PANEL, NARROW_MIN, progressBar, rate, scanningBar, SHOWN_FAILURES,
  SPARK_MIN, sparkline, WIDE_MIN,
} from './dashboard.js';

/*
 * The live dashboard of `migrate` in the wizard, in the style of the copy dashboard.
 *
 *   renderMigrationDashboard(state, { columns, rows, color, unicode })   pure: the lines for one frame
 *   MigrationDashboard                                                   a migration view (see ../migration-view.js)
 *
 * Phases: the inventory (animated bar and a running count), the analysis (its lines, then the chunks), the
 * copy (overall bar with ETA, one cell per running chunk, counters, the latest failures) and the result panel.
 * Layouts as the copy dashboard: wide (>= 60 columns), narrow (36-59), very narrow (< 36: one line).
 */

const RUNNING_ROWS = 4; // rows of running chunks at most (more are summarised)
const CELL = 24; // width of one running chunk: "▶ 00013 ██████░░░░  71%" and a gap

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
  lines.push(row([[`copied ${formatCount(result.copied)}`, st.green], [' · ', st.dim], [`ignored ${formatCount(result.ignored)}`], [' · ', st.dim], [`failed ${formatCount(result.failed)}`, result.failed > 0 ? st.red : undefined]]));
  const average = result.elapsedSeconds > 0 ? ` (average ${rate(result.bytesCopied / result.elapsedSeconds)})` : '';
  lines.push(row([[`data ${formatBytes(result.bytesCopied)} in ${duration(result.elapsedSeconds)}${average}`]]));
  if (result.skipped > 0) lines.push(labelled('not copied', `${formatCount(result.skipped)} key(s) with a line break, see ${result.skippedFile}`, st.yellow));
  const codes = state.errorCodes ?? [];
  if (codes.length > 0) {
    const top = codes.slice(0, 3).map(([code, count]) => `${code} (${formatCount(count)})`);
    lines.push(labelled('errors', `${top.join(' · ')}${codes.length > 3 ? ` · +${codes.length - 3} more` : ''}`, st.yellow));
  }
  if (result.chunksOpen > 0 || result.chunksExhausted > 0 || result.outcome === 'stopped') lines.push(labelled('next', 'choose "Continue a migration" in the menu', st.cyan));
  lines.push(labelled('folder', result.dir), labelled('log', result.files.log));
  return lines;
}

/** The cells of the running chunks, `perRow` to a line. */
function runningRows(running, { perRow, st, sym, barWidth }) {
  const shown = running.slice(0, perRow * RUNNING_ROWS);
  const rows = [];
  for (let i = 0; i < shown.length; i += perRow) {
    const parts = [];
    for (const c of shown.slice(i, i + perRow)) {
      const percent = `${Math.round(c.percent)}%`.padStart(4);
      parts.push([`${sym.run} `, st.cyan], [chunkId(c.id)], [' '], ...progressBar(barWidth, c.percent / 100, st, sym), [` ${percent}`, st.bold], [' '.repeat(CELL - (2 + 5 + 1 + barWidth + 5))]);
    }
    rows.push(parts);
  }
  if (running.length > shown.length) rows.push([[`+${running.length - shown.length} more running`, st.dim]]);
  return rows;
}

/**
 * The lines of one frame.
 *
 *   state    { title, phase, frame, elapsedSeconds, provider, inventory: { files, bytes }, analysis: [lines],
 *              chunkCount, parallel, snapshot (aggregate, see MigrationProgress), speeds, failures: [{ id, path, code }],
 *              output, errorCodes, logFile, result }
 *            `result` (see migrateCommand) switches to the result panel.
 *   options  { columns, rows, color, unicode }
 */
export function renderMigrationDashboard(state, { columns = 80, rows, color = false, unicode = true } = {}) {
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
  const percent = copying ? `${snap.percent.toFixed(1)}%` : '';

  if (columns < NARROW_MIN) {
    if (!copying) return [compose([[`${phaseName.toLowerCase()} ${formatCount(inv.files)}`]], limit)];
    return [compose([[`${percent} ${rate(snap.throughput).replace(' ', '')} ${compactDuration(snap.etaSeconds)}`]], limit)];
  }

  if (columns < WIDE_MIN) {
    const gap = Math.max(1, limit - 2 - phaseName.length - elapsed.length - 1);
    const barWidth = clamp(limit - 8, 8, 30);
    const lines = [compose([[spin, st.cyan], [` ${phaseName}`, st.bold], [' '.repeat(gap)], [elapsed, st.dim]], limit)];
    if (!copying) {
      lines.push(compose([...scanningBar(barWidth, state.frame ?? 0, st, sym)], limit), compose([[`${formatCount(inv.files)} objects · ${formatBytes(inv.bytes)}`]], limit));
      return lines;
    }
    lines.push(
      compose([...progressBar(barWidth, ratio, st, sym), [` ${percent}`, st.bold]], limit),
      compose([[rate(snap.throughput), st.bold], [' · ', st.dim], [`ETA ${duration(snap.etaSeconds)}`]], limit),
      compose([
        [`${sym.ok} ${formatCount(snap.chunksDone)}/${formatCount(snap.chunksTotal)}`, st.green], [' '],
        [`${sym.run} ${formatCount(snap.chunksRunning)}`, st.cyan], [' '],
        [`${sym.fail} ${formatCount(snap.failed)}`, snap.failed > 0 ? st.red : st.dim],
      ], limit),
    );
    return lines;
  }

  // wide
  const content = limit - 3;
  const panel = Math.min(content, MAX_PANEL);
  const bar = st.dim(sym.bar);
  const row = (parts) => `${bar}  ${compose(parts, content)}`;
  const heading = state.phase === 'inventory' ? `Inventory (${state.provider ?? 'azcopy dry-run'})` : phaseName;
  const gap = Math.max(1, panel - 2 - heading.length - 'elapsed '.length - elapsed.length);
  const lines = [
    bar,
    `${st.cyan(sym.step)}  ${compose([[state.title ?? 'Migrating', st.bold]], content)}`,
    bar,
    row([[spin, st.cyan], [` ${heading}`, st.bold], [' '.repeat(gap)], ['elapsed ', st.dim], [elapsed]]),
  ];

  if (state.phase === 'inventory') {
    const text = `  ${formatCount(inv.files)} objects · ${formatBytes(inv.bytes)} so far`;
    lines.push(row([...scanningBar(clamp(panel - text.length, 10, 40), state.frame ?? 0, st, sym), [text, st.yellow]]));
  } else if (!copying) {
    for (const l of state.analysis ?? []) lines.push(row([[l, /^WARNING/.test(l) ? st.yellow : st.dim]]));
    lines.push(row([[state.chunkCount === undefined ? 'cutting the inventory into chunks ...' : `${formatCount(state.chunkCount)} chunks, starting the copy ...`, st.cyan]]));
  } else {
    const statsText = `  ${percent.padStart(5)}   ${formatBytes(snap.bytesDone)} / ${formatBytes(snap.bytesTotal)}`;
    const barWidth = clamp(panel - statsText.length, 10, 40);
    const speeds = state.speeds ?? [];
    lines.push(
      row([...progressBar(barWidth, ratio, st, sym), [statsText.slice(0, 7), st.bold], [statsText.slice(7)]]),
      row([['speed ', st.dim], [rate(snap.throughput), st.bold],
        ...(columns >= SPARK_MIN && speeds.length > 1 ? [['  '], [sparkline(speeds, sym), st.cyan]] : []),
        ['   ETA ', st.dim], [duration(snap.etaSeconds)]]),
      row([
        ['chunks ', st.dim], [`${sym.ok} ${formatCount(snap.chunksDone)}`, st.green], ['  '],
        [`${sym.run} ${formatCount(snap.chunksRunning)}`, st.cyan], ['  '],
        [`${formatCount(snap.chunksPending)} pending`, st.dim], ['  '],
        [`${sym.fail} ${formatCount(snap.chunksExhausted)}`, snap.chunksExhausted > 0 ? st.red : st.dim],
        ['      '], [`copied ${formatCount(snap.copied)}`, st.green], ['   '],
        [`${sym.fail} failed ${formatCount(snap.failed)}`, snap.failed > 0 ? st.red : st.dim],
      ]),
    );
    const perRow = clamp(Math.floor(content / CELL), 1, 4);
    const room = rows ? Math.max(1, rows - 1 - lines.length - SHOWN_FAILURES - 2) : RUNNING_ROWS + 1;
    for (const parts of runningRows(snap.running ?? [], { perRow, st, sym, barWidth: 10 }).slice(0, Math.min(RUNNING_ROWS + 1, room))) lines.push(row(parts));
    // The error code comes first: it is the part that must survive when a long path is shortened.
    for (const { id, path, code } of (state.failures ?? []).slice(-SHOWN_FAILURES)) {
      lines.push(row([[`${sym.fail} `, st.red], [`${code ?? '?'}  `, st.red], [path, st.yellow], [`   (chunk ${chunkId(id)})`, st.dim]]));
    }
  }
  if (state.logFile) lines.push(row([['log  ', st.dim], [state.logFile, st.dim]]));
  return lines;
}

/**
 * A migration view (see ../migration-view.js) that draws the dashboard in place, the way `Dashboard` does for
 * one job: it shares its timer, resize handling, coalesced writes and cursor handling.
 */
export class MigrationDashboard extends Dashboard {
  constructor({ delta = false, round, ...options } = {}) {
    super({ title: delta ? 'Delta migration' : 'Migrating', ...options });
    if (round > 0) this.title += ` · round ${round}`; // with --repeat
    this.phase = 'inventory';
    this.provider = null;
    this.inventory = { files: 0, bytes: 0 };
    this.analysisLines = [];
    this.chunkCount = undefined;
    this.parallel = 0;
  }

  migrationState(extra = {}) {
    return {
      title: this.title,
      phase: this.phase,
      frame: this.frame,
      elapsedSeconds: (this.now() - this.startedAt) / 1000,
      provider: this.provider,
      inventory: this.inventory,
      analysis: this.analysisLines,
      chunkCount: this.chunkCount,
      parallel: this.parallel,
      snapshot: this.snapshot,
      speeds: this.speeds,
      failures: this.failures,
      errorCodes: [...this.errorCounts].sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0]))),
      logFile: this.logFile,
      ...extra,
    };
  }

  draw(before = '') {
    if (!this.active) return;
    this.paint(renderMigrationDashboard(this.migrationState(), this.options()), { before });
  }

  // ---- the migration view interface (message(), log(), close() are the ones of Dashboard)

  inventoryStarted({ provider }) {
    this.phase = 'inventory';
    this.provider = provider;
    this.draw();
  }

  inventoryProgress(progress) {
    this.inventory = progress;
  } // drawn by the timer

  analysis(summary, lines) {
    this.phase = 'analysis';
    this.analysisLines = lines;
    this.draw();
  }

  chunking({ chunks }) {
    this.chunkCount = chunks.length;
    this.draw();
  }

  copyStarted({ parallel }) {
    this.phase = 'copying';
    this.parallel = parallel;
    this.draw();
  }

  chunkStarted() {}

  chunkEnded() {}

  progress(snapshot) {
    this.snapshot = snapshot;
    this.speeds = [...this.speeds, snapshot.throughput].slice(-HISTORY);
    this.draw();
  }

  failure(id, relativePath, errorCode) {
    const code = errorCode ? String(errorCode) : 'unknown';
    this.errorCounts.set(code, (this.errorCounts.get(code) ?? 0) + 1);
    this.failures = [...this.failures, { id, path: relativePath, code }].slice(-SHOWN_FAILURES);
  }

  /** Replaces the dashboard with the result panel. */
  summary(result) {
    if (this.active) {
      this.stop();
      this.paint(renderMigrationDashboard(this.migrationState({ result }), this.options()), { keep: true });
      this.out.write('\x1b[?25h');
      this.cursorHidden = false;
    }
  }
}
