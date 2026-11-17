import { formatBytes, formatCount } from '../format.js';
import { chunkId } from '../chunks.js';
import { rangeText } from '../size-classes.js';
import { createStyle, fit, symbolsFor } from './style.js';
import { clamp, compose, duration, progressBar, rate, scanningBar, SCREEN_MIN_ROWS, SPARK_MIN, sparkline, WIDE_MIN } from './dashboard.js';
import { renderMigrationDashboard } from './migration-dashboard.js';

/*
 * The full-screen dashboard of a migration started from the wizard (drawn by MigrationDashboard on the alternate
 * screen). From the top:
 *
 *   header           the title and the elapsed time, and a rule
 *   overall panel    5 rows: overall bar, speed, listing, objects, chunks (the inventory and the analysis use the
 *                    same rows: the overall row becomes the scanning bar and the object count)
 *   slots            one row per worker; a chunk keeps its slot from its start to the start of the next chunk there
 *   size classes     a table, or one line when rows are short; none for a migration with uniform chunks
 *   log              every row left (at least 3), the newest line at the bottom
 *
 * Under 60 columns or 16 rows, the compact lines of renderMigrationDashboard go at the top, with the log under them.
 */

const OVERALL_ROWS = 5;
const MIN_LOG_ROWS = 3;
const SLOT_BAR = 15;
const LABEL = 10; // " overall   " is a space and the label padded to this
const DEFAULT_ROWS = 24;

const num = (v) => Number(v) || 0;
const pad2 = (n) => String(n).padStart(2, '0');
/** The local time of the log lines: 03:14:07. */
const clock = (ms) => {
  const d = new Date(ms);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
};

/** A horizontal rule across the screen, with an optional title after its first two characters. */
function rule(title, limit, st, sym) {
  if (!title) return st.dim(sym.rule.repeat(limit));
  const lead = `${sym.rule.repeat(2)} `;
  const text = fit(title, Math.max(1, limit - lead.length - 1));
  return compose([[lead, st.dim], [text, st.bold], [` ${sym.rule.repeat(Math.max(0, limit - lead.length - text.length - 1))}`, st.dim]], limit);
}

const label = (name, st) => [` ${name.padEnd(LABEL)}`, st.dim];

/** The first of `pieces` that fit in `room` together, joined by `separator`, with an ellipsis when some are left out. */
function fitting(pieces, room, separator) {
  let text = '';
  for (const [i, piece] of pieces.entries()) {
    const next = i === 0 ? piece : `${text}${separator}${piece}`;
    if (next.length > room - (i < pieces.length - 1 ? 2 : 0)) return i === 0 ? fit(piece, room) : `${text} …`;
    text = next;
  }
  return text;
}

function header(state, { limit, st, sym }) {
  const spin = sym.spinner[(state.frame ?? 0) % sym.spinner.length];
  const right = ` elapsed ${duration(state.elapsedSeconds ?? 0)} `;
  const title = fit(` ${state.title ?? 'Migrating'}`, Math.max(1, limit - right.length - 2));
  const gap = Math.max(1, limit - title.length - 1 - right.length);
  return [compose([[title, st.bold], [' '.repeat(gap)], [spin, st.cyan], [right, st.dim]], limit), rule('', limit, st, sym)];
}

