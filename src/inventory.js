import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { UsageError } from './errors.js';
import { formatBytes, formatCount } from './format.js';
import { writeFileAtomic } from './files.js';

/*
 * The inventory of the source: every object, one JSON line each, in the order S3 lists them (UTF-8 binary order of the
 * keys). The inventory chunk files of a migration are these lines.
 *
 *   {"path":"data/2024/a b.txt","size":10,"lastModified":"2024-03-01T10:00:00Z","storageClass":"STANDARD"}
 *
 * `path` is relative to the source root (the bucket, or the prefix inside it). A provider is `{ name, list(onObject) }`:
 * `list` calls `onObject(record)` for every object (and waits for the promise it may return) and rejects with an
 * InventoryError when listing failed. The provider also gives `key`, the full S3 key, which is not written to a chunk.
 */

export class InventoryError extends Error {}
/** The listing was stopped (Ctrl+C): not a failure. */
export class InventoryAborted extends Error {}

/** Archive classes: an object in one of them cannot be read (or copied) until it is restored. */
export const ARCHIVE_CLASSES = new Set(['GLACIER', 'DEEP_ARCHIVE']);

/** True when an object of an archive class has a restored copy that can be read now. */
function restored(o, now) {
  const r = o.RestoreStatus;
  if (!r || r.IsRestoreInProgress !== false) return false;
  const expiry = r.RestoreExpiryDate ? new Date(r.RestoreExpiryDate) : null;
  return !expiry || Number.isNaN(expiry.getTime()) || expiry > now;
}

/**
 * Lists the source with ListObjectsV2: path, full key, size, last modified and storage class.
 * `listPage(params, { signal })` returns a ListObjectsV2 response (see src/s3.js).
 * `includeAfter` (ISO date) keeps the objects modified on/after it. `startAfter` (a full key) starts the listing after
 * it: a resumed listing. An object of an archive class that is not restored gets `archived: true`. `onPage()` is
 * awaited after each page (a delta can list many pages without finding an object).
 */
export function s3Provider({ bucket, prefix = '', includeAfter, listPage, signal, pageSize = 1000, startAfter, now = () => new Date(), onPage }) {
  return {
    name: 's3',
    async list(onObject) {
      const root = prefix ? `${prefix}/` : '';
      const after = includeAfter ? new Date(includeAfter) : null;
      let token;
      let first = true;
      do {
        if (signal?.aborted) throw new InventoryAborted('Inventory stopped.');
        const params = {
          Bucket: bucket,
          ...(root ? { Prefix: root } : {}),
          ...(token ? { ContinuationToken: token } : first && startAfter ? { StartAfter: startAfter } : {}),
          MaxKeys: pageSize,
          OptionalObjectAttributes: ['RestoreStatus'],
        };
        first = false;
        let page;
        try {
          page = await listPage(params, { signal });
        } catch (err) {
          if (signal?.aborted) throw new InventoryAborted('Inventory stopped.');
          if (err instanceof UsageError) throw err;
          throw new InventoryError(`S3 listing failed: ${err?.name && err.name !== 'Error' ? `${err.name}: ` : ''}${err?.message ?? err}`);
        }
        const time = now();
        for (const o of page.Contents ?? []) {
          const key = String(o.Key);
          const rel = key.slice(root.length);
          if (!rel || rel.endsWith('/')) continue; // the prefix itself and "folder" markers: not files
          const modified = new Date(o.LastModified);
          if (after && !(modified >= after)) continue;
          const storageClass = o.StorageClass ?? 'STANDARD';
          const pending = onObject({
            path: rel,
            key,
            size: Number(o.Size) || 0,
            ...(Number.isNaN(modified.getTime()) ? {} : { lastModified: modified.toISOString() }),
            storageClass,
            ...(ARCHIVE_CLASSES.has(storageClass) && !restored(o, time) ? { archived: true } : {}),
          });
          if (pending) await pending;
        }
        if (onPage) await onPage();
        token = page.IsTruncated ? page.NextContinuationToken : undefined;
      } while (token);
    },
  };
}

/** Calls `fn(record)` for every line of an inventory (chunk, or skipped) file, in order. */
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

const topLevel = (p) => {
  const slash = p.indexOf('/');
  return slash < 0 ? '(root)' : p.slice(0, slash + 1);
};

/**
 * Reads the inventory files once (the inventory chunks and `skipped.jsonl`; a file that does not exist is left out)
 * and writes `summaryFile`: object count and bytes, a size histogram, the largest objects, count and bytes per
 * top-level prefix and per storage class. Skipped records (those with a `reason`) are counted as objects of the source,
 * and also in `skipped`; the archived ones (reason `archived (...)`) in `archived`. Returns the summary.
 */
export async function analyseInventory(files, summaryFile) {
  const list = Array.isArray(files) ? files : [files];
  summaryFile ??= path.join(path.dirname(list[0]), 'inventory-summary.json');
  const sizes = SIZE_CLASSES.map(({ label }) => ({ label, files: 0, bytes: 0 }));
  const prefixes = new Map();
  const classes = new Map();
  let largest = [];
  let count = 0;
  let bytes = 0;
  const skipped = { files: 0, bytes: 0 };
  const archived = { files: 0, bytes: 0 };

  const add = (r) => {
    const size = Number(r.size) || 0;
    count++;
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
    if (r.reason) {
      skipped.files++;
      skipped.bytes += size;
      if (String(r.reason).startsWith('archived')) {
        archived.files++;
        archived.bytes += size;
      }
    }

    if (largest.length < LARGEST || size > largest.at(-1).size) {
      largest.push({ path: r.path, size });
      largest.sort((a, b) => b.size - a.size);
      largest = largest.slice(0, LARGEST);
    }
  };
  for (const file of list) {
    if (fs.existsSync(file)) await readInventory(file, add);
  }

  const byBytes = (a, b) => b.bytes - a.bytes || b.files - a.files;
  const summary = {
    analysedAt: new Date().toISOString(),
    files: count,
    bytes,
    sizes,
    largest,
    topLevel: [...prefixes.values()].sort(byBytes),
  };
  if (classes.size > 0) summary.storageClasses = [...classes.values()].sort(byBytes);
  if (skipped.files > 0) summary.skipped = skipped;
  if (archived.files > 0) summary.archived = archived;
  fs.mkdirSync(path.dirname(summaryFile), { recursive: true });
  writeFileAtomic(summaryFile, `${JSON.stringify(summary, null, 2)}\n`);
  return summary;
}

/** The lines printed for an analysis. */
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
    lines.push(`WARNING: ${formatCount(summary.archived.files)} archived object(s) (${formatBytes(summary.archived.bytes)}, GLACIER / DEEP_ARCHIVE, not restored) are skipped: restore them, then run a delta migration.`);
  }
  return lines;
}
