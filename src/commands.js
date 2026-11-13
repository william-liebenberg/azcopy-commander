import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import readline from 'node:readline/promises';
import { buildSourceUrl, buildTargetBase, buildTargetUrl, normalizePrefix, parseBucketInput, parseTargetSasUrl, Redactor } from './urls.js';
import { parseLastCopyDate, toAzcopyDate } from './dates.js';
import { runJob, EXIT } from './job.js';
import { azcopyProvider, InventoryError } from './inventory.js';
import { readState, saveState, stateKey } from './state.js';
import { fileTimestamp, formatBytes, formatCount } from './format.js';
import { UsageError } from './errors.js';

export { UsageError };

const CLI = 'azcopy-commander';
// `--last-copy-date auto` starts this long before the previous run began, to cover files that were
// being written while that run listed the bucket. Re-copying the overlap is harmless: existing blobs are skipped.
const AUTO_OVERLAP_MS = 10 * 60_000;

export const outputRoot = (opts) => path.resolve(opts.outputDir ?? 'runs');
export const stateFile = (opts) => path.join(outputRoot(opts), 'state.json');
const newRunDir = (opts, kind) => path.join(outputRoot(opts), `${fileTimestamp()}-${kind}`);

function required(value, name) {
  if (!value) throw new UsageError(`Missing required option --${name}`);
  return value;
}

/** `--source-bucket` is a bucket name or an S3 bucket / object ARN; an ARN's prefix and `--source-prefix` must not disagree. */
export function resolveSource(opts) {
  const parsed = parseBucketInput(required(opts.sourceBucket, 'source-bucket'));
  const typed = normalizePrefix(opts.sourcePrefix);
  if (parsed.prefix && typed && parsed.prefix !== typed) {
    throw new UsageError(`--source-bucket ARN has the prefix "${parsed.prefix}" but --source-prefix is "${typed}": use only one.`);
  }
  return { bucket: parsed.bucket, prefix: typed || parsed.prefix };
}

export function readTarget(opts, redactor, out) {
  const raw = opts.targetSasUrl ?? process.env.AZCOPY_COMMANDER_TARGET_SAS_URL;
  if (!raw) throw new UsageError('Missing --target-sas-url (or env AZCOPY_COMMANDER_TARGET_SAS_URL).');
  const target = parseTargetSasUrl(raw);
  redactor.add(target.query, target.sig);
  target.warnings.forEach((w) => out.write(`WARNING: ${w}\n`));
  return target;
}

/** Flags every azcopy invocation gets. WARNING keeps azcopy's own log small at this scale; override with --azcopy-arg. */
export const azcopyFlags = (opts, logLevel = 'WARNING') => ['--output-type', 'json', '--log-level', logLevel, ...(opts.azcopyArg ?? [])];

export const azcopyCommand = (opts) => opts.azcopyCommand ?? { bin: opts.azcopyPath ?? 'azcopy', prefixArgs: [] }; // azcopyCommand: test hook

export function requireAwsCredentials(redactor) {
  if (!process.env.AWS_ACCESS_KEY_ID || !process.env.AWS_SECRET_ACCESS_KEY) {
    throw new UsageError('Set AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY in the environment (they are never accepted as arguments).');
  }
  redactor.add(process.env.AWS_SECRET_ACCESS_KEY, process.env.AWS_SESSION_TOKEN);
}

export function copyArgs({ source, dest, includeAfter, listFile, overwriteModified, listOnly }, opts) {
  return [
    'copy', source, dest,
    '--from-to', 'S3Blob',
    '--recursive',
    // Append-only by default: never touch a blob that already exists.
    // Opt-in: replace an existing blob only if the S3 object is newer.
    overwriteModified ? '--overwrite=ifSourceNewer' : '--overwrite=false',
    // Without this azcopy would add the source folder name again: <container>/<prefix>/<prefix>/<key>.
    '--as-subdir=false',
    ...(includeAfter ? ['--include-after', includeAfter] : []),
    ...(listFile ? ['--list-of-files', listFile] : []),
    // listOnly: azcopy prints what it would copy and transfers nothing; its own log is switched off so nothing is saved.
    ...(listOnly ? ['--dry-run'] : []),
    ...azcopyFlags(opts, listOnly ? 'NONE' : 'WARNING'),
  ];
}

const writeManifest = (m) => fs.writeFileSync(path.join(m.runDir, 'run.json'), `${JSON.stringify(m, null, 2)}\n`);

