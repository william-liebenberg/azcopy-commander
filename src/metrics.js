import { formatBytes, formatCount, formatDuration } from './format.js';

const WINDOW_MS = 60_000; // throughput is averaged over the last minute
const num = (v) => Number(v) || 0; // azcopy serialises its counters as JSON strings

/** Turns azcopy job summaries (the payload of Progress / EndOfJob messages) into display counters. */
export class Metrics {
  constructor(now = Date.now()) {
    this.startedAt = now;
    this.summary = null; // latest azcopy summary
    this.samples = []; // [timestamp, bytesTransferred] within WINDOW_MS
  }

  update(summary, now = Date.now()) {
    this.summary = summary;
    this.samples.push([now, num(summary.TotalBytesTransferred)]);
    // Drop samples older than the window but always keep two, so a rate can still be computed.
    while (this.samples.length > 2 && now - this.samples[0][0] > WINDOW_MS) this.samples.shift();
  }

  snapshot(now = Date.now()) {
    const s = this.summary ?? {};
    const bytesDone = num(s.TotalBytesTransferred);
    const bytesTotal = num(s.TotalBytesExpected);
    const scanning = !s.CompleteJobOrdered; // azcopy is still listing the source: totals keep growing

    const [t0, b0] = this.samples[0] ?? [now, 0];
    const [t1, b1] = this.samples.at(-1) ?? [now, 0];
    const throughput = t1 > t0 ? Math.max(0, ((b1 - b0) / (t1 - t0)) * 1000) : 0;

    return {
      scanning,
      discovered: num(s.TotalTransfers),
      copied: num(s.TransfersCompleted),
      failed: num(s.TransfersFailed),
      ignored: num(s.TransfersSkipped),
      bytesDone,
      bytesTotal,
      percent: bytesTotal > 0 ? Math.min(100, (bytesDone / bytesTotal) * 100) : 0,
      throughput,
      // An ETA is only meaningful once the total is known, i.e. after scanning has finished.
      etaSeconds: !scanning && throughput > 0 ? Math.max(0, bytesTotal - bytesDone) / throughput : NaN,
      elapsedSeconds: (now - this.startedAt) / 1000,
    };
  }
}

export function formatSnapshot(snap) {
  return [
    snap.scanning ? 'SCANNING+COPYING' : 'COPYING',
    `discovered ${formatCount(snap.discovered)}`,
    `copied ${formatCount(snap.copied)}`,
    `failed ${formatCount(snap.failed)}`,
    `ignored ${formatCount(snap.ignored)}`,
    `${formatBytes(snap.bytesDone)} / ${formatBytes(snap.bytesTotal)}${snap.scanning ? '+' : ''} (${snap.percent.toFixed(1)}%)`,
    `${formatBytes(snap.throughput)}/s`,
    `ETA ${snap.scanning ? 'after scan' : formatDuration(snap.etaSeconds)}`,
    `elapsed ${formatDuration(snap.elapsedSeconds)}`,
  ].join(' | ');
}
