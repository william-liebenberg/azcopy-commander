import { formatBytes } from './format.js';

/*
 * The throughput of one copy attempt, measured from the ends of its objects (no timer):
 *   windows      the attempt's time cut into windows of `windowMs` from its start; each copied object adds its bytes to
 *                the window in which it ends, and a window in which none ends counts as 0 B/s. The last window is
 *                usually incomplete: it is left out of min/max.
 *   per object   an object's size divided by the time of its copy, for copied objects of more than 0 bytes.
 * The average is the bytes copied divided by the attempt's elapsed time. Large objects make the windows bursty (their
 * bytes count when they end): the per-object rates are the figures to read there.
 */

export const WINDOW_MS = 10_000; // the same window as the dashboard's chunk speed

const perSecond = (bytes, ms) => bytes / (Math.max(1, ms) / 1000); // at least 1 ms: an instant copy is not infinitely fast

export class ThroughputMeter {
  constructor({ startedAt, windowMs = WINDOW_MS }) {
    this.startedAt = startedAt;
    this.windowMs = windowMs;
    this.windowBytes = new Map(); // window index -> bytes of the objects that ended in it
    this.bytes = 0;
    this.objects = { count: 0, min: Infinity, sum: 0, max: 0 };
  }

  /** A copied object of `bytes`, whose copy ran from `startedAt` to `endedAt` (ms). */
  object(bytes, startedAt, endedAt) {
    if (!(bytes > 0)) return;
    this.bytes += bytes;
    const i = Math.floor(Math.max(0, endedAt - this.startedAt) / this.windowMs);
    this.windowBytes.set(i, (this.windowBytes.get(i) ?? 0) + bytes);
    const rate = perSecond(bytes, endedAt - startedAt);
    const o = this.objects;
    o.count++;
    o.sum += rate;
    o.min = Math.min(o.min, rate);
    o.max = Math.max(o.max, rate);
  }

  /**
   * The summary at `endedAt` (ms), in bytes per second, rounded, or null when nothing was copied:
   * `{ seconds, bytesPerSecond, windowSeconds, windows?: { count, min, max }, objects?: { count, min, avg, max } }`.
   * `windows` is left out when the attempt lasted less than one full window.
   */
  finish(endedAt) {
    if (this.bytes === 0) return null;
    const elapsed = Math.max(1, endedAt - this.startedAt);
    const summary = { seconds: Math.round(elapsed / 100) / 10, bytesPerSecond: Math.round(perSecond(this.bytes, elapsed)), windowSeconds: this.windowMs / 1000 };
    const full = Math.floor(elapsed / this.windowMs);
    if (full > 0) {
      let [min, max] = [Infinity, 0];
      for (let i = 0; i < full; i++) {
        const r = perSecond(this.windowBytes.get(i) ?? 0, this.windowMs);
        [min, max] = [Math.min(min, r), Math.max(max, r)];
      }
      summary.windows = { count: full, min: Math.round(min), max: Math.round(max) };
    }
    const o = this.objects;
    if (o.count > 0) summary.objects = { count: o.count, min: Math.round(o.min), avg: Math.round(o.sum / o.count), max: Math.round(o.max) };
    return summary;
  }
}

const rate = (bytesPerSecond) => `${formatBytes(bytesPerSecond)}/s`;

/** "48.20 MiB/s (10 s min 0 B/s, max 112.00 MiB/s; per object min 1.20 MiB/s, avg 5.40 MiB/s, max 30.10 MiB/s)", '' for null. */
export function throughputText(t) {
  if (!t) return '';
  const parts = [];
  if (t.windows) parts.push(`${t.windowSeconds} s min ${rate(t.windows.min)}, max ${rate(t.windows.max)}`);
  if (t.objects) parts.push(`per object min ${rate(t.objects.min)}, avg ${rate(t.objects.avg)}, max ${rate(t.objects.max)}`);
  return `${rate(t.bytesPerSecond)}${parts.length > 0 ? ` (${parts.join('; ')})` : ''}`;
}