export function readManifest(runDir) {
  const file = path.join(runDir, 'run.json');
  if (!fs.existsSync(file)) throw new UsageError(`${file} not found: --run must be a run directory created by this tool.`);
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

/** The newest run directory (run directory names start with a sortable UTC timestamp) in the output directory. */
function latestRunDir(opts) {
  const root = outputRoot(opts);
  const names = fs.existsSync(root) ? fs.readdirSync(root) : [];
  const runs = names.filter((n) => /^\d{8}T\d{6}Z-/.test(n) && fs.existsSync(path.join(root, n, 'run.json'))).sort();
  return runs.length ? path.join(root, runs.at(-1)) : null;
}

const RUN_DIR_RE = /^(\d{8}T\d{6}Z)-(.+)$/;

/**
 * Every earlier run in the output directory (folders `<timestamp>-<kind>` with a run.json), newest first:
 * `{ dir, kind: 'full' | 'delta' | 'retry', startedAt, outcome, copied, failed, jobId, bucket, prefix,
 *    region, targetBase, overwriteModified }`. `region` is '' for the global S3 endpoint.
 */
export function listRuns(opts = {}) {
  const root = outputRoot(opts);
  const names = fs.existsSync(root) ? fs.readdirSync(root) : [];
  return names
    .filter((n) => RUN_DIR_RE.test(n))
    .sort()
    .reverse()
    .flatMap((name) => {
      const dir = path.join(root, name);
      let m;
      try {
        m = JSON.parse(fs.readFileSync(path.join(dir, 'run.json'), 'utf8'));
      } catch {
        return []; // no run.json (or not readable): not a run of this tool
      }
      return [{
        dir,
        kind: RUN_DIR_RE.exec(name)[2],
        startedAt: m.startedAt,
        outcome: m.outcome ?? 'unknown',
        copied: m.summary?.copied ?? 0,
        failed: m.summary?.failed ?? 0,
        jobId: m.jobId ?? null,
        bucket: m.bucket,
        prefix: m.prefix ?? '',
        region: /^s3\.([a-z0-9-]+)\.amazonaws\.com$/.exec(safeHost(m.sourceBase))?.[1] ?? '',
        targetBase: m.targetBase,
        overwriteModified: Boolean(m.overwriteModified),
      }];
    });
}

function safeHost(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

/** The delta baseline for a run: its start minus the same overlap `--last-copy-date auto` uses. */
export const deltaDateFor = (run) => new Date(Date.parse(run.startedAt) - AUTO_OVERLAP_MS);

export async function askYesNo(question) {
  if (!process.stdin.isTTY) throw new UsageError('No terminal to confirm the latest run: pass --run <run dir>, or --yes to accept the latest run.');
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    return /^y(es)?$/i.test((await rl.question(question)).trim());
  } finally {
    rl.close();
  }
}

/**
 * The run directory `retry` / `resume` work on: --run, or else the latest run in the output directory
 * after the user confirms it (--yes skips the question). `opts.confirm` is a test hook.
 */
async function resolveRunDir(opts, out, action) {
  if (opts.run) return path.resolve(opts.run);
  const dir = latestRunDir(opts);
  if (!dir) throw new UsageError(`No earlier run found in ${outputRoot(opts)}: pass --run <run dir>.`);
  const m = readManifest(dir);
  const failed = m.summary ? `, ${m.summary.failed} failed file(s)` : '';
  out.write(`Latest run: ${dir}\n  ${m.kind}, started ${m.startedAt}, outcome ${m.outcome ?? 'unknown'}${failed}\n`);
  if (!opts.yes && !(await (opts.confirm ?? askYesNo)(`${action} this run? [y/N] `))) throw new UsageError('Cancelled.');
  return dir;
}

/**
 * Shared tail of copy / retry / resume: print the command (dry run) or run azcopy, then record the
 * result in run.json. `manifest` describes the run (see copyCommand); `prepare` runs once the
 * run directory exists. `signal` (an AbortSignal) stops the job like Ctrl+C when several jobs run in one
 * process (see runJob). Returns the job report, or null for a dry run.
 */
export async function execute({ opts, out, redactor, manifest, args, prepare, signal }) {
  const command = azcopyCommand(opts);
  if (opts.dryRun) {
    out.write(`\nDry run - would execute:\n  ${redactor.redact([command.bin, ...args].join(' '))}\nRun directory: ${manifest.runDir}\n`);
    return null;
  }
  requireAwsCredentials(redactor);

  fs.mkdirSync(manifest.azcopyLogDir, { recursive: true });
  fs.mkdirSync(manifest.planDir, { recursive: true });
  prepare?.();
  // azcopy keeps its job plan files (needed by `resume`) and its own log with the run, not in ~/.azcopy.
  // Tuning variables such as AZCOPY_CONCURRENCY_VALUE / AZCOPY_BUFFER_GB are inherited from the environment.
  const env = { ...process.env, AZCOPY_LOG_LOCATION: manifest.azcopyLogDir, AZCOPY_JOB_PLAN_LOCATION: manifest.planDir };
  writeManifest({ ...manifest, outcome: 'running' });

  const report = await runJob({
    runDir: manifest.runDir,
    command,
    args,
    env,
    redactor,
    bucket: manifest.bucket,
    prefix: manifest.prefix,
    hints: { resume: `${CLI} resume --run "${manifest.runDir}"`, retry: `${CLI} retry --run "${manifest.runDir}"` },
    out,
    view: opts.view,
    signal,
  });
  Object.assign(manifest, { finishedAt: new Date().toISOString(), outcome: report.outcome, jobId: report.jobId ?? manifest.jobId, summary: report });
  writeManifest(manifest);
  return report;
}

export const runPaths = (opts, runDir) => ({
  runDir,
  planDir: path.resolve(opts.planDir ?? path.join(runDir, 'azcopy-plans')),
  azcopyLogDir: path.join(runDir, 'azcopy-logs'),
});

// ---------------------------------------------------------------- copy

/** Resolves --last-copy-date (an ISO date, or "auto") to the instant after which objects are copied. */
export function resolveLastCopyDate(value, { opts, key, now }) {
  if (value !== 'auto') return parseLastCopyDate(value, now);
  const previous = readState(stateFile(opts))[key];
  if (!previous) throw new UsageError('--last-copy-date auto: no earlier run is recorded for this source/target; pass an explicit date.');
  return new Date(Date.parse(previous.startedAt) - AUTO_OVERLAP_MS);
}

export async function copyCommand(opts, out = process.stdout) {
  const redactor = new Redactor();
  const { bucket, prefix } = resolveSource(opts);
  const target = readTarget(opts, redactor, out);
  const sourceBase = buildSourceUrl(bucket, prefix, opts.sourceRegion);
  const destBase = buildTargetBase(target, prefix); // keys keep their layout: <container>/<prefix>/<key>
  const key = stateKey(sourceBase, destBase);
  const startedAt = new Date();
  const overwriteModified = Boolean(opts.overwriteModified);

  // Delta mode = only list objects modified on/after the date. Full mode = everything not already at the target.
  const includeAfter = opts.lastCopyDate ? toAzcopyDate(resolveLastCopyDate(opts.lastCopyDate, { opts, key, now: startedAt })) : null;

  // A view (the wizard's dashboard) comes with a UI that has already shown these facts.
  if (!opts.view) {
    out.write(
      `Source:    ${sourceBase}\nTarget:    ${destBase}\n` +
        `Mode:      ${includeAfter ? `delta (objects modified on/after ${includeAfter})` : 'full (everything not already at the target)'}\n` +
        `Overwrite: ${overwriteModified ? 'only if the S3 object is newer than the blob (--overwrite-modified)' : 'never (append-only)'}; nothing is ever deleted\n`,
    );
  }

  const manifest = {
    kind: 'copy',
    ...runPaths(opts, newRunDir(opts, includeAfter ? 'delta' : 'full')),
    startedAt: startedAt.toISOString(),
    bucket,
    prefix,
    sourceBase,
    targetBase: target.base, // container (+ directory) without SAS or prefix; checked on retry/resume
    destBase,
    includeAfter,
    overwriteModified,
    jobId: null,
  };
  const args = copyArgs({ source: sourceBase, dest: buildTargetUrl(target, prefix), includeAfter, overwriteModified }, opts);
  const report = await execute({ opts, out, redactor, manifest, args });
  if (!report) return EXIT.OK;

  // Failed files are on record in the run directory (see `retry`), so a partial run still moves the delta date forward.
  if (report.outcome === 'success' || report.outcome === 'partial') {
    saveState(stateFile(opts), key, { startedAt: manifest.startedAt, runDir: manifest.runDir });
  }
  return report.exitCode;
}

// ---------------------------------------------------------------- retry

/** Re-copies the files listed in the failed-*.jsonl files of an earlier run, in a new run directory. */
export async function retryCommand(opts, out = process.stdout) {
  const redactor = new Redactor();
  const previousDir = await resolveRunDir(opts, out, 'Retry the failed files of');
  const previous = readManifest(previousDir);
  const target = readTarget(opts, redactor, out);
  if (target.base !== previous.targetBase) {
    throw new UsageError(`Target ${target.base} does not match the original run's target ${previous.targetBase}.`);
  }

  const failedFiles = fs.readdirSync(previousDir).filter((f) => /^failed-.*\.jsonl$/.test(f));
  const paths = new Set(
    failedFiles.flatMap((f) =>
      fs.readFileSync(path.join(previousDir, f), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l).relativePath),
    ),
  );
  if (paths.size === 0) {
    out.write('Nothing to retry: no failed files are recorded for this run.\n');
    return EXIT.OK;
  }
  out.write(`Retrying ${paths.size} failed file(s) from ${previousDir}\n`);

  const manifest = {
    ...previous,
    kind: 'retry',
    retryOf: previousDir,
    ...runPaths(opts, newRunDir(opts, 'retry')),
    startedAt: new Date().toISOString(),
    includeAfter: null, // the list already names exactly the files to copy
    jobId: null,
    finishedAt: undefined,
    summary: undefined,
  };
  const listFile = path.join(manifest.runDir, 'retry-input.txt');
  const args = copyArgs({ source: previous.sourceBase, dest: buildTargetUrl(target, previous.prefix), listFile, overwriteModified: previous.overwriteModified }, opts);
  const report = await execute({ opts, out, redactor, manifest, args, prepare: () => fs.writeFileSync(listFile, `${[...paths].join('\n')}\n`) });
  return report ? report.exitCode : EXIT.OK;
}