/** The 5 rows of the overall numbers. */
function overallPanel(state, { limit, columns, st, sym }) {
  const snap = state.snapshot;
  const row = (name, parts) => compose([label(name, st), ...parts], limit);
  const none = [['—', st.dim]];
  const room = limit - LABEL - 1;

  if (state.phase !== 'copying' || !snap) {
    const inv = state.inventory ?? { files: 0, bytes: 0 };
    let overall;
    if (state.phase === 'analysis') {
      overall = [[state.chunkCount === undefined ? 'analysing the listing ...' : `${formatCount(state.chunkCount)} chunk(s) listed`, st.cyan]];
    } else {
      const text = `  ${formatCount(inv.files)} objects · ${formatBytes(inv.bytes)} so far`;
      overall = [...scanningBar(clamp(room - text.length, 10, 40), state.frame ?? 0, st, sym), [text, st.yellow]];
    }
    const listing = state.phase === 'inventory'
      ? [[`${state.provider ?? 'listing'} · ${formatCount(inv.files)} objects listed`, st.yellow]]
      : [['ended', st.dim]];
    return [
      row('overall', overall),
      row('speed', none),
      row('listing', listing),
      row('objects', none),
      row('chunks', state.parallel > 0 ? [['waiting for the first chunk', st.dim]] : none),
    ];
  }

  /** The first of the variants (lists of parts, the fullest first) that fits the row. */
  const first = (...variants) => variants.find((parts) => parts.reduce((sum, [text]) => sum + String(text).length, 0) <= room) ?? variants.at(-1);
  const listing = snap.listing;
  const ratio = snap.bytesTotal > 0 ? clamp(snap.bytesDone / snap.bytesTotal, 0, 1) : 0;
  const stats = `  ${`${num(snap.percent).toFixed(1)}%`.padStart(6)}    ${formatBytes(snap.bytesDone)} / ${formatBytes(snap.bytesTotal)}${listing ? '+' : ''}`;
  const speeds = state.speeds ?? [];
  const codes = state.errorCodes ?? [];
  const objects = first(...[true, num(snap.missing) > 0].map((withMissing) => [
    [`copied ${formatCount(snap.copied)}`, st.green], [' · ', st.dim], [`ignored ${formatCount(snap.ignored)}`], [' · ', st.dim],
    ...(withMissing ? [[`missing ${formatCount(snap.missing)}`, num(snap.missing) > 0 ? st.yellow : undefined], [' · ', st.dim]] : []),
    [`failed ${formatCount(snap.failed)}`, snap.failed > 0 ? st.red : undefined],
  ]));
  const errorsRoom = room - objects.reduce((sum, [text]) => sum + text.length, 0) - '        errors '.length;
  const firstCode = codes.length > 0 ? `${codes[0][0]} ${formatCount(codes[0][1])}` : '';
  if (codes.length > 0 && errorsRoom >= firstCode.length) {
    const pieces = codes.map(([code, count]) => `${code} ${formatCount(count)}`);
    objects.push(['        errors ', st.dim], [fitting(pieces, errorsRoom, ' · '), st.yellow]);
  }
  return [
    row('overall', [...progressBar(clamp(room - stats.length, 10, 50), ratio, st, sym), [stats.slice(0, 8), st.bold], [stats.slice(8)]]),
    row('speed', first(
      [
        [rate(snap.throughput), st.bold],
        ...(columns >= SPARK_MIN && speeds.length > 1 ? [['  '], [sparkline(speeds, sym), st.cyan]] : []),
        ['   average ', st.dim], [rate(num(snap.averageThroughput))],
        ['   ETA ', st.dim], [listing ? 'after listing' : duration(snap.etaSeconds)],
      ],
      [[rate(snap.throughput), st.bold], ['   ETA ', st.dim], [listing ? 'after listing' : duration(snap.etaSeconds)]],
    )),
    row('listing', listing
      ? [[`${formatCount(snap.listed)} objects listed · ${formatCount(snap.chunksTotal)} chunks so far`, st.yellow]]
      : [[`ended · ${formatCount(snap.chunksTotal)} chunks`, st.dim]]),
    row('objects', objects),
    row('chunks', first(...['out of attempts', ''].map((exhausted) => [
      [`${sym.ok} ${formatCount(snap.chunksDone)} done`, st.green], [' · ', st.dim],
      [`${sym.run} ${formatCount(snap.chunksRunning)} running`, st.cyan], [' · ', st.dim],
      [`${formatCount(snap.chunksPending)} pending`], [' · ', st.dim],
      [`${sym.fail} ${formatCount(snap.chunksExhausted)}${exhausted ? ` ${exhausted}` : ''}`, snap.chunksExhausted > 0 ? st.red : st.dim],
    ]))),
  ];
}

const OUTCOMES = {
  success: ['ok', 'green', 'done'],
  exhausted: ['fail', 'red', 'out of attempts'],
  interrupted: ['pause', 'yellow', 'interrupted'],
};

/**
 * The rows of the slots, `count` rows at most: when the slots do not fit, the last row says how many more run.
 * A slot is null (empty) or { id, sizeClass, state: 'running' | 'ended', attempt, percent, filesDone, filesTotal,
 * bytesDone, bytesTotal, speed, outcome, agoSeconds, copied, failed }.
 */
