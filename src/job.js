import fs from 'node:fs';
import path from 'node:path';
import { once } from 'node:events';
import { startAzcopy, captureAzcopy } from './runner.js';
import { Metrics, formatSnapshot } from './metrics.js';
import { fileTimestamp } from './format.js';
import { relativeSourcePath } from './urls.js';
import { PlainView, summaryLines } from './view.js';

export const EXIT = { OK: 0, PARTIAL: 1, FAILED: 2, USAGE: 64, INTERRUPTED: 130 };

const METRICS_LOG_INTERVAL_MS = 30_000;

// azcopy's final JobStatus -> our outcome. Any status not listed here (Failed, Cancelled, ...) is "failed".
// "NothingToCopy" and "Interrupted" are statuses we assign ourselves.
const OUTCOME = {
  Completed: 'success',
  CompletedWithSkipped: 'success',
  NothingToCopy: 'success',
  CompletedWithErrors: 'partial',
  CompletedWithErrorsAndSkipped: 'partial',
  Interrupted: 'interrupted',
};
const EXIT_BY_OUTCOME = { success: EXIT.OK, partial: EXIT.PARTIAL, failed: EXIT.FAILED, interrupted: EXIT.INTERRUPTED };

const endAndWait = (stream) => {
  stream.end();
  return once(stream, 'close');
};

/**
 * Runs one azcopy job (copy or resume) and does the bookkeeping around it:
 *   - live progress on the console, periodic metrics lines in the log
 *   - copy-<ts>.log      timestamped log of azcopy messages, metrics, failures and the final summary
 *   - failed-<ts>.jsonl  one record per failed file (used by `retry`); removed when nothing failed
 * Returns a report object (counters, outcome, exit code, file paths).
 *
 * `hints` = { resume, retry }: command lines shown to the user when relevant.
 * `view` shows progress and the result (see view.js); by default the plain console output on `out`.
 */
export async function runJob(options) {
  const view = options.view ?? new PlainView(options.out ?? process.stdout);
  try {
    return await runJobWithView({ ...options, view });
  } finally {
    view.close();
  }
}

