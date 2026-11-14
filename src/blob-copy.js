import fs from 'node:fs';
import path from 'node:path';
import { loadSdk } from './sdk.js';
import { fileTimestamp } from './format.js';

/*
 * The copy of S3 objects to a blob container, server-side: Azure reads each object from a presigned S3 GET URL.
 *
 *   createCopier the copy of one object: S3 HEAD (size, last modified, content headers, metadata), then Put Blob From URL, or
 *                Put Block From URL per range and Put Block List above the block size
 *   copyChunk    a chunk's records, `concurrency` at a time, with the files of one attempt (run.json, copy-<ts>.log,
 *                failed-<ts>.jsonl)
 *
 * An object ends as `copied`, `ignored` (the blob exists: append-only, or newer with --overwrite-modified), `missing`
 * (S3 HEAD 404: deleted after the listing) or failed (an error with a `code`, recorded in the failed list).
 */

const MiB = 2 ** 20;
export const DEFAULT_BLOCK_SIZE = 256 * MiB;
const MAX_BLOCK = 4000 * MiB;
const MAX_BLOCKS = 50_000;
const BLOCKS_AT_ONCE = 8;
const MAX_COPY_SOURCE = 2048; // x-ms-copy-source is at most 2 KiB
const METADATA_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/; // a C# identifier, as Azure requires

/** An object that could not be copied: `code` is what the failed list records. */
export class CopyError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

const statusOf = (err) => err?.statusCode ?? err?.$metadata?.httpStatusCode;
const codeOf = (err) => err?.code ?? err?.details?.errorCode ?? (err?.name && err.name !== 'Error' ? err.name : undefined) ?? (statusOf(err) ? `HTTP${statusOf(err)}` : 'Error');
/** The blob exists (If-None-Match: *), or is newer than the source (If-Unmodified-Since). */
const isConditionFailure = (err) => statusOf(err) === 412 || statusOf(err) === 409 || ['ConditionNotMet', 'BlobAlreadyExists'].includes(codeOf(err));

/** The content headers of a HEAD response, as the blob's HTTP headers. */
export function headersFrom(head) {
  const h = {
    blobContentType: head.ContentType,
    blobContentEncoding: head.ContentEncoding,
    blobContentLanguage: head.ContentLanguage,
    blobContentDisposition: head.ContentDisposition,
    blobCacheControl: head.CacheControl,
  };
  return Object.fromEntries(Object.entries(h).filter(([, v]) => v !== undefined && v !== null && v !== ''));
}

/** The S3 user metadata Azure accepts, and the names it does not (left out, as azcopy's ExcludeIfInvalid does). */
export function validMetadata(metadata = {}) {
  const valid = {};
  const invalid = [];
  for (const [name, value] of Object.entries(metadata ?? {})) {
    if (METADATA_NAME.test(name)) valid[name] = String(value);
    else invalid.push(name);
  }
  return { metadata: valid, invalid };
}

/** Block ids of equal length, as a block blob requires. */
export const blockId = (i) => Buffer.from(String(i).padStart(6, '0')).toString('base64');

/** The block size for an object: at least `blockSize`, large enough for at most 50,000 blocks, at most 4,000 MiB. */
export const blockSizeFor = (size, blockSize) => Math.min(MAX_BLOCK, Math.max(blockSize, Math.ceil(size / MAX_BLOCKS)));

/**
 * The target container of a SAS URL (see parseTargetSasUrl): the first path segment is the container, the rest a
 * directory the blobs are written under. Returns { container, directory } (`container` is a ContainerClient).
 */
export async function containerFor(target) {
  const url = new URL(target.base);
  const name = decodeURIComponent(url.pathname.split('/').filter(Boolean)[0]);
  const { ContainerClient } = await loadSdk('@azure/storage-blob');
  return { container: new ContainerClient(`${url.origin}/${encodeURIComponent(name)}?${target.query}`), directory: targetDirectory(target) };
}

/** The directory of a target SAS URL inside its container ('' for the container itself), decoded. */
export const targetDirectory = (target) => new URL(target.base).pathname.split('/').filter(Boolean).slice(1).map(decodeURIComponent).join('/');

