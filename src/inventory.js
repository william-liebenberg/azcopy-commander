import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { once } from 'node:events';
import { startAzcopy } from './runner.js';
import { relativeSourcePath } from './urls.js';
import { UsageError } from './errors.js';
import { formatBytes, formatCount } from './format.js';

/*
 * The inventory of the source: every object, one JSON line each, in the order the provider lists them.
 *
 *   {"path":"data/2024/a b.txt","size":10}
 *   {"path":"data/2024/big.bin","size":53687091200,"lastModified":"2024-03-01T10:00:00Z","storageClass":"STANDARD"}
 *
 * `path` is relative to the source root (the bucket, or the prefix inside it), the form `--list-of-files` takes.
 * A provider is `{ name, list(onObject) }`: `list` calls `onObject(record)` for every object (it may return a
 * promise, which a provider that can wait does) and rejects with an InventoryError when listing failed.
 */

export class InventoryError extends Error {}
/** The listing was stopped (Ctrl+C): not a failure. */
export class InventoryAborted extends Error {}

/**
 * Lists the source with `azcopy copy --dry-run` (what `list` does): path and size only.
 * `args` come from copyArgs({ listOnly: true }); `onStderr` gets azcopy's stderr lines.
 */
export function azcopyProvider({ command, args, env = process.env, redactor, bucket, prefix = '', onStderr, signal }) {
  return {
    name: 'azcopy',
    async list(onObject) {
      let azcopyError = null;
      const { child, done } = startAzcopy({
        command,
        args,
        env,
        onStderr,
        onMessage: (m) => {
          if (m.type === 'Dryrun' && m.data?.EntityType === 'File') {
            onObject({ path: relativeSourcePath(m.data.Source, { bucket, prefix }), size: Number(m.data.SourceSize) || 0 });
          } else if (m.type === 'Error' && !/no transfers were scheduled/i.test(m.text)) {
            azcopyError = redactor.redact(m.text);
          }
        },
      });
      const onAbort = () => child.kill('SIGINT');
      if (signal?.aborted) onAbort();
      else signal?.addEventListener('abort', onAbort, { once: true });
      const result = await done;
      signal?.removeEventListener('abort', onAbort);
      if (signal?.aborted) throw new InventoryAborted('Inventory stopped.');
      if (result.error) azcopyError = `Could not start azcopy: ${result.error.message}`;
      if (azcopyError) throw new InventoryError(azcopyError);
    },
  };
}

async function sdkLister(region) {
  let sdk;
  try {
    sdk = await import('@aws-sdk/client-s3');
  } catch (err) {
    if (err?.code !== 'ERR_MODULE_NOT_FOUND') throw err;
    throw new UsageError('--inventory-source s3 needs its dependencies: run `npm install` in the azcopy-commander folder first.');
  }
  const client = new sdk.S3Client({
    region: region || process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || 'us-east-1',
    followRegionRedirects: true, // a bucket in another region than the client's is followed, not an error
  });
  return (params) => client.send(new sdk.ListObjectsV2Command(params));
}

/**
 * Lists the source with ListObjectsV2 (AWS SDK, loaded only here): path, size, last modified and storage class.
 * `includeAfter` (ISO date) keeps the objects modified on/after it, as azcopy's --include-after does.
 * `listPage(params)` is a test hook that replaces the SDK; it returns a ListObjectsV2 response.
 */
export function s3Provider({ bucket, prefix = '', region, includeAfter, listPage, signal, pageSize = 1000 }) {
  return {
    name: 's3',
    async list(onObject) {
      const lister = listPage ?? (await sdkLister(region));
      const root = prefix ? `${prefix}/` : '';
      const after = includeAfter ? new Date(includeAfter) : null;
      let token;
      do {
        if (signal?.aborted) throw new InventoryAborted('Inventory stopped.');
        let page;
        try {
          page = await lister({ Bucket: bucket, ...(root ? { Prefix: root } : {}), ...(token ? { ContinuationToken: token } : {}), MaxKeys: pageSize });
        } catch (err) {
          if (err instanceof UsageError) throw err;
          throw new InventoryError(`S3 listing failed: ${err.message ?? err}`);
        }
        for (const o of page.Contents ?? []) {
          const rel = String(o.Key).slice(root.length);
          if (!rel || rel.endsWith('/')) continue; // the prefix itself and "folder" markers: not files
          const modified = new Date(o.LastModified);
          if (after && !(modified >= after)) continue;
          const pending = onObject({
            path: rel,
            size: Number(o.Size) || 0,
            ...(Number.isNaN(modified.getTime()) ? {} : { lastModified: modified.toISOString() }),
            storageClass: o.StorageClass ?? 'STANDARD',
          });
          if (pending) await pending;
        }
        token = page.IsTruncated ? page.NextContinuationToken : undefined;
      } while (token);
    },
  };
}

/**
 * Streams the provider's objects into `file` (JSON lines). The data goes to `<file>.partial`, renamed when
 * the listing is complete, so an inventory file that exists is a whole one. `onProgress({ files, bytes })`
 * is called at most every `intervalMs` and once at the end. Returns { files, bytes }.
 */
