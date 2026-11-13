import process from 'node:process';
import { formatBytes, formatDuration } from '../format.js';
import { coalescedOutput } from './output.js';
import { colorEnabled, createStyle, fit, symbolsFor, unicodeSupported, visible } from './style.js';

/*
 * What the live dashboards of the wizard share, in the style of its @clack/prompts: the layout widths, the bars and
 * the `Dashboard` base class that draws a block of lines in place (see migration-dashboard.js).
 *
 * Layouts: wide (>= 60 columns, sparkline from 80), narrow (36-59), very narrow (< 36: one line).
 * Every line is cut to the terminal width, so a line never wraps and the cursor arithmetic stays exact.
 */

export const WIDE_MIN = 60;
export const SPARK_MIN = 80;
export const NARROW_MIN = 36;
export const MAX_PANEL = 76;
export const HISTORY = 8;
export const SHOWN_FAILURES = 3;
export const KEPT_OUTPUT = 50;
const TICK_MS = 250;

export const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
/** formatDuration without the seconds once there are hours: 2h 41m. */
export const duration = (seconds) => formatDuration(seconds).replace(/(\dh \d+m) \d+s$/, '$1');
export const rate = (bytesPerSecond) => `${formatBytes(bytesPerSecond)}/s`;

/** `1h12m`, `5m30s`, `42s`: the two largest units without spaces, for the narrowest layouts. */
export function compactDuration(totalSeconds) {
  if (!Number.isFinite(totalSeconds) || totalSeconds < 0) return '--';
  const s = Math.round(totalSeconds);
  const [d, h, m] = [Math.floor(s / 86400), Math.floor((s % 86400) / 3600), Math.floor((s % 3600) / 60)];
  if (d > 0) return `${d}d${h}h`;
  if (h > 0) return `${h}h${m}m`;
  if (m > 0) return `${m}m${s % 60}s`;
  return `${s}s`;
}

/**
 * Joins `[text, style]` parts into one line of at most `width` visible characters. The part that
 * does not fit any more is shortened (middle ellipsis) and the rest is dropped.
 */
export function compose(parts, width) {
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

export function sparkline(values, sym) {
  const max = Math.max(...values, 0);
  return values.map((v) => sym.spark[max > 0 ? Math.round((v / max) * (sym.spark.length - 1)) : 0]).join('');
}

export function progressBar(width, fraction, st, sym) {
  const filled = clamp(Math.round(fraction * width), 0, width);
  return [[sym.barFull.repeat(filled), st.green], [sym.barEmpty.repeat(width - filled), st.dim]];
}

/** A block that bounces along the bar: the total is not known yet. */
export function scanningBar(width, frame, st, sym) {
  const block = clamp(Math.floor(width / 5), 2, width);
  const travel = Math.max(1, width - block);
  const step = (frame * 2) % (travel * 2);
  const at = step <= travel ? step : travel * 2 - step;
  return [[sym.barEmpty.repeat(at), st.dim], [sym.barFull.repeat(block), st.cyan], [sym.barEmpty.repeat(Math.max(0, width - at - block)), st.dim]];
}

const HIDE_CURSOR = '\x1b[?25l';
const SHOW_CURSOR = '\x1b[?25h';

/**
 * The base of a live view: redraws in place on a short timer (spinner, clock) and when told to, prints warnings above
 * the block. A subclass implements `draw(before)` (with `paint`) and its own view methods. Every redraw is one
 * write, through `coalescedOutput`.
 *
 *   out       the terminal stream (default process.stdout)
 *   title     the header line, e.g. "Copying"
 *   route     [from, to]: shown after the title as "from -> to"
 *   columns   fixed terminal width (default: the stream's, tracked on resize)
 *   color, unicode   override NO_COLOR / FORCE_COLOR / terminal detection
 *   env, now, tickMs   test hooks
 */
export class Dashboard {
  constructor({ out = process.stdout, title = 'Migrating', route, columns, rows, color, unicode, env = process.env, now = Date.now, tickMs = TICK_MS } = {}) {
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
    this.output = []; // the latest messages that are only logged, [{ level, text }]
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

  /** Draws the block again; `before` is text printed above it. Implemented by the subclass. */
  draw() {}

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

  /** A message that is only logged. */
  log(level, text) {
    const line = visible(text).replace(/[\x00-\x1f\x7f\s]+/g, ' ').trim();
    if (line) this.output = [...this.output, { level, text: line }].slice(-KEPT_OUTPUT);
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