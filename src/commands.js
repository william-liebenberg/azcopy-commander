import path from 'node:path';
import process from 'node:process';
import readline from 'node:readline/promises';
import { buildSourceUrl, normalizePrefix, parseBucketInput, parseTargetSasUrl, Redactor } from './urls.js';
import { parseLastCopyDate, toUtcSeconds } from './dates.js';
import { s3Provider, InventoryError } from './inventory.js';
import { readState } from './state.js';
import { formatBytes, formatCount } from './format.js';
import { EXIT, UsageError } from './errors.js';
import { withS3 } from './s3.js';

export { UsageError };

// `--last-copy-date auto` starts this long before the previous run began, to cover files that were
// being written while that run listed the bucket. Re-copying the overlap is harmless: existing blobs are ignored.
const AUTO_OVERLAP_MS = 10 * 60_000;

export const outputRoot = (opts) => path.resolve(opts.outputDir ?? 'runs');
export const stateFile = (opts) => path.join(outputRoot(opts), 'state.json');

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

export function requireAwsCredentials(redactor) {
  if (!process.env.AWS_ACCESS_KEY_ID || !process.env.AWS_SECRET_ACCESS_KEY) {
    throw new UsageError('Set AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY in the environment (they are never accepted as arguments).');
  }
  redactor.add(process.env.AWS_SECRET_ACCESS_KEY, process.env.AWS_SESSION_TOKEN);
}

/** The delta baseline for a run: its start minus the same overlap `--last-copy-date auto` uses. */
export const deltaDateFor = (run) => new Date(Date.parse(run.startedAt) - AUTO_OVERLAP_MS);

export async function askYesNo(question) {
  if (!process.stdin.isTTY) throw new UsageError('No terminal to confirm the latest migration: pass --migration <dir>, or --yes to accept the latest one.');
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    return /^y(es)?$/i.test((await rl.question(question)).trim());
  } finally {
    rl.close();
  }
}

/** Resolves --last-copy-date (an ISO date, or "auto") to the instant after which objects are copied. */
export function resolveLastCopyDate(value, { opts, key, now }) {
  if (value !== 'auto') return parseLastCopyDate(value, now);
  const previous = readState(stateFile(opts))[key];
  if (!previous) throw new UsageError('--last-copy-date auto: no earlier run is recorded for this source/target; pass an explicit date.');
  return new Date(Date.parse(previous.startedAt) - AUTO_OVERLAP_MS);
}

// ---------------------------------------------------------------- list

/**
 * `list`: the objects of the source, one `s3://bucket/key<TAB>size` line each, with S3 ListObjectsV2 (no target needed).
 * Test hook: `opts.s3` (see src/s3.js).
 */
export async function listCommand(opts, out = process.stdout, err = process.stderr) {
  const redactor = new Redactor();
  const { bucket, prefix } = resolveSource(opts);
  buildSourceUrl(bucket, prefix, opts.sourceRegion); // checks the bucket and the region
  requireAwsCredentials(redactor);
  if (opts.lastCopyDate === 'auto') throw new UsageError('--last-copy-date auto needs saved state, which list does not keep; pass an explicit date.');
  const includeAfter = opts.lastCopyDate ? toUtcSeconds(parseLastCopyDate(opts.lastCopyDate)) : null;

  const s3 = await withS3(opts, { bucket, region: opts.sourceRegion, lookupRegion: false }, ['listPage']);
  let files = 0;
  let bytes = 0;
  let archived = 0;
  const provider = s3Provider({ bucket, prefix, includeAfter, listPage: s3.listPage });
  try {
    await provider.list((object) => {
      out.write(`s3://${bucket}/${object.key}\t${object.size}\n`);
      files++;
      bytes += object.size;
      if (object.archived) archived++;
    });
  } catch (e) {
    if (!(e instanceof InventoryError)) throw e;
    err.write(`Error: ${redactor.redact(e.message)}\n`);
    return EXIT.FAILED;
  } finally {
    s3.destroy?.();
  }
  err.write(`${formatCount(files)} file(s), ${formatBytes(bytes)}${includeAfter ? ` modified on/after ${includeAfter}` : ''}.${archived > 0 ? ` ${formatCount(archived)} of them archived (GLACIER / DEEP_ARCHIVE, not restored): a migration skips them.` : ''}\n`);
  return EXIT.OK;
}
