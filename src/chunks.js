import fs from 'node:fs';
import path from 'node:path';
import { UsageError } from './errors.js';

/*
 * Chunking: the listing, in its own order, is cut into chunk files as it goes. A chunk file is a list of inventory
 * records, one JSON line each ({ path, size, lastModified, storageClass }, see inventory.js); the open chunk is written
 * to `<id>.jsonl.partial` and renamed when it is closed.
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

/** A key with a line break is kept out of the chunks, as before: a list of paths would read it as two. */
const unlistable = (p) => /[\r\n]/.test(p);

const FLUSH_LINES = 1000;

/** The chunk files of a migration folder (`dir`): paths in migration.json are relative to it, with forward slashes. */
const listOf = (dir, file) => path.relative(dir, file).split(path.sep).join('/');

/**
 * Writes the listing into chunk files as it goes.
 *
 *   const writer = new ChunkWriter({ chunksDir, maxFiles, maxBytes, maxAgeMs, nextId, skippedBytes, exclude, onClosed });
 *   writer.open();                 deletes an open chunk left by an earlier run, cuts skipped.jsonl back to skippedBytes
 *   await writer.add(record);      a record of s3Provider (with its full `key`)
 *   await writer.closeIfOld();     closes the open chunk once it has had objects for maxAgeMs (call it from a timer)
 *   await writer.end();            closes the last chunk
 *
 * A chunk is closed when it holds `maxFiles` objects, when the next object would take it past `maxBytes` (an object
 * of `maxBytes` or more gets a chunk of its own), or when it is `maxAgeMs` old (`now` is the clock, injectable).
 * `onClosed(chunk, resumeAfter)` is awaited for each closed chunk ({ id, list, files, bytes }): every key up to
 * `resumeAfter` (a full S3 key) is then in a closed chunk or in skipped.jsonl, whose size is `writer.skippedBytes`.
 * Keys with a line break and archived objects go to `<chunksDir>/skipped.jsonl` with their reason; paths in
 * `exclude` (the carried files of a delta, already in a chunk of their own) are counted in `excluded` and left out.
 */
export class ChunkWriter {
  constructor({ chunksDir, dir = path.dirname(chunksDir), maxFiles, maxBytes, maxAgeMs = Infinity, now = Date.now, nextId = 1, skippedBytes = 0, exclude = null, onClosed = async () => {} }) {
    Object.assign(this, { chunksDir, dir, maxFiles, maxBytes, maxAgeMs, now, nextId, skippedBytes, exclude, onClosed });
    this.skippedFile = path.join(chunksDir, 'skipped.jsonl');
    this.skipped = 0;
    this.archived = 0; // of the skipped
    this.excluded = 0;
    this.files = 0; // objects written to chunks by this writer
    this.bytes = 0;
    this.current = null; // { id, file, fd, files, bytes, openedAt, lines }
    this.lastKey = null;
    this.busy = Promise.resolve();
  }

  open() {
    fs.mkdirSync(this.chunksDir, { recursive: true });
    for (const name of fs.readdirSync(this.chunksDir)) {
      if (name.endsWith('.partial')) fs.rmSync(path.join(this.chunksDir, name), { force: true });
    }
    if (fs.existsSync(this.skippedFile) && fs.statSync(this.skippedFile).size !== this.skippedBytes) fs.truncateSync(this.skippedFile, this.skippedBytes);
    return this;
  }