function slotRows(state, count, { limit, st, sym }) {
  const slots = state.slots ?? [];
  const shown = slots.length > count ? slots.slice(0, count - 1) : slots;
  const numWidth = String(slots.length).length;
  const names = [...(state.sizeClasses ?? []).map((c) => c.name), ...slots.map((s) => s?.sizeClass ?? '')];
  const classWidth = Math.max(0, ...names.map((n) => n.length));
  const fixed = 1 + numWidth + 3 + 5 + (classWidth > 0 ? 1 + classWidth : 0) + 1 + 1 + 4; // all but the bar
  const barWidth = clamp(limit - fixed, 5, SLOT_BAR);

  // The optional columns of the running slots, each padded to its widest value; they drop from the right.
  const running = shown.filter((s) => s?.state === 'running');
  const widest = (texts) => Math.max(0, ...texts.map((t) => t.length));
  const doneWidth = widest(running.map((s) => formatCount(s.filesDone)));
  const totalWidth = widest(running.map((s) => formatCount(s.filesTotal)));
  const columns = [
    (s) => `${formatCount(s.filesDone).padStart(doneWidth)} / ${formatCount(s.filesTotal).padStart(totalWidth)} obj`,
    (s) => `${formatBytes(s.bytesDone)} / ${formatBytes(s.bytesTotal)}`,
    (s) => rate(Math.round(num(s.speed))),
    (s) => `try ${s.attempt ?? 1}`,
  ].map((text) => ({ text, width: widest(running.map(text)) }));
  let used = fixed + barWidth;
  let kept = 0;
  while (kept < columns.length && used + 3 + columns[kept].width <= limit) used += 3 + columns[kept++].width;
  const right = (i) => i === 2; // the speed is aligned to the right

  const idle = state.phase !== 'copying' ? 'waiting for the first chunk' : state.snapshot?.listing ? 'waiting for the listing' : 'idle';
  const rows = shown.map((s, i) => {
    const lead = [` ${String(i + 1).padStart(numWidth)} `, st.dim];
    if (!s) return compose([lead, ['  '], [idle, st.dim]], limit);
    const name = classWidth > 0 ? [[` ${(s.sizeClass ?? '').padEnd(classWidth)}`, st.dim]] : [];
    const percent = `${Math.round(num(s.percent))}%`.padStart(4);
    if (s.state === 'running') {
      const extra = columns.slice(0, kept).flatMap((c, k) => {
        const text = c.text(s);
        return [['   '], [right(k) ? text.padStart(c.width) : text.padEnd(c.width), k === 3 && s.attempt > 1 ? st.yellow : undefined]];
      });
      return compose([lead, [sym.run, st.cyan], [` ${chunkId(s.id)}`], ...name, [' '], ...progressBar(barWidth, num(s.percent) / 100, st, sym), [` ${percent}`, st.bold], ...extra], limit);
    }
    const [symbol, tone, text] = OUTCOMES[s.outcome] ?? ['fail', 'red', s.outcome ?? 'ended'];
    const filled = clamp(Math.round((num(s.percent) / 100) * barWidth), 0, barWidth);
    const bar = [[sym.barFull.repeat(filled), st.dim], [sym.barEmpty.repeat(barWidth - filled), st.dim]];
    const what = fitting([`${text} ${duration(num(s.agoSeconds))} ago`, `copied ${formatCount(s.copied)}`, `failed ${formatCount(s.failed)}`], limit - fixed - barWidth - 3, ' · ');
    return compose([lead, [sym[symbol], st[tone]], [` ${chunkId(s.id)}`, st.dim], ...name, [' '], ...bar, [` ${percent}`, st.dim], ['   '], [what, st.dim]], limit);
  });
  if (slots.length > shown.length) {
    const hidden = slots.slice(shown.length);
    const more = hidden.filter((s) => s?.state === 'running').length;
    rows.push(compose([[` +${more > 0 ? `${formatCount(more)} more running` : `${formatCount(hidden.length)} more slot(s)`}`, st.dim]], limit));
  }
  return rows;
}

/** The classes of the table: the size classes in their order with the numbers of the snapshot, then any other. */
function classRows(state) {
  const defs = state.sizeClasses ?? [];
  const stats = new Map((state.snapshot?.classes ?? []).map((c) => [c.name, c]));
  const empty = { chunks: 0, done: 0, running: 0, pending: 0, exhausted: 0, files: 0, bytes: 0, bytesDone: 0 };
  const rows = defs.map((c, i) => ({ ...empty, ...stats.get(c.name), name: c.name, range: rangeText(defs, i), atOnce: c.concurrency }));
  for (const [name, c] of stats) if (!defs.some((d) => d.name === name)) rows.push({ ...empty, ...c, range: '?', atOnce: undefined });
  return rows;
}

