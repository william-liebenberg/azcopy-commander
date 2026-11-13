import fs from 'node:fs';
import path from 'node:path';
import { once } from 'node:events';
import { readInventory } from './inventory.js';
import { UsageError } from './errors.js';

/*
 * Chunking: the inventory, in its own order, is cut into chunk files. A chunk is a plain list of paths
 * relative to the source root, one per line: the format `azcopy copy --list-of-files` takes (retry writes the same).
 */

const UNITS = { b: 1, kib: 2 ** 10, mib: 2 ** 20, gib: 2 ** 30, tib: 2 ** 40, pib: 2 ** 50 };

/** Parses a size such as `2TiB`, `500GiB`, `1.5 GiB` or a plain number of bytes. */
export function parseSize(text, name = 'size') {
  const m = /^\s*(\d+(?:\.\d+)?)\s*([a-z]*)\s*$/i.exec(String(text));
  const unit = m ? (m[2] ? UNITS[m[2].toLowerCase()] : 1) : undefined;
  const bytes = m && unit ? Math.floor(Number(m[1]) * unit) : 0;
  if (bytes < 1) throw new UsageError(`Invalid ${name} "${text}": use a number of bytes or a size such as 500GiB or 2TiB.`);
  return bytes;
}

/** A positive whole number from a CLI string or a number. */
export function parseCount(value, name) {
  const n = typeof value === 'number' ? value : /^\d+$/.test(String(value).trim()) ? Number(value) : NaN;
  if (!Number.isSafeInteger(n) || n < 1) throw new UsageError(`Invalid ${name} "${value}": a whole number of at least 1 is needed.`);
  return n;
}

export const chunkId = (id) => String(id).padStart(5, '0');

/** A key with a line break cannot be written to a list of files: it would be read as two paths. */
const unlistable = (p) => /[\r\n]/.test(p);

/**
 * Splits the inventory into `<chunksDir>/00001.txt`, `00002.txt`, ... A chunk is closed when it holds
 * `maxFiles` objects, or when the next object would take it past `maxBytes`; an object of `maxBytes` or
 * more gets a chunk of its own. Keys that cannot be listed go to `<chunksDir>/skipped.jsonl` (only
 * written when there are some). Returns { chunks: [{ id, list, files, bytes, carried? }], skipped, carriedInInventory };
 * `list` is relative to the migration folder (`dir`, default: the folder above `chunksDir`).
 *
 * `carried` (a delta migration): a Map of path -> size, the files an earlier migration did not copy. A carried path
 * that is also in the inventory is left to its inventory chunk (two jobs never write the same blob; the Map loses
 * it). The others become the first chunks, split by `maxFiles` and marked `carried: true`; the inventory chunks
 * follow them. `carriedInInventory` counts the carried paths found in the inventory.
 */
export async function createChunks({ inventoryFile, chunksDir, maxFiles, maxBytes, dir = path.dirname(chunksDir), carried = null }) {
  fs.rmSync(chunksDir, { recursive: true, force: true });
  fs.mkdirSync(chunksDir, { recursive: true });
  const inventoryChunks = [];
  let skipped = 0;
  let carriedInInventory = 0;
  let skippedStream = null;
  let current = null; // { id, file, stream, files, bytes }
  // The inventory chunks are numbered after the carried ones, whose count is only known at the end: they get a
  // temporary name first.
  const inventoryName = (id) => path.join(chunksDir, `${chunkId(id)}.inventory`);
  const listOf = (file) => path.relative(dir, file).split(path.sep).join('/');

  const write = async (stream, text) => {
    if (!stream.write(text)) await once(stream, 'drain');
  };
  const close = async () => {
    if (!current) return;
    current.stream.end();
    await once(current.stream, 'close');
    inventoryChunks.push({ file: current.file, files: current.files, bytes: current.bytes });
    current = null;
  };

  try {
    await readInventory(inventoryFile, async (record) => {
      const size = Number(record.size) || 0;
      if (unlistable(record.path)) {
        skippedStream ??= fs.createWriteStream(path.join(chunksDir, 'skipped.jsonl'));
        skipped++;
        await write(skippedStream, `${JSON.stringify({ path: record.path, size, reason: 'line break in the key' })}\n`);
        return;
      }
      if (carried?.delete(record.path)) carriedInInventory++;
      if (current && (current.files + 1 > maxFiles || current.bytes + size > maxBytes)) await close();
      if (!current) {
        const file = inventoryName(inventoryChunks.length + 1);
        current = { file, stream: fs.createWriteStream(file), files: 0, bytes: 0 };
      }
      await write(current.stream, `${record.path}\n`);
      current.files++;
      current.bytes += size;
      if (current.files >= maxFiles || current.bytes >= maxBytes) await close();
    });
    await close();
  } finally {
    if (skippedStream) {
      skippedStream.end();
      await once(skippedStream, 'close');
    }
  }

  const chunks = [];
  const carriedPaths = [...(carried?.keys() ?? [])];
  for (let i = 0; i < carriedPaths.length; i += maxFiles) {
    const paths = carriedPaths.slice(i, i + maxFiles);
    const file = path.join(chunksDir, `${chunkId(chunks.length + 1)}.txt`);
    fs.writeFileSync(file, `${paths.join('\n')}\n`);
    chunks.push({ id: chunks.length + 1, list: listOf(file), files: paths.length, bytes: paths.reduce((s, p) => s + (Number(carried.get(p)) || 0), 0), carried: true });
  }
  for (const c of inventoryChunks) {
    const id = chunks.length + 1;
    const file = path.join(chunksDir, `${chunkId(id)}.txt`);
    fs.renameSync(c.file, file);
    chunks.push({ id, list: listOf(file), files: c.files, bytes: c.bytes });
  }
  return { chunks, skipped, carriedInInventory };
}