/**
 * The function that copies one object: `copy(record, { signal })` resolves to `{ result, bytes, invalidMetadata }`
 * or rejects with a CopyError (or an SDK error).
 *   s3          see src/s3.js (headObject, presignGet)
 *   container   a ContainerClient (or a fake with getBlockBlobClient)
 *   prefix      the source prefix: the S3 key is `<prefix>/<path>`; the blob name is `<directory>/<prefix>/<path>`
 */
export function createCopier({ s3, container, directory = '', prefix = '', blockSize = DEFAULT_BLOCK_SIZE, overwriteModified = false }) {
  const keyOf = (p) => (prefix ? `${prefix}/${p}` : p);
  const blobName = (p) => [directory, prefix, p].filter(Boolean).join('/');
  const presign = async (key) => {
    const url = await s3.presignGet(key);
    if (url.length > MAX_COPY_SOURCE) throw new CopyError('SourceUrlTooLong', `The presigned URL is ${url.length} characters; Azure takes at most ${MAX_COPY_SOURCE}.`);
    return url;
  };

  return async function copy(record, { signal } = {}) {
    const key = keyOf(record.path);
    const head = await s3.headObject(key, { signal });
    if (!head) return { result: 'missing', bytes: 0 };
    const size = Number(head.ContentLength) || 0;
    const blob = container.getBlockBlobClient(blobName(record.path));
    const { metadata, invalid } = validMetadata(head.Metadata);
    const sourceModified = head.LastModified ? new Date(head.LastModified) : null;
    const base = { blobHTTPHeaders: headersFrom(head), metadata, abortSignal: signal };
    const done = (result) => ({ result, bytes: result === 'copied' ? size : 0, invalidMetadata: invalid });

    const write = async (conditions) => {
      const options = { ...base, conditions };
      if (size === 0) await blob.upload('', 0, options);
      else await blob.syncUploadFromURL(await presign(key), { ...options, copySourceBlobProperties: false });
    };

    if (size <= blockSize) {
      try {
        await write({ ifNoneMatch: '*' });
        return done('copied');
      } catch (err) {
        if (!isConditionFailure(err)) throw err;
      }
      if (!overwriteModified || !sourceModified) return done('ignored');
      try {
        await write({ ifUnmodifiedSince: sourceModified }); // the blob is older than the source: written again
        return done('copied');
      } catch (err) {
        if (isConditionFailure(err)) return done('ignored');
        throw err;
      }
    }

    // In blocks: the blob is checked first, so nothing is staged for an object that is not written.
    let existing = null;
    try {
      existing = await blob.getProperties({ abortSignal: signal });
    } catch (err) {
      if (statusOf(err) !== 404) throw err;
    }
    let conditions = { ifNoneMatch: '*' };
    if (existing) {
      const blobModified = existing.lastModified ? new Date(existing.lastModified) : null;
      if (!overwriteModified || !sourceModified || (blobModified && blobModified > sourceModified)) return done('ignored');
      conditions = { ifUnmodifiedSince: sourceModified };
    }
    const each = blockSizeFor(size, blockSize);
    const ids = [];
    for (let offset = 0, i = 0; offset < size; offset += each, i++) ids.push({ id: blockId(i), offset, count: Math.min(each, size - offset) });
    for (let i = 0; i < ids.length; i += BLOCKS_AT_ONCE) {
      await Promise.all(ids.slice(i, i + BLOCKS_AT_ONCE).map(async (b) => blob.stageBlockFromURL(b.id, await presign(key), b.offset, b.count, { abortSignal: signal })));
    }
    try {
      await blob.commitBlockList(ids.map((b) => b.id), { ...base, conditions });
      return done('copied');
    } catch (err) {
      if (isConditionFailure(err)) return done('ignored');
      throw err;
    }
  };
}

/**
 * Copies a chunk's records, `concurrency` at a time, and writes the attempt's files in `runDir`:
 *   run.json            `manifest` with the attempt's counters and outcome
 *   copy-<ts>.log       failed and missing objects, invalid metadata names, the summary
 *   failed-<ts>.jsonl   { relativePath, src, dst, errorCode, size } per failed object (no query string: no secret)
 * `onProgress({ copied, ignored, missing, failed, bytesDone, bytesTotal })` is called as objects end (at most every
 * `intervalMs`) and at the end; `onFailure(path, errorCode)` for each failed object. `redact` cleans an error message before it is written.
 * Returns { outcome, copied, ignored, missing, failed, bytesCopied, files: { log, failed } }; outcome is success,
 * partial (some objects failed) or interrupted (`signal` aborted before every object ended).
 */