/** The size-class table: a header and a row per class, its columns dropped from the right of the list below until it fits. */
function classTable(classes, { limit, st, sym }) {
  const copied = (c) => (c.bytes > 0 ? `${Math.floor((c.bytesDone / c.bytes) * 100)}%` : '—');
  const columns = [
    { title: 'class', value: (c) => c.name, left: true },
    { title: 'size', value: (c) => c.range, left: true, optional: 1 },
    { title: 'at once', value: (c) => (c.atOnce === undefined ? '?' : formatCount(c.atOnce)), optional: 2 },
    { title: 'chunks', value: (c) => formatCount(c.chunks) },
    { title: `${sym.ok} done`, value: (c) => formatCount(c.done), style: st.green },
    { title: `${sym.run} run`, value: (c) => formatCount(c.running), style: st.cyan },
    { title: 'pending', value: (c) => formatCount(c.pending) },
    { title: 'objects', value: (c) => formatCount(c.files), optional: 3 },
    { title: 'data', value: (c) => formatBytes(c.bytes) },
    { title: 'copied', value: (c) => copied(c), style: st.bold },
  ].map((col) => ({ ...col, width: Math.max(col.title.length, ...classes.map((c) => col.value(c).length)) }));
  let shown = columns;
  const width = (cols) => cols.reduce((sum, col) => sum + 2 + col.width, 0) - 1;
  for (const drop of [1, 2, 3]) if (width(shown) > limit) shown = shown.filter((col) => col.optional !== drop);
  const cell = (col, text) => (col.left ? text.padEnd(col.width) : text.padStart(col.width));
  const line = (parts) => compose(parts.flatMap((p, i) => [[i === 0 ? ' ' : '  '], p]), limit);
  return [
    line(shown.map((col) => [cell(col, col.title), st.dim])),
    ...classes.map((c) => line(shown.map((col) => [cell(col, col.value(c)), col.style]))),
  ];
}

/** The size classes on one line, when rows are short: `classes   very-small 120 (40 ✔) · small 50 (2 ✔)`. */
function classLine(classes, { limit, st, sym }) {
  const pieces = classes.map((c) => `${c.name} ${formatCount(c.chunks)} (${formatCount(c.done)} ${sym.ok})`);
  return compose([label('classes', st), [fitting(pieces, limit - LABEL - 1, ' · ')]], limit);
}

const LOG_STYLES = { WARN: 'yellow', ERROR: 'red', FAIL: 'red' };

/** The last `count` lines of the log, oldest first. */
function logRows(state, count, { limit, st, sym }) {
  return (state.log ?? []).slice(-count).map(({ time, level, text }) => {
    const tone = st[LOG_STYLES[level]] ?? ((t) => t);
    const tag = level === 'FAIL' ? `${sym.fail} ` : level === 'WARN' || level === 'ERROR' ? `${level} ` : '';
    return compose([[` ${clock(time)}  `, st.dim], [tag, tone], [text, tone]], limit);
  });
}

const logTitle = (state) => (state.logFile ? `Log  ${state.logFile}` : 'Log');

/** Exactly `rows` lines: `lines` cut or padded with empty ones. */
const exactly = (lines, rows) => [...lines.slice(0, rows), ...Array(Math.max(0, rows - lines.length)).fill('')];

/**
 * The lines of one frame, exactly `rows` of them, none wider than `columns - 1`.
 *
 *   state    the state of renderMigrationDashboard, and
 *              slots          [slot or null] (see slotRows), one per worker
 *              sizeClasses    the size classes of the migration (none: uniform chunks)
 *              log            [{ time (ms), level (INFO, WARN, ERROR, FAIL), text }], oldest first
 *            and in `snapshot` the `classes` and `averageThroughput` of MigrationProgress.
 *   options  { columns, rows, color, unicode }
 */
export function renderMigrationScreen(state, { columns = 80, rows = DEFAULT_ROWS, color = false, unicode = true } = {}) {
  const st = createStyle(color);
  const sym = symbolsFor(unicode);
  const limit = Math.max(1, columns - 1);
  const ctx = { limit, columns, st, sym };

  if (columns < WIDE_MIN || rows < SCREEN_MIN_ROWS) {
    const lines = renderMigrationDashboard({ ...state, result: undefined }, { columns, color, unicode }).slice(0, rows);
    const left = rows - lines.length;
    if (left >= 2) lines.push(rule(logTitle(state), limit, st, sym), ...logRows(state, left - 1, ctx));
    return exactly(lines, rows);
  }

  const lines = [...header(state, ctx), ...overallPanel(state, ctx)];
  const parallel = state.slots?.length ?? 0;
  const classes = state.sizeClasses ? classRows(state) : [];
  let room = rows - lines.length - 1 - MIN_LOG_ROWS; // the log has a rule and at least 3 rows

  if (parallel > 0) {
    const count = Math.min(parallel, Math.max(1, room - 1 - (classes.length > 0 ? 1 : 0)));
    lines.push(rule(`Chunks being copied (${formatCount(parallel)} worker${parallel === 1 ? '' : 's'})`, limit, st, sym), ...slotRows(state, count, ctx));
    room -= 1 + count;
  }
  if (classes.length > 0) {
    if (room >= 2 + classes.length) {
      lines.push(rule('Size classes', limit, st, sym), ...classTable(classes, ctx));
      room -= 2 + classes.length;
    } else if (room >= 1) {
      lines.push(classLine(classes, ctx));
      room -= 1;
    }
  }
  const logCount = rows - lines.length - 1;
  lines.push(rule(logTitle(state), limit, st, sym), ...logRows(state, logCount, ctx));
  return exactly(lines, rows);
}