export async function writeInventory({ file, provider, onProgress, intervalMs = 250 }) {
  const partial = `${file}.partial`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const stream = fs.createWriteStream(partial);
  let streamError = null;
  stream.on('error', (err) => {
    streamError = err;
  });
  let files = 0;
  let bytes = 0;
  let lastReport = 0;

  try {
    await provider.list((record) => {
      if (streamError) return; // reported once the listing ends
      files++;
      bytes += record.size;
      const ok = stream.write(`${JSON.stringify(record)}\n`);
      if (onProgress && Date.now() - lastReport >= intervalMs) {
        lastReport = Date.now();
        onProgress({ files, bytes });
      }
      return ok ? undefined : once(stream, 'drain').catch(() => {});
    });
    stream.end();
    await once(stream, 'close');
    if (streamError) throw streamError;
  } catch (err) {
    stream.destroy();
    await once(stream, 'close').catch(() => {});
    fs.rmSync(partial, { force: true });
    throw err;
  }
  fs.renameSync(partial, file);
  onProgress?.({ files, bytes });
  return { files, bytes };
}

/** Calls `fn(record)` for every line of an inventory file, in order. */
export async function readInventory(file, fn) {
  const lines = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity });
  for await (const line of lines) {
    if (line) await fn(JSON.parse(line));
  }
}

// ---------------------------------------------------------------- analysis

const MiB = 2 ** 20;
const GiB = 2 ** 30;
const SIZE_CLASSES = [
  { label: '< 1 MiB', test: (s) => s < MiB },
  { label: '1 MiB–1 GiB', test: (s) => s < GiB },
  { label: '1–100 GiB', test: (s) => s <= 100 * GiB },
  { label: '> 100 GiB', test: () => true },
];
const LARGEST = 10;
const MAX_PREFIXES = 10_000; // a bucket with more top-level prefixes than this reports the rest as one entry
const ARCHIVED = new Set(['GLACIER', 'DEEP_ARCHIVE']); // azcopy cannot copy these until they are restored

const topLevel = (p) => {
  const slash = p.indexOf('/');
  return slash < 0 ? '(root)' : p.slice(0, slash + 1);
};

/**
 * Reads the inventory once and writes `inventory-summary.json` next to it: object count and bytes, a size
 * histogram, the largest objects, count and bytes per top-level prefix and (when the provider gave it)
 * per storage class. Returns the summary.
 */
export async function analyseInventory(file, summaryFile = path.join(path.dirname(file), 'inventory-summary.json')) {
  const sizes = SIZE_CLASSES.map(({ label }) => ({ label, files: 0, bytes: 0 }));
  const prefixes = new Map();
  const classes = new Map();
  let largest = [];
  let files = 0;
  let bytes = 0;

  await readInventory(file, (r) => {
    const size = Number(r.size) || 0;
    files++;
    bytes += size;
    const bucket = sizes[SIZE_CLASSES.findIndex(({ test }) => test(size))];
    bucket.files++;
    bucket.bytes += size;

    let key = topLevel(r.path);
    if (!prefixes.has(key) && prefixes.size >= MAX_PREFIXES) key = '(other)';
    const p = prefixes.get(key) ?? { prefix: key, files: 0, bytes: 0 };
    p.files++;
    p.bytes += size;
    prefixes.set(key, p);

    if (r.storageClass) {
      const c = classes.get(r.storageClass) ?? { storageClass: r.storageClass, files: 0, bytes: 0 };
      c.files++;
      c.bytes += size;
      classes.set(r.storageClass, c);
    }

    if (largest.length < LARGEST || size > largest.at(-1).size) {
      largest.push({ path: r.path, size });
      largest.sort((a, b) => b.size - a.size);
      largest = largest.slice(0, LARGEST);
    }
  });

  const byBytes = (a, b) => b.bytes - a.bytes || b.files - a.files;
  const summary = {
    analysedAt: new Date().toISOString(),
    files,
    bytes,
    sizes,
    largest,
    topLevel: [...prefixes.values()].sort(byBytes),
  };
  if (classes.size > 0) {
    summary.storageClasses = [...classes.values()].sort(byBytes);
    const archived = summary.storageClasses.filter((c) => ARCHIVED.has(c.storageClass));
    if (archived.length > 0) {
      summary.archived = { files: archived.reduce((s, c) => s + c.files, 0), bytes: archived.reduce((s, c) => s + c.bytes, 0) };
    }
  }
  const tmp = `${summaryFile}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(summary, null, 2)}\n`);
  fs.renameSync(tmp, summaryFile);
  return summary;
}

/** The lines printed for an analysis (see the plan's example run). */
export function analysisLines(summary, { shownPrefixes = 5 } = {}) {
  const lines = [
    `${formatCount(summary.files)} objects, ${formatBytes(summary.bytes)}`,
    `sizes      ${summary.sizes.map((s) => `${s.label} ${formatCount(s.files)}`).join(' · ')}`,
  ];
  if (summary.topLevel.length > 0) {
    const shown = summary.topLevel.slice(0, shownPrefixes).map((p) => `${p.prefix} ${formatCount(p.files)} (${formatBytes(p.bytes)})`);
    const more = summary.topLevel.length - shownPrefixes;
    lines.push(`top level  ${shown.join(' · ')}${more > 0 ? ` · ${formatCount(more)} more` : ''}`);
  }
  if (summary.storageClasses) {
    lines.push(`storage    ${summary.storageClasses.map((c) => `${c.storageClass} ${formatCount(c.files)}`).join(' · ')}`);
  }
  if (summary.archived) {
    lines.push(`WARNING: ${formatCount(summary.archived.files)} archived object(s) (${formatBytes(summary.archived.bytes)}, GLACIER / DEEP_ARCHIVE) cannot be copied by azcopy until they are restored.`);
  }
  return lines;
}