export async function copyChunk({ records, concurrency, signal, copy, runDir, manifest = {}, sourceBase, destBase, onProgress, onFailure, redact = String, intervalMs = 250 }) {
  fs.mkdirSync(runDir, { recursive: true });
  const stamp = fileTimestamp();
  const logFile = path.join(runDir, `copy-${stamp}.log`);
  const failedFile = path.join(runDir, `failed-${stamp}.jsonl`);
  const writeManifest = (m) => fs.writeFileSync(path.join(runDir, 'run.json'), `${JSON.stringify(m, null, 2)}\n`);
  const logLines = [];
  const log = (level, msg) => logLines.push(`${new Date().toISOString()} ${level.padEnd(5)} ${redact(msg)}`);
  const flushLog = () => {
    if (logLines.length > 0) fs.appendFileSync(logFile, `${logLines.splice(0).join('\n')}\n`);
  };
  const encoded = (p) => p.split('/').map(encodeURIComponent).join('/');
  const failedLines = [];

  const counts = { copied: 0, ignored: 0, missing: 0, failed: 0, bytesDone: 0, bytesTotal: records.reduce((s, r) => s + (Number(r.size) || 0), 0) };
  let bytesCopied = 0;
  const invalidNames = new Set();
  let lastReport = 0;
  const report = (force = false) => {
    if (!onProgress || (!force && Date.now() - lastReport < intervalMs)) return;
    lastReport = Date.now();
    onProgress({ ...counts });
  };

  const startedAt = new Date().toISOString();
  writeManifest({ ...manifest, startedAt, files: records.length, outcome: 'running' });
  log('INFO', `copying ${records.length} object(s), ${concurrency} at a time`);

  let next = 0;
  let ended = 0;
  const worker = async () => {
    while (!signal?.aborted && next < records.length) {
      const record = records[next++];
      const size = Number(record.size) || 0;
      try {
        const { result, bytes, invalidMetadata = [] } = await copy(record, { signal });
        invalidMetadata.forEach((n) => invalidNames.add(n));
        counts[result]++;
        if (result === 'copied') bytesCopied += bytes;
        if (result === 'missing') log('WARN', `missing at the source (deleted after the listing): ${record.path}`);
        counts.bytesDone += size;
        ended++;
      } catch (err) {
        if (signal?.aborted) break; // interrupted, not failed: copied again on the next attempt
        const errorCode = codeOf(err);
        counts.failed++;
        counts.bytesDone += size;
        ended++;
        failedLines.push(JSON.stringify({ relativePath: record.path, src: `${sourceBase}/${encoded(record.path)}`, dst: `${destBase}/${encoded(record.path)}`, errorCode, size }));
        log('ERROR', `${record.path}: ${errorCode}: ${err?.message ?? err}`);
        onFailure?.(record.path, errorCode);
      }
      if (logLines.length >= 100) flushLog();
      report();
    }
  };
  try {
    await Promise.all(Array.from({ length: Math.min(concurrency, records.length) }, worker));
  } finally {
    if (failedLines.length > 0) fs.writeFileSync(failedFile, `${failedLines.join('\n')}\n`);
    if (invalidNames.size > 0) log('WARN', `metadata left out (not a valid Azure metadata name): ${[...invalidNames].sort().join(', ')}`);
    const outcome = ended < records.length ? 'interrupted' : counts.failed > 0 ? 'partial' : 'success';
    log('INFO', `${outcome}: copied ${counts.copied}, ignored ${counts.ignored} (already at the target), missing ${counts.missing}, failed ${counts.failed}`);
    flushLog();
    writeManifest({ ...manifest, startedAt, finishedAt: new Date().toISOString(), files: records.length, outcome, copied: counts.copied, ignored: counts.ignored, missing: counts.missing, failed: counts.failed, bytesCopied });
    report(true);
  }
  const outcome = ended < records.length ? 'interrupted' : counts.failed > 0 ? 'partial' : 'success';
  return {
    outcome,
    copied: counts.copied,
    ignored: counts.ignored,
    missing: counts.missing,
    failed: counts.failed,
    bytesCopied,
    files: { log: logFile, failed: failedLines.length > 0 ? failedFile : null },
  };
}