async function runJobWithView({ runDir, command, args, env, redactor, bucket, prefix, hints = {}, view }) {
  const stamp = fileTimestamp();
  const logFile = path.join(runDir, `copy-${stamp}.log`);
  const failedFile = path.join(runDir, `failed-${stamp}.jsonl`);
  const logStream = fs.createWriteStream(logFile);
  const failedStream = fs.createWriteStream(failedFile);
  const log = (level, msg) => logStream.write(`${new Date().toISOString()} ${level.padEnd(5)} ${redactor.redact(msg)}\n`);
  const show = (level, msg) => {
    log(level, msg);
    view.message(level, redactor.redact(msg));
  };

  const metrics = new Metrics();
  const failedSources = new Set(); // a failure can be reported twice (progress + jobs show)
  let jobId = null;
  let endOfJob = null; // final azcopy summary, when azcopy got as far as sending it
  let lastError = null;
  let nothingToCopy = false;
  let interrupted = false;
  let lastMetricsLog = 0;

  const recordFailure = (t) => {
    if (t.IsFolderProperties || failedSources.has(t.Src)) return;
    failedSources.add(t.Src);
    const relativePath = relativeSourcePath(t.Src, { bucket, prefix });
    // Query strings are cut off: they could carry credentials and are not needed to retry.
    const record = { relativePath, src: t.Src.split('?')[0], dst: (t.Dst ?? '').split('?')[0], errorCode: t.ErrorCode, size: t.TransferSize };
    failedStream.write(`${JSON.stringify(record)}\n`);
    log('ERROR', `FAILED ${relativePath} (errorCode=${t.ErrorCode ?? 'n/a'})`);
    view.failure(relativePath, t.ErrorCode);
  };

  // Progress and EndOfJob carry the same JobSummary. Its FailedTransfers lists the failures since the
  // previous summary, so each failure normally arrives once.
  const onSummary = (summary) => {
    metrics.update(summary);
    (summary.FailedTransfers ?? []).forEach(recordFailure);
    const snapshot = metrics.snapshot();
    const periodic = Date.now() - lastMetricsLog >= METRICS_LOG_INTERVAL_MS;
    view.progress(snapshot, { periodic });
    if (periodic) {
      lastMetricsLog = Date.now();
      log('STATS', formatSnapshot(snapshot));
    }
  };

  const onMessage = (m) => {
    switch (m.type) {
      case 'Init':
        jobId = m.data?.JobID ?? jobId;
        log('INFO', `azcopy job ${jobId}, azcopy log: ${m.data?.LogFileLocation}`);
        view.jobStarted(jobId);
        break;
      case 'Progress':
        if (m.data) onSummary(m.data);
        break;
      case 'EndOfJob':
        if (m.data) {
          endOfJob = m.data;
          onSummary(m.data);
        }
        break;
      case 'Error':
        lastError = m.text;
        // A delta run with no matching objects makes azcopy report an error; for us that is a normal outcome.
        nothingToCopy ||= /no transfers were scheduled/i.test(m.text);
        show('ERROR', `azcopy: ${m.text}`);
        break;
      case 'Warning':
        show('WARN', `azcopy: ${m.text}`);
        break;
      default:
        log(m.type.toUpperCase(), m.text); // Info, Prompt, Raw, ...
        view.log(m.type.toUpperCase(), redactor.redact(m.text));
    }
  };

  log('INFO', `run directory: ${runDir}`);
  log('INFO', `command: ${[command.bin, ...(command.prefixArgs ?? []), ...args].join(' ')}`);
  view.start({ logFile });

  const onStderr = (l) => {
    log('STDERR', l);
    view.log('STDERR', redactor.redact(l));
  };
  const { child, done } = startAzcopy({ command, args, env, onMessage, onStderr });
  // Ctrl+C: ask azcopy to stop (its job plan stays on disk, so `resume` can continue) and wait for it to exit.
  const onSigint = () => {
    interrupted = true;
    show('WARN', 'Interrupt received - stopping azcopy...');
    child.kill('SIGINT');
  };
  process.on('SIGINT', onSigint);
  const result = await done;
  process.off('SIGINT', onSigint);

  if (result.error) {
    lastError = `Could not start azcopy: ${result.error.message} (install it from https://aka.ms/downloadazcopy or use --azcopy-path)`;
    show('ERROR', lastError);
  }

  // Safety net: if azcopy counted more failures than we received (e.g. it crashed mid-run), ask it for
  // the authoritative list of failed transfers.
  const countedFailures = metrics.snapshot().failed;
  if (jobId && !interrupted && countedFailures > failedSources.size) {
    log('INFO', `failure counter ${countedFailures} > ${failedSources.size} recorded; running "azcopy jobs show"`);
    const shown = await captureAzcopy({ command, args: ['jobs', 'show', jobId, '--with-status=Failed', '--output-type', 'json'], env });
    // `jobs show` answers with a transfer list in `Details`
    shown.messages.forEach((m) => (m.data?.Details ?? []).forEach(recordFailure));
  }

  await endAndWait(failedStream);
  const snap = metrics.snapshot();
  const failed = Math.max(snap.failed, failedSources.size);
  if (failed === 0) fs.rmSync(failedFile, { force: true });

  let jobStatus;
  if (interrupted) jobStatus = 'Interrupted';
  else if (endOfJob) jobStatus = endOfJob.JobStatus;
  else if (nothingToCopy) jobStatus = 'NothingToCopy';
  else jobStatus = result.code === 0 ? 'Completed' : 'Failed';
  let outcome = OUTCOME[jobStatus] ?? 'failed';
  if (outcome === 'success' && failed > 0) outcome = 'partial';

  const report = {
    outcome,
    jobStatus,
    jobId,
    exitCode: EXIT_BY_OUTCOME[outcome],
    lastError: lastError && redactor.redact(lastError),
    discovered: snap.discovered,
    copied: snap.copied,
    failed,
    ignored: snap.ignored,
    bytesCopied: snap.bytesDone,
    bytesExpected: snap.bytesTotal,
    elapsedSeconds: Math.round(snap.elapsedSeconds),
    files: { log: logFile, failed: failed > 0 ? failedFile : null },
  };

  summaryLines(report, hints).forEach((l) => log('INFO', l));
  view.summary(report, hints);
  await endAndWait(logStream);
  return report;
}
