import process from 'node:process';
import { formatBytes, formatCount, formatDuration } from '../format.js';
import { coalescedOutput } from './output.js';
import { colorEnabled, createStyle, fit, symbolsFor, unicodeSupported, visible } from './style.js';

/*
 * The live dashboard the wizard shows while azcopy copies, in the style of its @clack/prompts.
 *
 *   renderDashboard(state, { columns, color, unicode })   pure: the lines for one frame
 *   Dashboard                                             a `view` for runJob (see ../view.js) that draws them in place
 *
 * Layouts: wide (>= 60 columns, sparkline from 80), narrow (36-59), very narrow (< 36: one line).
 * Every line is cut to the terminal width, so a line never wraps and the cursor arithmetic stays exact.
 */

const WIDE_MIN = 60;
const SPARK_MIN = 80;
const NARROW_MIN = 36;
const MAX_PANEL = 76;
const HISTORY = 8;
const SHOWN_FAILURES = 3;
const MAX_OUTPUT = 10; // lines of azcopy output in the pane (fewer when the terminal is short)
const KEPT_OUTPUT = 50;
const TICK_MS = 250;

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
/** formatDuration without the seconds once there are hours: 2h 41m. */
const duration = (seconds) => formatDuration(seconds).replace(/(\dh \d+m) \d+s$/, '$1');
const rate = (bytesPerSecond) => `${formatBytes(bytesPerSecond)}/s`;

/** `1h12m`, `5m30s`, `42s`: the two largest units without spaces, for the narrowest layouts. */
function compactDuration(totalSeconds) {
  if (!Number.isFinite(totalSeconds) || totalSeconds < 0) return '--';
  const s = Math.round(totalSeconds);
  const [d, h, m] = [Math.floor(s / 86400), Math.floor((s % 86400) / 3600), Math.floor((s % 3600) / 60)];
  if (d > 0) return `${d}d${h}h`;
  if (h > 0) return `${h}h${m}m`;
  if (m > 0) return `${m}m${s % 60}s`;
  return `${s}s`;
}

const EMPTY_SNAPSHOT = { scanning: true, discovered: 0, copied: 0, failed: 0, ignored: 0, bytesDone: 0, bytesTotal: 0, percent: 0, throughput: 0, etaSeconds: NaN };

/**
 * Joins `[text, style]` parts into one line of at most `width` visible characters. The part that
 * does not fit any more is shortened (middle ellipsis) and the rest is dropped.
 */
function compose(parts, width) {
  let left = Math.max(0, width);
  let line = '';
  for (const [text, style = (t) => t] of parts) {
    const s = String(text);
    if (s.length <= left) {
      line += style(s);
      left -= s.length;
    } else {
      if (left > 0) line += style(fit(s, left));
      break;
    }
  }
  return line;
}

function sparkline(values, sym) {
  const max = Math.max(...values, 0);
  return values.map((v) => sym.spark[max > 0 ? Math.round((v / max) * (sym.spark.length - 1)) : 0]).join('');
}

function progressBar(width, fraction, st, sym) {
  const filled = clamp(Math.round(fraction * width), 0, width);
  return [[sym.barFull.repeat(filled), st.green], [sym.barEmpty.repeat(width - filled), st.dim]];
}

/** A block that bounces along the bar: the total is not known yet. */
function scanningBar(width, frame, st, sym) {
  const block = clamp(Math.floor(width / 5), 2, width);
  const travel = Math.max(1, width - block);
  const step = (frame * 2) % (travel * 2);
  const at = step <= travel ? step : travel * 2 - step;
  return [[sym.barEmpty.repeat(at), st.dim], [sym.barFull.repeat(block), st.cyan], [sym.barEmpty.repeat(Math.max(0, width - at - block)), st.dim]];
}

const TITLES = { success: 'Completed', partial: 'Completed with failed files', failed: 'Failed', interrupted: 'Interrupted' };
const TONES = { success: 'green', partial: 'yellow', interrupted: 'yellow', failed: 'red' };

