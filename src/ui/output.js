/*
 * Flicker fix. On every keypress @clack/prompts redraws its block with several separate writes
 * (move the cursor up, erase, draw the new frame, ...). The terminal paints between those writes,
 * which shows as flicker, most visibly on Windows. `coalescedOutput` collects the writes made in
 * one tick and sends them as a single write, wrapped in the "synchronized output" mode (DEC 2026)
 * that terminals supporting it use to paint the whole update at once; others ignore it.
 */

const BEGIN_SYNC = '\x1b[?2026h';
const END_SYNC = '\x1b[?2026l';

export function coalescedOutput(stream, { synchronized = true } = {}) {
  let pending = [];

  const flush = () => {
    if (pending.length === 0) return;
    const data = pending.join('');
    pending = [];
    stream.write(synchronized ? `${BEGIN_SYNC}${data}${END_SYNC}` : data);
  };

  const write = (chunk, encoding, callback) => {
    pending.push(String(chunk));
    if (pending.length === 1) queueMicrotask(flush);
    const done = typeof encoding === 'function' ? encoding : callback;
    done?.();
    return true;
  };

  // Everything except write() (columns, rows, isTTY, resize listeners, ...) goes straight to the real stream.
  return new Proxy(stream, {
    get(target, prop) {
      if (prop === 'write') return write;
      const value = Reflect.get(target, prop, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

/** The prompts that redraw on keypresses, each given the coalescing output stream. */
const REDRAWING = ['select', 'text', 'password', 'confirm'];

export function withCoalescedOutput(prompts, stream, options) {
  const output = coalescedOutput(stream, options);
  const wrapped = Object.create(prompts);
  for (const name of REDRAWING) {
    if (typeof prompts[name] === 'function') wrapped[name] = (opts) => prompts[name]({ output, ...opts });
  }
  return wrapped;
}