// ---------------------------------------------------------------- resume

/** Continues the azcopy job of an interrupted or failed run, using the job plan kept in the run directory. */
export async function resumeCommand(opts, out = process.stdout) {
  const redactor = new Redactor();
  if (opts.overwriteModified) throw new UsageError('--overwrite-modified cannot change an existing job; it is fixed by the original copy.');
  const runDir = await resolveRunDir(opts, out, 'Resume');
  const manifest = readManifest(runDir);
  if (!manifest.jobId) throw new UsageError('This run has no recorded azcopy job; start a new copy instead.');
  if (manifest.outcome === 'success') throw new UsageError('This run already completed successfully.');
  const target = readTarget(opts, redactor, out);
  if (target.base !== manifest.targetBase) {
    throw new UsageError(`Target ${target.base} does not match the original run's target ${manifest.targetBase}.`);
  }

  out.write(`Resuming azcopy job ${manifest.jobId} of ${runDir}\n`);
  // Job plans never store the SAS, so it has to be supplied again.
  const args = ['jobs', 'resume', manifest.jobId, '--destination-sas', `?${target.query}`, ...azcopyFlags(opts)];
  const report = await execute({ opts, out, redactor, manifest, args });
  if (!report) return EXIT.OK;
  if (manifest.kind === 'copy' && (report.outcome === 'success' || report.outcome === 'partial')) {
    saveState(stateFile(opts), stateKey(manifest.sourceBase, manifest.destBase), { startedAt: manifest.startedAt, runDir });
  }
  return report.exitCode;
}