  /** One operation at a time: `add` from the listing and `closeIfOld` from a timer can overlap. */
  #serial(fn) {
    const run = this.busy.then(fn);
    this.busy = run.catch(() => {});
    return run;
  }

  add(record) {
    return this.#serial(async () => {
      const size = Number(record.size) || 0;
      const reason = unlistable(record.path) ? 'line break in the key' : record.archived ? `archived (${record.storageClass})` : null;
      if (reason) {
        const line = `${JSON.stringify({ path: record.path, size, reason, ...(record.storageClass ? { storageClass: record.storageClass } : {}), ...(record.lastModified ? { lastModified: record.lastModified } : {}) })}\n`;
        fs.appendFileSync(this.skippedFile, line);
        this.skippedBytes += Buffer.byteLength(line);
        this.skipped++;
        if (record.archived && !unlistable(record.path)) this.archived++;
      } else if (this.exclude?.has(record.path)) {
        this.excluded++;
      } else {
        if (this.current && (this.current.files + 1 > this.maxFiles || this.current.bytes + size > this.maxBytes || this.#old())) await this.#close();
        if (!this.current) {
          const id = this.nextId++;
          const file = path.join(this.chunksDir, `${chunkId(id)}.jsonl`);
          this.current = { id, file, fd: fs.openSync(`${file}.partial`, 'w'), files: 0, bytes: 0, openedAt: this.now(), lines: [] };
        }
        // The full key is not written: `path` is relative to the source root.
        const line = { path: record.path, size, ...(record.lastModified ? { lastModified: record.lastModified } : {}), ...(record.storageClass ? { storageClass: record.storageClass } : {}) };
        this.current.lines.push(JSON.stringify(line));
        if (this.current.lines.length >= FLUSH_LINES) this.#flush();
        this.current.files++;
        this.current.bytes += size;
        this.files++;
        this.bytes += size;
      }
      this.lastKey = record.key ?? record.path;
      if (this.current && (this.current.files >= this.maxFiles || this.current.bytes >= this.maxBytes)) await this.#close();
    });
  }

  closeIfOld() {
    return this.#serial(async () => {
      if (this.#old()) await this.#close();
    });
  }

  end() {
    return this.#serial(() => this.#close());
  }

  /** Stops without closing the open chunk (an interrupted or failed listing): its file is deleted on the next open. */
  abandon() {
    return this.#serial(() => {
      if (!this.current) return;
      fs.closeSync(this.current.fd);
      fs.rmSync(`${this.current.file}.partial`, { force: true });
      this.current = null;
    });
  }

  #old() {
    return Boolean(this.current) && this.current.files > 0 && this.now() - this.current.openedAt >= this.maxAgeMs;
  }

  #flush() {
    const c = this.current;
    if (c.lines.length === 0) return;
    fs.writeSync(c.fd, `${c.lines.join('\n')}\n`);
    c.lines = [];
  }

  async #close() {
    const c = this.current;
    if (!c) return;
    this.#flush();
    fs.closeSync(c.fd);
    fs.renameSync(`${c.file}.partial`, c.file);
    this.current = null;
    await this.onClosed({ id: c.id, list: listOf(this.dir, c.file), files: c.files, bytes: c.bytes }, this.lastKey);
  }
}

/**
 * The carried files of a delta (a Map of path -> size, see collectCarried in migration.js) as the first chunks:
 * `<chunksDir>/00001.jsonl`, ... of at most `maxFiles` records each. Returns [{ id, list, files, bytes, carried: true }].
 */
export function writeCarriedChunks({ carried, chunksDir, maxFiles, dir = path.dirname(chunksDir), firstId = 1 }) {
  fs.mkdirSync(chunksDir, { recursive: true });
  const paths = [...carried.keys()];
  const chunks = [];
  for (let i = 0; i < paths.length; i += maxFiles) {
    const records = paths.slice(i, i + maxFiles).map((p) => ({ path: p, size: Number(carried.get(p)) || 0 }));
    const id = firstId + chunks.length;
    const file = path.join(chunksDir, `${chunkId(id)}.jsonl`);
    fs.writeFileSync(file, `${records.map((r) => JSON.stringify(r)).join('\n')}\n`);
    chunks.push({ id, list: listOf(dir, file), files: records.length, bytes: records.reduce((s, r) => s + r.size, 0), carried: true });
  }
  return chunks;
}

/** The records of a chunk file: JSON lines ({ path, size, ... }), or, in a migration made with azcopy, a list of paths. */
export function readChunkRecords(file) {
  const lines = fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean) : [];
  return file.endsWith('.jsonl') ? lines.map((l) => JSON.parse(l)) : lines.map((p) => ({ path: p }));
}