function renderResult(state, { columns, st, sym }) {
  const { report } = state;
  const limit = Math.max(1, columns - 1);
  const tone = st[TONES[report.outcome] ?? 'red'];
  const title = report.jobStatus === 'NothingToCopy' ? 'Nothing to copy' : (TITLES[report.outcome] ?? report.jobStatus);

  if (columns < NARROW_MIN) {
    return [compose([[`${formatCount(report.copied)} ok · ${formatCount(report.failed)} failed`, tone]], limit)];
  }

  const bar = st.dim(sym.bar);
  const row = (parts) => `${bar}  ${compose(parts, limit - 3)}`;
  const labelled = (label, value, style) => row([[label.padEnd(13), st.dim], [value, style]]);
  const lines = [bar, `${tone(sym.end)}  ${compose([[title, (t) => st.bold(tone(t))]], limit - 3)}`];

  lines.push(row([[`copied ${formatCount(report.copied)}`, st.green], [' · ', st.dim], [`ignored ${formatCount(report.ignored)}`], [' · ', st.dim], [`failed ${formatCount(report.failed)}`, report.failed > 0 ? st.red : undefined]]));
  const average = report.elapsedSeconds > 0 ? ` (average ${rate(report.bytesCopied / report.elapsedSeconds)})` : '';
  lines.push(row([[`data ${formatBytes(report.bytesCopied)} in ${duration(report.elapsedSeconds)}${average}`]]));
  if (report.outcome === 'failed' && report.lastError) lines.push(labelled('error', report.lastError, st.red));
  const codes = state.errorCodes ?? [];
  if (codes.length > 0) {
    const top = codes.slice(0, 3).map(([code, count]) => `${code} (${formatCount(count)})`);
    lines.push(labelled('errors', `${top.join(' · ')}${codes.length > 3 ? ` · +${codes.length - 3} more` : ''}`, st.yellow));
  }
  if (report.files.failed) lines.push(labelled('failed list', report.files.failed));
  const next = [];
  if (report.files.failed) next.push('choose "Retry failed files" in the menu');
  if (report.jobId && (report.outcome === 'interrupted' || report.outcome === 'failed')) next.push('choose "Resume a run" in the menu');
  next.forEach((text, i) => lines.push(labelled(i === 0 ? 'next' : '', text, st.cyan)));
  lines.push(labelled('log', report.files.log));
  return lines;
}

/**
 * The lines of one frame.
 *
 *   state    { title, snapshot, frame, elapsedSeconds, speeds, failures, output, errorCodes, logFile, report }
 *            failures: the latest failed files [{ path, code }]; output: recent azcopy lines [{ level, text }];
 *            errorCodes: [[code, count]] of all failed files, most frequent first.
 *            `report` (the job report) switches to the result panel.
 *   options  { columns, rows, color, unicode }   `rows` (terminal height) limits the azcopy output pane
 */
