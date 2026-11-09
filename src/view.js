import { formatSnapshot } from './metrics.js';
import { formatBytes, formatCount, formatDuration } from './format.js';

/**
 * The lines of the final "Copy summary", derived from a job report. They go to the copy log and to
 * the plain view, so the file and the console say the same thing.
 */
export function summaryLines(report, hints = {}) {
  const lines = [
    '',
    '================ Copy summary ================',
    `Status:           ${report.jobStatus}${report.outcome === 'failed' && report.lastError ? ` (${report.lastError})` : ''}`,
    `Files discovered: ${formatCount(report.discovered)}`,
    `Files copied:     ${formatCount(report.copied)}`,
    `Files failed:     ${formatCount(report.failed)}`,
    `Files ignored:    ${formatCount(report.ignored)}  (skipped by azcopy, e.g. already at the target)`,
    `Data copied:      ${formatBytes(report.bytesCopied)} of ${formatBytes(report.bytesExpected)}`,
    `Elapsed:          ${formatDuration(report.elapsedSeconds)}`,
    `Copy log:         ${report.files.log}`,
  ];
  if (report.files.failed) lines.push(`Failed list:      ${report.files.failed}`, `Retry failures:   ${hints.retry}`);
  if (report.jobId && (report.outcome === 'interrupted' || report.outcome === 'failed')) lines.push(`Resume:           ${hints.resume}`);
  return lines;
}

/**
 * What `runJob` shows while a job runs. `PlainView` is the output of the command line: lines for scripts
 * and logs, and on a terminal one status line redrawn in place. Another view (the wizard's dashboard)
 * implements the same methods:
 *
 *   start({ logFile })        the job is about to start
 *   jobStarted(jobId)         azcopy reported its job id
 *   progress(snapshot, opts)  a Metrics snapshot; opts.periodic is true about every 30 s
 *   message(level, text)      a warning or error (already redacted)
 *   failure(relativePath, errorCode)  one more failed file
 *   log(level, text)          an azcopy message that is only logged (Info, stderr, ...); already redacted
 *   summary(report, hints)    the job is over
 *   close()                   release timers / the cursor; always called, also after an error
 */
export class PlainView {
  constructor(out) {
    this.out = out;
    this.statusShown = false;
  }

  print(text) {
    if (this.statusShown) this.out.write('\r\x1b[K');
    this.statusShown = false;
    this.out.write(`${text}\n`);
  }

  status(text) {
    if (!this.out.isTTY) return;
    const width = (this.out.columns ?? 160) - 1;
    this.out.write(`\r\x1b[K${text.slice(0, width)}`);
    this.statusShown = true;
  }

  start({ logFile }) {
    this.print(`Copy log: ${logFile}`);
  }

  jobStarted(jobId) {
    this.print(`Job ID: ${jobId}`);
  }

  progress(snapshot, { periodic = false } = {}) {
    const line = formatSnapshot(snapshot);
    this.status(line);
    if (periodic && !this.out.isTTY) this.print(line); // no live line without a terminal: print one periodically instead
  }

  message(level, text) {
    this.print(text);
  }

  failure() {}

  log() {} // the plain output stays as it is: these lines are in the copy log

  summary(report, hints) {
    summaryLines(report, hints).forEach((l) => this.print(l));
  }

  close() {}
}