// ---------------------------------------------------------------- list

/**
 * Prints the source objects a copy would transfer, one per line ("s3://bucket/key<TAB>size"), and a
 * count on stderr. Saves nothing: no run directory, manifest or state, and azcopy's own log is off.
 * It uses azcopy's --dry-run, which lists the matching source objects even when they already exist at the target.
 */
export async function listCommand(opts, out = process.stdout, err = process.stderr) {
  const redactor = new Redactor();
  const { bucket, prefix } = resolveSource(opts);
  const target = readTarget(opts, redactor, err); // azcopy needs a destination argument, even to list
  requireAwsCredentials(redactor);
  if (opts.lastCopyDate === 'auto') throw new UsageError('--last-copy-date auto needs saved state, which list does not keep; pass an explicit date.');
  const includeAfter = opts.lastCopyDate ? toAzcopyDate(parseLastCopyDate(opts.lastCopyDate)) : null;
  const args = copyArgs({ source: buildSourceUrl(bucket, prefix, opts.sourceRegion), dest: buildTargetUrl(target, prefix), includeAfter, listOnly: true }, opts);

  let files = 0;
  let bytes = 0;
  const provider = azcopyProvider({
    command: azcopyCommand(opts),
    args,
    redactor,
    bucket,
    prefix,
    onStderr: (line) => err.write(`${redactor.redact(line)}\n`),
  });
  try {
    await provider.list((object) => {
      out.write(`s3://${bucket}/${[prefix, object.path].filter(Boolean).join('/')}\t${object.size}\n`);
      files++;
      bytes += object.size;
    });
  } catch (e) {
    if (!(e instanceof InventoryError)) throw e;
    err.write(`Error: ${e.message}\n`);
    return EXIT.FAILED;
  }
  err.write(`${formatCount(files)} file(s), ${formatBytes(bytes)}${includeAfter ? ` modified on/after ${includeAfter}` : ''}. Files that already exist at the target are included.\n`);
  return EXIT.OK;
}
