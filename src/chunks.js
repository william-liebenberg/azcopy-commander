import fs from 'node:fs';
import path from 'node:path';
import { UsageError } from './errors.js';
import { renameSync } from './files.js';
import { classOf, compareKeys } from './size-classes.js';

/*
 * Chunking: the listing, in its own order, is cut into chunk files as it goes. A chunk file is a list of inventory
 * records, one JSON line each ({ path, size, lastModified, storageClass }, see inventory.js); an open chunk is written
 * to `<id>.jsonl.partial` and renamed when it is closed. Each size class (see size-classes.js) has its own open chunk.
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

/** Keys in S3's order, null before any key. */
const maxKey = (a, b) => (a == null ? b ?? null : b == null || compareKeys(a, b) >= 0 ? a : b);
const minKey = (a, b) => (a == null || b == null ? null : compareKeys(a, b) <= 0 ? a : b);

/** The key of a class in `closedThrough`: its name; a uniform migration has one class without a name. */
const classKey = (cls) => cls.name ?? '*';

/**
 * Writes the listing into chunk files as it goes, one open chunk per size class.
 *
 *   const writer = new ChunkWriter({ chunksDir, classes, maxBytes, maxAgeMs, nextId, skippedBytes, exclude, resume, onClosed });
 *   writer.open();                 deletes the open chunks left by an earlier run, cuts skipped.jsonl back to skippedBytes
 *   await writer.add(record);      a record of s3Provider (with its full `key`)
 *   await writer.closeIfOld();     closes the open chunks that have had objects for maxAgeMs (call it from a timer)
 *   await writer.end();            closes every open chunk
 *
 * `classes` are size classes ({ name, below, chunkFiles, chunkBytes? }, see size-classes.js); a uniform migration
 * passes one class without a name or `below`. An object goes to the open chunk of its class. A chunk is closed when it
 * holds the `chunkFiles` of its class, when the next object would take it past the `chunkBytes` of its class (else
 * `maxBytes`; an object of that size or more gets a chunk of its own), or when it is `maxAgeMs` old (`now` is the
 * clock, injectable). Chunk ids are global and in the order chunks open; a chunk of a named class has `sizeClass`.
 *
 * `onClosed(chunk, { listedThrough, closedThrough, resumeAfter })` is awaited for each closed chunk
 * ({ id, list, files, bytes, sizeClass? }), with where the listing stands (full S3 keys, or null):
 *   listedThrough           the last key listed: keys skipped (skipped.jsonl, whose size is `writer.skippedBytes`) or
 *                           excluded are done up to it
 *   closedThrough[class]    every object of the class up to this key is in a closed chunk (by class name; '*' for
 *                           the class of a uniform migration)
 *   resumeAfter             the smallest of them: a continued listing starts after it
 * `files` and `bytes` count the objects of closed chunks only; `listed` and `listedBytes` every object written to a chunk.
 *
 * `resume` ({ startAfter, listedThrough, closedThrough }, from the saved positions) continues a listing that was
 * stopped: a record with a key up to `listedThrough` is dropped unless its key is after `closedThrough` of its class
 * (it was in an open chunk that was lost). A missing `closedThrough` entry reads as `startAfter`.
 * Keys with a line break and archived objects go to `<chunksDir>/skipped.jsonl` with their reason; paths in
 * `exclude` (the carried files of a delta, already in a chunk of their own) are counted in `excluded` and left out.
 */
export class ChunkWriter {
  constructor({ chunksDir, dir = path.dirname(chunksDir), classes, maxBytes = Infinity, maxAgeMs = Infinity, now = Date.now, nextId = 1, skippedBytes = 0, exclude = null, resume = null, onClosed = async () => {} }) {
    Object.assign(this, { chunksDir, dir, classes, maxBytes, maxAgeMs, now, nextId, skippedBytes, exclude, resume, onClosed });
    this.skippedFile = path.join(chunksDir, 'skipped.jsonl');
    this.skipped = 0;
    this.archived = 0; // of the skipped
    this.excluded = 0;
    this.files = 0; // objects in the chunks this writer closed
    this.bytes = 0;
    this.listed = 0; // objects written to a chunk, open or closed, and their bytes
    this.listedBytes = 0;
    this.opened = new Map(); // class key -> { id, file, fd, files, bytes, openedAt, lines, cls, before }
    this.lastKey = resume?.startAfter ?? null;
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

  /** Where `closedThrough` of a class stood when the listing was stopped (null: nothing). */
  #resumedThrough(cls) {
    if (!this.resume) return null;
    return this.resume.closedThrough?.[classKey(cls)] ?? this.resume.startAfter ?? null;
  }