export function renderDashboard(state, { columns = 80, rows, color = false, unicode = true } = {}) {
  const st = createStyle(color);
  const sym = symbolsFor(unicode);
  if (state.report) return renderResult(state, { columns, st, sym });

  const snap = state.snapshot ?? EMPTY_SNAPSHOT;
  const limit = Math.max(1, columns - 1);
  const spin = sym.spinner[(state.frame ?? 0) % sym.spinner.length];
  const elapsed = duration(state.elapsedSeconds ?? 0);
  const ratio = snap.bytesTotal > 0 ? clamp(snap.bytesDone / snap.bytesTotal, 0, 1) : 0;
  const percent = `${snap.percent.toFixed(1)}%`;

  if (columns < NARROW_MIN) {
    const speed = rate(snap.throughput).replace(' ', '');
    const text = snap.scanning ? `scan ${speed}` : `${percent} ${speed} ${compactDuration(snap.etaSeconds)}`;
    return [compose([[text]], limit)];
  }

  const counters = (separator) => [
    [`${sym.ok} `, st.green], [`copied ${formatCount(snap.copied)}`, st.green], [separator],
    [`${sym.ignored} `, st.dim], [`ignored ${formatCount(snap.ignored)}`, st.dim], [separator],
    [`${sym.fail} `, snap.failed > 0 ? st.red : st.dim], [`failed ${formatCount(snap.failed)}`, snap.failed > 0 ? st.red : st.dim], [separator],
    [`found ${formatCount(snap.discovered)}`, st.dim],
  ];

  if (columns < WIDE_MIN) {
    const gap = Math.max(1, limit - 2 - 'Copying'.length - elapsed.length);
    const barWidth = clamp(limit - (snap.scanning ? 9 : 7), 8, 30);
    return [
      compose([[spin, st.cyan], [' Copying', st.bold], [' '.repeat(gap)], [elapsed, st.dim]], limit),
      compose(snap.scanning ? [...scanningBar(barWidth, state.frame ?? 0, st, sym), [' scanning', st.dim]] : [...progressBar(barWidth, ratio, st, sym), [` ${percent}`, st.bold]], limit),
      compose([[rate(snap.throughput), st.bold], ...(snap.scanning ? [] : [[' · ', st.dim], [`ETA ${duration(snap.etaSeconds)}`]])], limit),
      compose([
        [`${sym.ok} ${formatCount(snap.copied)}`, st.green], [' '],
        [`${sym.ignored} ${formatCount(snap.ignored)}`, st.dim], [' '],
        [`${sym.fail} ${formatCount(snap.failed)}`, snap.failed > 0 ? st.red : st.dim],
      ], limit),
    ];
  }

  // wide
  const content = limit - 3;
  const panel = Math.min(content, MAX_PANEL); // the bar and the clock stay together on very wide terminals
  const bar = st.dim(sym.bar);
  const row = (parts) => `${bar}  ${compose(parts, content)}`;
  const gap = Math.max(1, panel - 2 - 'Copying'.length - 'elapsed '.length - elapsed.length);
  const statsText = snap.scanning ? '  Scanning source, totals still growing' : `  ${percent.padStart(5)}   ${formatBytes(snap.bytesDone)} / ${formatBytes(snap.bytesTotal)}`;
  const barWidth = clamp(panel - statsText.length, 10, 40);
  const speeds = state.speeds ?? [];

  const lines = [
    bar,
    `${st.cyan(sym.step)}  ${compose([[state.title ?? 'Copying', st.bold]], content)}`,
    bar,
    row([[spin, st.cyan], [' Copying', st.bold], [' '.repeat(gap)], ['elapsed ', st.dim], [elapsed]]),
    row(snap.scanning
      ? [...scanningBar(barWidth, state.frame ?? 0, st, sym), [statsText, st.yellow]]
      : [...progressBar(barWidth, ratio, st, sym), [statsText.slice(0, 7), st.bold], [statsText.slice(7)]]),
    row([['speed ', st.dim], [rate(snap.throughput), st.bold],
      ...(columns >= SPARK_MIN && speeds.length > 1 ? [['  '], [sparkline(speeds, sym), st.cyan]] : []),
      ...(snap.scanning ? [] : [['   ETA ', st.dim], [duration(snap.etaSeconds)]])]),
    row(counters('    ')),
  ];
  // The error code comes first: it is the part that must survive when a long path is shortened.
  for (const { path, code } of (state.failures ?? []).slice(-SHOWN_FAILURES)) {
    lines.push(row([[`${sym.fail} `, st.red], [`${code ?? '?'}  `, st.red], [path, st.yellow]]));
  }
  if (state.logFile) lines.push(row([['log  ', st.dim], [state.logFile, st.dim]]));

  // azcopy's own messages (Info, stderr): the latest ones, as many as the terminal height allows.
  const output = state.output ?? [];
  const room = Math.min(MAX_OUTPUT, (rows ? rows - 1 - lines.length : 4) - 1);
  if (output.length > 0 && room >= 1) {
    lines.push(row([['azcopy output', st.dim]]));
    for (const { level, text } of output.slice(-room)) {
      lines.push(row(level === 'STDERR' ? [['stderr ', st.yellow], [text, st.dim]] : [[text, st.dim]]));
    }
  }
  return lines;
}

const HIDE_CURSOR = '\x1b[?25l';
const SHOW_CURSOR = '\x1b[?25h';

/**
 * A `view` for runJob (see ../view.js): redraws the dashboard in place on every progress message and on
 * a short timer (spinner, clock), prints warnings above it and replaces it with the result panel at the end.
 * Every redraw is one write, through `coalescedOutput`.
 *
 *   out       the terminal stream (default process.stdout)
 *   title     the header line, e.g. "Copying"
 *   route     [from, to]: shown after the title as "from -> to"
 *   columns   fixed terminal width (default: the stream's, tracked on resize)
 *   color, unicode   override NO_COLOR / FORCE_COLOR / terminal detection
 *   env, now, tickMs   test hooks
 */
export class Dashboard {
  constructor({ out = process.stdout, title = 'Copying', route, columns, rows, color, unicode, env = process.env, now = Date.now, tickMs = TICK_MS } = {}) {
    this.raw = out;
    this.out = coalescedOutput(out);
    this.fixedColumns = columns;
    this.fixedRows = rows;
    this.color = color ?? colorEnabled(out, env);
    this.unicode = unicode ?? unicodeSupported(env);
    this.title = route ? `${title}  ${route[0]} ${symbolsFor(this.unicode).arrow} ${route[1]}` : title;
    this.now = now;
    this.tickMs = tickMs;

    this.snapshot = null;
    this.speeds = [];
    this.failures = []; // the latest failed files, [{ path, code }]
    this.errorCounts = new Map(); // error code -> number of failed files
    this.output = []; // the latest azcopy messages that are not progress, [{ level, text }]
    this.logFile = null;
    this.frame = 0;
    this.startedAt = now();
    this.lineWidths = []; // visible width of each line drawn last
    this.cursorHidden = false;
    this.active = false; // between start() and finish() / close()
    this.timer = null;
    this.onResize = () => this.draw();
    this.onExit = () => this.raw.write(SHOW_CURSOR); // synchronous: the coalesced write would never run
  }

