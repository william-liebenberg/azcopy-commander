/** Shortens `text` to `width` characters by replacing the middle with an ellipsis. */
export function fit(text, width) {
  const s = String(text);
  if (s.length <= width) return s;
  if (width <= 1) return s.slice(0, Math.max(width, 0));
  const keepEnd = Math.ceil((width - 1) / 2);
  const keepStart = width - 1 - keepEnd;
  return `${s.slice(0, keepStart)}…${s.slice(s.length - keepEnd)}`;
}

/** Colour on a terminal, unless NO_COLOR is set; FORCE_COLOR (other than 0 / false) turns it on anywhere. */
export function colorEnabled(stream, env = process.env) {
  if (env.NO_COLOR) return false;
  if (env.FORCE_COLOR !== undefined && env.FORCE_COLOR !== '') return !/^(0|false)$/i.test(env.FORCE_COLOR);
  return Boolean(stream?.isTTY) && env.TERM !== 'dumb';
}

/** Whether the terminal can show the unicode symbols (the same rule the @clack/prompts symbols follow). */
export function unicodeSupported(env = process.env, platform = process.platform) {
  if (platform !== 'win32') return env.TERM !== 'linux';
  return Boolean(env.WT_SESSION || env.TERMINUS_SUBLIME || env.ConEmuTask === '{cmd::Cmder}' || env.TERM_PROGRAM === 'Terminus-Sublime' || env.TERM_PROGRAM === 'vscode' || env.TERM === 'xterm-256color' || env.TERM === 'alacritty' || env.TERMINAL_EMULATOR === 'JetBrains-JediTerm');
}

const ANSI = { bold: [1, 22], dim: [2, 22], red: [31, 39], green: [32, 39], yellow: [33, 39], cyan: [36, 39] };

/** `{ green, yellow, red, dim, bold, cyan }`: functions that wrap text in colour codes, or return it unchanged. */
export function createStyle(color) {
  return Object.fromEntries(Object.entries(ANSI).map(([name, [open, close]]) => [name, color ? (text) => `\x1b[${open}m${text}\x1b[${close}m` : (text) => String(text)]));
}

const UNICODE_SYMBOLS = {
  ok: '✔', ignored: '↷', fail: '✖', arrow: '→',
  barFull: '█', barEmpty: '░', bar: '│', step: '◇', end: '◆',
  spinner: ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'],
  spark: ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'],
};
const ASCII_SYMBOLS = {
  ok: '*', ignored: '-', fail: 'x', arrow: '->',
  barFull: '#', barEmpty: '.', bar: '|', step: 'o', end: '*',
  spinner: ['|', '/', '-', '\\'],
  spark: ['_', '.', '-', '~', '=', '+', '*', '#'],
};

export const symbolsFor = (unicode) => (unicode ? UNICODE_SYMBOLS : ASCII_SYMBOLS);

// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b\[[0-9;?]*[A-Za-z]/g;
/** The text as it shows on screen: without colour and cursor sequences. */
export const visible = (text) => String(text).replace(ANSI_RE, '');