  /** A record listed again after a stop that is already done: skipped, excluded, or in a closed chunk of its class. */
  #done(key, cls, isSkippedOrExcluded) {
    const listed = this.resume?.listedThrough;
    if (listed == null || compareKeys(key, listed) > 0) return false;
    if (isSkippedOrExcluded) return true;
    const closed = this.#resumedThrough(cls);
    return closed != null && compareKeys(key, closed) <= 0;
  }

  add(record) {
    return this.#serial(async () => {
      const size = Number(record.size) || 0;
      const key = record.key ?? record.path;
      const reason = unlistable(record.path) ? 'line break in the key' : record.archived ? `archived (${record.storageClass})` : null;
      const excluded = !reason && Boolean(this.exclude?.has(record.path));
      const cls = classOf(this.classes, size);
      if (this.#done(key, cls, Boolean(reason) || excluded)) {
        this.lastKey = key; // listed and recorded before the stop
      } else if (reason) {
        const line = `${JSON.stringify({ path: record.path, size, reason, ...(record.storageClass ? { storageClass: record.storageClass } : {}), ...(record.lastModified ? { lastModified: record.lastModified } : {}) })}\n`;
        fs.appendFileSync(this.skippedFile, line);
        this.skippedBytes += Buffer.byteLength(line);
        this.skipped++;
        if (record.archived && !unlistable(record.path)) this.archived++;
        this.lastKey = key;
      } else if (excluded) {
        this.excluded++;
        this.lastKey = key;
      } else {
        const maxBytes = cls.chunkBytes ?? this.maxBytes;
        let c = this.opened.get(classKey(cls));
        if (c && (c.files + 1 > cls.chunkFiles || c.bytes + size > maxBytes || this.#old(c))) {
          await this.#close(c);
          c = null;
        }
        if (!c) {
          const id = this.nextId++;
          const file = path.join(this.chunksDir, `${chunkId(id)}.jsonl`);
          // `before`: the key listed just before this chunk's first object; every object of the class up to it is closed
          c = { id, file, fd: fs.openSync(`${file}.partial`, 'w'), files: 0, bytes: 0, openedAt: this.now(), lines: [], cls, before: this.lastKey };
          this.opened.set(classKey(cls), c);
        }
        // The full key is not written: `path` is relative to the source root.
        const line = { path: record.path, size, ...(record.lastModified ? { lastModified: record.lastModified } : {}), ...(record.storageClass ? { storageClass: record.storageClass } : {}) };
        c.lines.push(JSON.stringify(line));
        if (c.lines.length >= FLUSH_LINES) this.#flush(c);
        c.files++;
        c.bytes += size;
        this.listed++;
        this.listedBytes += size;
        this.lastKey = key;
        if (c.files >= cls.chunkFiles || c.bytes >= maxBytes) await this.#close(c);
      }
    });
  }

  closeIfOld() {
    return this.#serial(async () => {
      for (const c of this.#openChunks()) if (this.#old(c)) await this.#close(c);
    });
  }

  end() {
    return this.#serial(async () => {
      for (const c of this.#openChunks()) await this.#close(c);
    });
  }

  /** Stops without closing the open chunks (an interrupted or failed listing): their files are deleted. */
  abandon() {
    return this.#serial(() => {
      for (const c of this.#openChunks()) {
        fs.closeSync(c.fd);
        fs.rmSync(`${c.file}.partial`, { force: true });
      }
      this.opened.clear();
    });
  }

  /** The open chunks, oldest first. */
  #openChunks() {
    return [...this.opened.values()].sort((a, b) => a.id - b.id);
  }

  #old(c) {
    return c.files > 0 && this.now() - c.openedAt >= this.maxAgeMs;
  }

  #flush(c) {
    if (c.lines.length === 0) return;
    fs.writeSync(c.fd, `${c.lines.join('\n')}\n`);
    c.lines = [];
  }

  /** Where the listing stands, for a continued listing (see onClosed). */
  #positions() {
    const listedThrough = maxKey(this.lastKey, this.resume?.listedThrough ?? null);
    const closedThrough = {};
    let resumeAfter = listedThrough;
    for (const cls of this.classes) {
      const c = this.opened.get(classKey(cls));
      const through = maxKey(this.#resumedThrough(cls), c ? c.before : this.lastKey);
      closedThrough[classKey(cls)] = through;
      resumeAfter = minKey(resumeAfter, through);
    }
    return { listedThrough, closedThrough, resumeAfter };
  }

  async #close(c) {
    this.#flush(c);
    fs.closeSync(c.fd);
    renameSync(`${c.file}.partial`, c.file);
    this.opened.delete(classKey(c.cls));
    this.files += c.files;
    this.bytes += c.bytes;
    const chunk = { id: c.id, list: listOf(this.dir, c.file), files: c.files, bytes: c.bytes, ...(c.cls.name ? { sizeClass: c.cls.name } : {}) };
    await this.onClosed(chunk, this.#positions());
  }
}

/**
 * The carried files of a delta (a Map of path -> size, see collectCarried in migration.js) as the first chunks:
 * `<chunksDir>/00001.jsonl`, ..., the files of each size class (`classes`, as for ChunkWriter) in chunks of at most
 * its `chunkFiles`. Returns [{ id, list, files, bytes, carried: true, sizeClass? }].
 */
export function writeCarriedChunks({ carried, chunksDir, classes, dir = path.dirname(chunksDir), firstId = 1 }) {
  fs.mkdirSync(chunksDir, { recursive: true });
  const byClass = new Map(classes.map((cls) => [cls, []]));
  for (const [p, size] of carried) byClass.get(classOf(classes, Number(size) || 0)).push({ path: p, size: Number(size) || 0 });
  const chunks = [];
  for (const [cls, records] of byClass) {
    for (let i = 0; i < records.length; i += cls.chunkFiles) {
      const part = records.slice(i, i + cls.chunkFiles);
      const id = firstId + chunks.length;
      const file = path.join(chunksDir, `${chunkId(id)}.jsonl`);
      fs.writeFileSync(file, `${part.map((r) => JSON.stringify(r)).join('\n')}\n`);
      chunks.push({ id, list: listOf(dir, file), files: part.length, bytes: part.reduce((s, r) => s + r.size, 0), carried: true, ...(cls.name ? { sizeClass: cls.name } : {}) });
    }
  }
  return chunks;
}

/** The records of a chunk file: JSON lines ({ path, size, ... }), or, in a migration made with azcopy, a list of paths. */
export function readChunkRecords(file) {
  const lines = fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean) : [];
  return file.endsWith('.jsonl') ? lines.map((l) => JSON.parse(l)) : lines.map((p) => ({ path: p }));
}