  get columns() {
    return this.fixedColumns ?? this.raw.columns ?? 80;
  }

  get rows() {
    return this.fixedRows ?? this.raw.rows;
  }

  options() {
    return { columns: this.columns, rows: this.rows, color: this.color, unicode: this.unicode };
  }

  /** The sequence that removes the block drawn last, also when the terminal has re-wrapped it after a resize. */
  erase() {
    const columns = Math.max(1, this.columns);
    const rows = this.lineWidths.reduce((sum, width) => sum + Math.max(1, Math.ceil(width / columns)), 0);
    return rows > 0 ? `\x1b[${rows}A\x1b[J` : '';
  }

  /** Replaces the block on screen with `lines` (after `before`, text printed above it): one write. */
  paint(lines, { before = '', keep = false } = {}) {
    const hide = this.cursorHidden ? '' : HIDE_CURSOR;
    this.cursorHidden = true;
    this.out.write(`${this.erase()}${hide}${before}${lines.map((l) => `${l}\n`).join('')}`);
    this.lineWidths = keep ? [] : lines.map((l) => visible(l).length);
  }

  state(extra = {}) {
    return {
      title: this.title,
      snapshot: this.snapshot,
      frame: this.frame,
      elapsedSeconds: (this.now() - this.startedAt) / 1000,
      speeds: this.speeds,
      failures: this.failures,
      output: this.output,
      errorCodes: [...this.errorCounts].sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0]))),
      logFile: this.logFile,
      ...extra,
    };
  }

  draw(before = '') {
    if (!this.active) return;
    this.paint(renderDashboard(this.state(), this.options()), { before });
  }

  // ---- the view interface

  start({ logFile }) {
    this.logFile = logFile;
    this.startedAt = this.now();
    this.active = true;
    this.timer = setInterval(() => {
      this.frame++;
      this.draw();
    }, this.tickMs);
    this.timer.unref?.();
    this.raw.on?.('resize', this.onResize);
    process.once('exit', this.onExit);
    this.draw();
  }

  jobStarted() {}

  progress(snapshot) {
    this.snapshot = snapshot;
    this.speeds = [...this.speeds, snapshot.throughput].slice(-HISTORY);
    this.draw();
  }

  /** A warning or error: printed above the dashboard, which is then drawn again below it. */
  message(level, text) {
    if (!this.active) {
      this.out.write(`${text}\n`);
      return;
    }
    const st = createStyle(this.color);
    const style = level === 'ERROR' ? st.red : st.yellow;
    const prefix = this.columns < WIDE_MIN ? '' : `${st.dim(symbolsFor(this.unicode).bar)}  `;
    this.draw(`${prefix}${style(text)}\n`);
  }

  // failure() and log() only record: the timer draws them within a quarter of a second, so a burst of lines is one redraw.
  failure(relativePath, errorCode) {
    const code = errorCode ? String(errorCode) : 'unknown';
    this.errorCounts.set(code, (this.errorCounts.get(code) ?? 0) + 1);
    this.failures = [...this.failures, { path: relativePath, code }].slice(-SHOWN_FAILURES);
  }

  /** An azcopy message that is not progress (Info, stderr, ...). */
  log(level, text) {
    const line = visible(text).replace(/[\x00-\x1f\x7f\s]+/g, ' ').trim();
    if (line) this.output = [...this.output, { level, text: line }].slice(-KEPT_OUTPUT);
  }

  /** Replaces the dashboard with the result panel. */
  summary(report) {
    if (this.active) {
      this.stop();
      this.paint(renderDashboard(this.state({ report }), this.options()), { keep: true });
      this.out.write(SHOW_CURSOR);
      this.cursorHidden = false;
    }
  }

  /** Releases the timer, the listeners and the cursor. Safe to call more than once. */
  close() {
    if (this.active) {
      this.stop();
      this.out.write(SHOW_CURSOR); // the dashboard stays as it was last drawn
    }
    this.cursorHidden = false;
  }

  stop() {
    this.active = false;
    clearInterval(this.timer);
    this.timer = null;
    this.raw.off?.('resize', this.onResize);
    process.off('exit', this.onExit);
  }
}
