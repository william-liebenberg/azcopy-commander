import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ChunkWriter, writeCarriedChunks, readChunkRecords } from '../src/chunks.js';
import { classOf, compareKeys, DEFAULT_SIZE_CLASSES, readSizeProfile } from '../src/size-classes.js';
import { UsageError } from '../src/errors.js';
import { analyseInventory, analysisLines, s3Provider } from '../src/inventory.js';
import { MigrationProgress, formatAggregate } from '../src/migration-view.js';
import { collectCarried, listMigrations, migrateCommand, readMigration } from '../src/migration.js';
import { copyChunk, createCopier, CopyError } from '../src/blob-copy.js';
import { readState, saveState, stateKey } from '../src/state.js';
import { fakeContainer, fakeS3, httpError, PRESIGN_SECRET } from './fakes.js';

const SAS = 'https://acct.blob.core.windows.net/cont?sv=2022-11-02&sp=racwl&se=2099-01-01T00:00:00Z&sig=SECRETSIG123';
const AWS_SECRET = 'awssecretawssecretawssecret';
const SESSION_TOKEN = 'sessiontokensessiontokensessiontoken';
const SOURCE_BASE = 'https://s3.ap-southeast-2.amazonaws.com/bkt/data';
const DEST_BASE = 'https://acct.blob.core.windows.net/cont/data';
const OLD = '2025-06-01T00:00:00Z';

const sink = () => {
  const chunks = [];
  return { isTTY: false, write: (c) => chunks.push(String(c)), text: () => chunks.join('') };
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
/** Waits until `cond()` is true; fails after `ms`. */
async function until(cond, ms = 5000, what = 'a condition') {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(5);
  }
}
const readLines = (file) => fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
const tmp = (name) => fs.mkdtempSync(path.join(os.tmpdir(), `azc-${name}-`));

/** `n` objects data/f001.bin ... of `size` bytes each. */
const many = (n, { size = 10, lastModified = OLD, name = 'f' } = {}) =>
  Object.fromEntries(Array.from({ length: n }, (_, i) => [`data/${name}${String(i + 1).padStart(3, '0')}.bin`, { size, lastModified }]));

/** A fresh output directory, a fake S3 bucket with `objects` and a fake container; `base` holds the migrate options. */
function setup(objects, { pageSize } = {}) {
  const dir = tmp('mig');
  Object.assign(process.env, { AWS_ACCESS_KEY_ID: 'AKIATESTTESTTEST', AWS_SECRET_ACCESS_KEY: AWS_SECRET });
  delete process.env.AWS_SESSION_TOKEN;
  const s3 = fakeS3(objects, { pageSize });
  const container = fakeContainer(s3);
  const base = { outputDir: dir, targetSasUrl: SAS, sourceBucket: 'bkt', sourcePrefix: 'data', sourceRegion: 'ap-southeast-2', s3, container, yes: true };
  const migrationDirs = () => fs.readdirSync(dir).filter((f) => /-migration$/.test(f)).map((f) => path.join(dir, f)).sort((a, b) => readMigration(a).startedAt.localeCompare(readMigration(b).startedAt));
  const migrationDir = () => migrationDirs().at(-1);
  /** Every record of the inventory chunks (not the carried ones), in chunk order. */
  const chunkPaths = (mdir = migrationDir()) => readMigration(mdir).chunks.filter((c) => !c.carried).flatMap((c) => readChunkRecords(path.join(mdir, c.list)).map((r) => r.path));
  return { dir, s3, container, base, migrationDir, migrationDirs, chunkPaths };
}

/** Every file under `dir`, recursively. */
const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]));

// ------------------------------------------------------------- the chunk writer

/** A ChunkWriter in a new folder that records the chunks it closes. */
function writer({ maxFiles = 100, ...options } = {}) {
  const dir = tmp('chunks');
  const closed = [];
  const w = new ChunkWriter({ chunksDir: path.join(dir, 'chunks'), classes: [{ chunkFiles: maxFiles }], maxBytes: 1000, onClosed: async (c, at) => closed.push({ ...c, after: at.resumeAfter, at }), ...options }).open();
  return { dir, w, closed };
}
const rec = (p, size = 1, extra = {}) => ({ path: p, key: `data/${p}`, size, ...extra });

test('ChunkWriter: boundaries by files and by bytes, an oversized object alone; resumeAfter is the last key of the chunk', async () => {
  let { dir, w, closed } = writer({ maxFiles: 2 });
  for (const p of ['a', 'b', 'c', 'd', 'e']) await w.add(rec(p));
  await w.end();
  assert.deepEqual(closed.map((c) => [c.id, c.files, c.bytes, c.list, c.after]), [[1, 2, 2, 'chunks/00001.jsonl', 'data/b'], [2, 2, 2, 'chunks/00002.jsonl', 'data/d'], [3, 1, 1, 'chunks/00003.jsonl', 'data/e']]);
  assert.deepEqual(readChunkRecords(path.join(dir, 'chunks/00001.jsonl')), [{ path: 'a', size: 1 }, { path: 'b', size: 1 }], 'records without the full key');
  assert.ok(!fs.readdirSync(path.join(dir, 'chunks')).some((f) => f.endsWith('.partial')));

  // by bytes: a chunk never goes past the limit; 40 + 30 does not fit in 60
  ({ w, closed } = writer({ maxBytes: 60 }));
  for (const [p, s] of [['a', 40], ['b', 30], ['c', 30], ['d', 20]]) await w.add(rec(p, s));
  await w.end();
  assert.deepEqual(closed.map((c) => [c.files, c.bytes]), [[1, 40], [2, 60], [1, 20]]);

  // an object larger than the limit has a chunk of its own, wherever it is
  ({ w, closed } = writer({ maxBytes: 100 }));
  for (const [p, s] of [['a', 10], ['huge', 500], ['b', 10], ['c', 10]]) await w.add(rec(p, s));
  await w.end();
  assert.deepEqual(closed.map((c) => [c.files, c.bytes]), [[1, 10], [1, 500], [2, 20]]);

  // nothing listed: no chunk
  ({ w, closed } = writer());
  await w.end();
  assert.deepEqual(closed, []);
});

test('ChunkWriter: a chunk is closed by age (injected clock), only once it has objects', async () => {
  let now = 0;
  const { w, closed } = writer({ maxAgeMs: 60_000, now: () => now });
  await w.closeIfOld();
  await w.add(rec('a'));
  now = 59_999;
  await w.closeIfOld();
  assert.equal(closed.length, 0);
  now = 60_000;
  await w.closeIfOld();
  assert.deepEqual(closed.map((c) => [c.files, c.after]), [[1, 'data/a']]);
  now = 500_000;
  await w.closeIfOld(); // no open chunk
  await w.add(rec('b')); // a new chunk opens at 500,000
  now = 559_999;
  await w.add(rec('c'));
  now = 560_000;
  await w.add(rec('d')); // the chunk is old: closed before d is written
  await w.end();
  assert.deepEqual(closed.map((c) => c.files), [1, 2, 1]);
});

test('ChunkWriter: line breaks and archived objects go to skipped.jsonl; excluded paths are counted; open() resumes cleanly', async () => {
  const { dir, w, closed } = writer({ maxFiles: 2, exclude: new Set(['carried']) });
  await w.add(rec('a'));
  await w.add(rec('bad\nkey', 7));
  await w.add(rec('cold', 5, { storageClass: 'GLACIER', archived: true }));
  await w.add(rec('carried'));
  await w.add(rec('b'));
  assert.equal(closed.length, 1);
  const at = closed[0];
  assert.equal(at.after, 'data/b');
  assert.deepEqual([w.skipped, w.archived, w.excluded, w.files], [2, 1, 1, 2]);
  const skippedFile = path.join(dir, 'chunks/skipped.jsonl');
  assert.deepEqual(readLines(skippedFile).map((l) => JSON.parse(l)).map((r) => [r.path, r.reason]), [['bad\nkey', 'line break in the key'], ['cold', 'archived (GLACIER)']]);
  const savedBytes = w.skippedBytes;
  assert.equal(savedBytes, fs.statSync(skippedFile).size);

  // more after the last closed chunk, then the process stops: an open chunk and a skipped line past savedBytes
  await w.add(rec('c'));
  await w.add(rec('d\re', 3));
  assert.ok(fs.existsSync(path.join(dir, 'chunks/00002.jsonl.partial')));
  assert.equal(readLines(skippedFile).length, 3);

  const again = new ChunkWriter({ chunksDir: path.join(dir, 'chunks'), classes: [{ chunkFiles: 2 }], maxBytes: 1000, nextId: 2, skippedBytes: savedBytes }).open();
  assert.ok(!fs.existsSync(path.join(dir, 'chunks/00002.jsonl.partial')), 'the open chunk is deleted');
  assert.equal(readLines(skippedFile).length, 2, 'skipped.jsonl is cut back');
  await again.add(rec('c'));
  await again.end();
  assert.deepEqual(readChunkRecords(path.join(dir, 'chunks/00002.jsonl')).map((r) => r.path), ['c']);
});

test('writeCarriedChunks: the carried files as the first chunks, split by --chunk-files', () => {
  const dir = tmp('carried');
  const chunks = writeCarriedChunks({ carried: new Map([['a', 1], ['b', 2], ['c', 3]]), chunksDir: path.join(dir, 'chunks'), classes: [{ chunkFiles: 2 }] });
  assert.deepEqual(chunks, [{ id: 1, list: 'chunks/00001.jsonl', files: 2, bytes: 3, carried: true }, { id: 2, list: 'chunks/00002.jsonl', files: 1, bytes: 3, carried: true }]);
  assert.deepEqual(readChunkRecords(path.join(dir, 'chunks/00002.jsonl')), [{ path: 'c', size: 3 }]);
});

// ------------------------------------------------------------- size classes

/** A size profile file with `classes`; returns its path. */
function profileFile(classes) {
  const file = path.join(tmp('profile'), 'profile.json');
  fs.writeFileSync(file, typeof classes === 'string' ? classes : JSON.stringify({ classes }));
  return file;
}

const TWO_CLASSES = [{ name: 'small', below: 100, chunkFiles: 2, concurrency: 4 }, { name: 'big', chunkFiles: 3, concurrency: 1, chunkBytes: 1000 }];

test('size classes: the defaults, the class of a size (`below` is the next class), S3 key order, a profile file', () => {
  assert.deepEqual(DEFAULT_SIZE_CLASSES.map((c) => [c.name, c.below, c.chunkFiles, c.concurrency]), [
    ['very-small', 2 ** 20, 100_000, 128], ['small', 64 * 2 ** 20, 50_000, 64], ['medium', 2 ** 30, 10_000, 16], ['large', 100 * 2 ** 30, 1_000, 8], ['very-large', undefined, 50, 2],
  ]);
  assert.deepEqual([0, 2 ** 20 - 1, 2 ** 20, 2 ** 30, 2 ** 50].map((s) => classOf(DEFAULT_SIZE_CLASSES, s).name), ['very-small', 'very-small', 'small', 'large', 'very-large']);
  // outside the BMP: JavaScript and S3 (UTF-8 bytes) order these two keys differently
  assert.ok('\u{1F600}' < '\uFF5A');
  assert.ok(compareKeys('\u{1F600}', '\uFF5A') > 0);
  assert.equal(compareKeys('a', 'a'), 0);

  const file = profileFile([
    { name: 'tiny', below: '1MiB', chunkFiles: 100, concurrency: 64 },
    { name: 'huge', chunkFiles: 5, concurrency: 2, chunkBytes: '4TiB' },
  ]);
  assert.deepEqual(readSizeProfile(file), [{ name: 'tiny', below: 2 ** 20, chunkFiles: 100, concurrency: 64 }, { name: 'huge', chunkFiles: 5, concurrency: 2, chunkBytes: 4 * 2 ** 40 }]);

  const bad = (content) => () => readSizeProfile(profileFile(content));
  const last = { name: 'last', chunkFiles: 1, concurrency: 1 };
  assert.throws(() => readSizeProfile(path.join(tmp('profile'), 'none.json')), (e) => e instanceof UsageError && /Cannot read the size profile .*no such file/.test(e.message));
  assert.throws(bad('{ nope'), /is not valid JSON/);
  assert.throws(bad([]), /1 to 10 classes/);
  assert.throws(bad(Array.from({ length: 11 }, (_, i) => ({ ...last, name: `c${i}`, below: i + 1 }))), /1 to 10 classes/);
  assert.throws(bad([{ ...last, name: 'Big Files' }]), /class 1 \("Big Files"\) needs a "name" of lower-case letters/);
  assert.throws(bad([{ ...last, below: 5 }, { ...last }]), /the name "last" is used twice/);
  assert.throws(bad([{ ...last, name: 'a', below: 1 }, { ...last, below: 5 }]), /the last class, "last", holds every larger object: it has no "below"/);
  assert.throws(bad([{ ...last, name: 'a' }, last]), /class 1 \("a"\) needs "below"/);
  assert.throws(bad([{ ...last, name: 'a', below: '64MiB' }, { ...last, name: 'b', below: '1MiB' }, last]), /"below" must grow from one class to the next: "b" \(1 MiB\) is not above "a" \(64 MiB\)/);
  assert.throws(bad([{ ...last, chunkFiles: 0 }]), /Invalid "chunkFiles" of class 1 \("last"\)/);
  assert.throws(bad([{ ...last, concurrency: 'many' }]), /Invalid "concurrency" of class 1/);
  assert.throws(bad([{ ...last, name: 'a', below: 'lots' }, last]), /Invalid "below" of class 1/);
  assert.throws(bad([{ ...last, parallel: 3 }]), /unknown setting\(s\) parallel/);
});

test('ChunkWriter by size class: each object in the chunk of its class; each class closes at its own files, bytes and age', async () => {
  let now = 0;
  const { dir, w, closed } = writer({ classes: TWO_CLASSES, maxAgeMs: 60_000, now: () => now });
  await w.add(rec('a', 10)); // small: chunk 1
  await w.add(rec('b', 100)); // `below` exactly: big, chunk 2
  await w.add(rec('c', 99)); // small: chunk 1 is full (2 files)
  assert.deepEqual(closed.map((c) => [c.id, c.sizeClass, c.files, c.bytes]), [[1, 'small', 2, 109]]);
  assert.deepEqual(closed[0].at, { listedThrough: 'data/c', closedThrough: { small: 'data/c', big: 'data/a' }, resumeAfter: 'data/a' });
  await w.add(rec('d', 500));
  await w.add(rec('e', 600)); // 600 more would take chunk 2 past the big class's 1000 bytes: closed before e
  assert.deepEqual(closed.at(-1).at, { listedThrough: 'data/d', closedThrough: { small: 'data/d', big: 'data/d' }, resumeAfter: 'data/d' });
  now = 30_000;
  await w.add(rec('f', 1)); // small: chunk 4, 30 s younger than chunk 3
  now = 60_000;
  await w.closeIfOld(); // only chunk 3 is old
  assert.deepEqual(closed.map((c) => [c.id, c.sizeClass, c.files]), [[1, 'small', 2], [2, 'big', 2], [3, 'big', 1]]);
  assert.deepEqual(closed.at(-1).at, { listedThrough: 'data/f', closedThrough: { small: 'data/e', big: 'data/f' }, resumeAfter: 'data/e' });
  assert.ok(fs.existsSync(path.join(dir, 'chunks/00004.jsonl.partial')));
  await w.end();
  assert.deepEqual(closed.map((c) => [c.id, c.sizeClass, c.files, c.bytes]), [[1, 'small', 2, 109], [2, 'big', 2, 600], [3, 'big', 1, 600], [4, 'small', 1, 1]]);
  assert.deepEqual(readChunkRecords(path.join(dir, 'chunks/00002.jsonl')).map((r) => r.path), ['b', 'd']);
  assert.deepEqual([w.files, w.bytes, w.listed], [6, 1310, 6]);

  // the big class closes at its own 3 files
  const big = writer({ classes: TWO_CLASSES });
  for (const p of ['x', 'y', 'z']) await big.w.add(rec(p, 200));
  assert.deepEqual(big.closed.map((c) => [c.sizeClass, c.files]), [['big', 3]]);

  // abandon deletes every open chunk
  const both = writer({ classes: TWO_CLASSES });
  await both.w.add(rec('a', 1));
  await both.w.add(rec('b', 500));
  await both.w.abandon();
  assert.deepEqual(fs.readdirSync(path.join(both.dir, 'chunks')), []);
});

test('ChunkWriter by size class: a resumed listing drops what is recorded and adds again what was in a lost open chunk', async () => {
  // stopped after: a (small, open chunk lost), b (big, closed), c (small, lost), d (big, closed); then e, not listed
  const resume = { startAfter: null, listedThrough: 'data/d', closedThrough: { small: null, big: 'data/d' } };
  const { w, closed } = writer({ classes: TWO_CLASSES, resume, nextId: 8 });
  for (const [p, s] of [['a', 1], ['b', 500], ['c', 1], ['d', 500], ['e', 1]]) await w.add(rec(p, s));
  await w.end();
  assert.deepEqual(closed.map((c) => [c.id, c.sizeClass, c.files]), [[8, 'small', 2], [9, 'small', 1]]);
  assert.deepEqual([w.files, w.listed], [3, 3]);
  assert.deepEqual(closed[0].at, { listedThrough: 'data/d', closedThrough: { small: 'data/c', big: 'data/d' }, resumeAfter: 'data/c' });
});

test('writeCarriedChunks by size class: each class split by its own chunkFiles', () => {
  const dir = tmp('carried');
  const carried = new Map([['a', 1], ['b', 500], ['c', 2], ['d', 600], ['e', 3], ['f', 700], ['g', 800]]);
  const chunks = writeCarriedChunks({ carried, chunksDir: path.join(dir, 'chunks'), classes: TWO_CLASSES });
  assert.deepEqual(chunks.map((c) => [c.id, c.sizeClass, c.files, c.bytes, c.carried]), [[1, 'small', 2, 3, true], [2, 'small', 1, 3, true], [3, 'big', 3, 1800, true], [4, 'big', 1, 800, true]]);
  assert.deepEqual(readChunkRecords(path.join(dir, 'chunks/00003.jsonl')).map((r) => r.path), ['b', 'd', 'f']);
});

// ------------------------------------------------------------- listing and analysis

test('S3 provider: pages, prefix, folder markers, date filter, StartAfter, RestoreStatus and archived objects', async () => {
  const s3 = fakeS3({
    'data/': { size: 0 },
    'data/a.txt': { size: 10, lastModified: '2026-01-01T00:00:00Z' },
    'data/sub/b c.txt': { size: 20, lastModified: '2026-02-01T00:00:00Z', storageClass: 'GLACIER' },
    'data/sub/': { size: 0 },
    'data/new.txt': { size: 30, lastModified: '2026-03-01T00:00:00Z', storageClass: 'DEEP_ARCHIVE', restore: { IsRestoreInProgress: false, RestoreExpiryDate: new Date(Date.now() + 86400e3) } },
    'data/old-restore.txt': { size: 1, lastModified: '2026-03-01T00:00:00Z', storageClass: 'GLACIER', restore: { IsRestoreInProgress: false, RestoreExpiryDate: new Date(Date.now() - 1000) } },
    'other/x.txt': { size: 99 },
  }, { pageSize: 2 });
  const collect = async (extra = {}) => {
    s3.pages.length = 0;
    const seen = [];
    await s3Provider({ bucket: 'bkt', prefix: 'data', listPage: s3.listPage, ...extra }).list((o) => seen.push(o));
    return seen;
  };
  const seen = await collect();
  assert.deepEqual(seen.map((o) => [o.path, o.key, o.size, o.storageClass, Boolean(o.archived)]), [
    ['a.txt', 'data/a.txt', 10, 'STANDARD', false],
    ['new.txt', 'data/new.txt', 30, 'DEEP_ARCHIVE', false], // restored
    ['old-restore.txt', 'data/old-restore.txt', 1, 'GLACIER', true], // the restored copy expired
    ['sub/b c.txt', 'data/sub/b c.txt', 20, 'GLACIER', true],
  ]);
  assert.equal(seen[0].lastModified, '2026-01-01T00:00:00.000Z');
  assert.ok(s3.pages.length >= 3, 'several pages');
  assert.ok(s3.pages.every((r) => r.Bucket === 'bkt' && r.Prefix === 'data/' && r.MaxKeys === 1000 && r.OptionalObjectAttributes[0] === 'RestoreStatus'));

  assert.deepEqual((await collect({ includeAfter: '2026-02-01T00:00:00Z' })).map((o) => o.path), ['new.txt', 'old-restore.txt', 'sub/b c.txt'], 'on/after the date');
  assert.deepEqual((await collect({ startAfter: 'data/new.txt' })).map((o) => o.path), ['old-restore.txt', 'sub/b c.txt']);
  assert.equal(s3.pages[0].StartAfter, 'data/new.txt');
  assert.ok(s3.pages.slice(1).every((p) => p.StartAfter === undefined && p.ContinuationToken), 'StartAfter on the first page only');
  assert.deepEqual((await collect({ prefix: '' })).map((o) => o.path).at(-1), 'other/x.txt');

  await assert.rejects(s3Provider({ bucket: 'bkt', listPage: async () => { throw Object.assign(new Error('denied'), { name: 'AccessDenied' }); } }).list(() => {}), /S3 listing failed: AccessDenied: denied/);
});

test('analysis: read from the chunk files and skipped.jsonl; archived objects reported from the skipped records', async () => {
  const dir = tmp('ana');
  const GiB = 2 ** 30;
  const write = (name, records) => {
    const file = path.join(dir, name);
    fs.writeFileSync(file, records.map((r) => `${JSON.stringify(r)}\n`).join(''));
    return file;
  };
  const files = [
    write('00001.jsonl', [{ path: 'data/a.txt', size: 10, storageClass: 'STANDARD' }, { path: 'data/b.txt', size: 2 * 2 ** 20, storageClass: 'STANDARD' }]),
    write('00002.jsonl', [{ path: 'root.txt', size: 1 }]),
    write('skipped.jsonl', [{ path: 'logs/c.log', size: 5 * GiB, storageClass: 'GLACIER', reason: 'archived (GLACIER)' }, { path: 'logs/d.log', size: 200 * GiB, storageClass: 'DEEP_ARCHIVE', reason: 'archived (DEEP_ARCHIVE)' }, { path: 'x\ny', size: 3, reason: 'line break in the key' }]),
    path.join(dir, 'missing.jsonl'),
  ];
  const summary = await analyseInventory(files, path.join(dir, 'inventory-summary.json'));
  assert.deepEqual([summary.files, summary.bytes], [6, 10 + 2 * 2 ** 20 + 205 * GiB + 1 + 3]);
  assert.deepEqual(summary.sizes.map((s) => s.files), [3, 1, 1, 1]);
  assert.deepEqual(summary.largest.map((l) => l.path).slice(0, 3), ['logs/d.log', 'logs/c.log', 'data/b.txt']);
  assert.deepEqual(summary.topLevel.map((p) => [p.prefix, p.files]), [['logs/', 2], ['data/', 2], ['(root)', 2]]);
  assert.deepEqual([summary.skipped.files, summary.archived.files], [3, 2]);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'inventory-summary.json'), 'utf8')).files, 6);
  const lines = analysisLines(summary, { shownPrefixes: 2 });
  assert.match(lines[0], /^6 objects, 205\.00 GiB/);
  assert.match(lines[2], /^top level {2}logs\/ 2 \(205\.00 GiB\) · data\/ 2 \(.*\) · 1 more/);
  assert.ok(lines.some((l) => /^WARNING: 2 archived object\(s\) .* are skipped/.test(l)));
});

test('MigrationProgress: while the listing runs the total has a +, and there is no ETA', () => {
  const chunks = [
    { id: 1, bytes: 1000, status: 'success', copied: 10, ignored: 1, missing: 1, failed: 0, bytesCopied: 900 },
    { id: 2, bytes: 1000, status: 'running', copied: 0, ignored: 0, failed: 0, bytesCopied: 0 },
    { id: 3, bytes: 1000, status: 'pending', copied: 0, ignored: 0, failed: 0, bytesCopied: 0 },
    { id: 4, bytes: 1000, status: 'exhausted', copied: 5, ignored: 0, failed: 2, bytesCopied: 400 },
  ];
  let now = 0;
  const progress = new MigrationProgress({ chunks, now: () => now });
  progress.listing = { files: 4200 };
  progress.update(2, { copied: 3, ignored: 0, missing: 0, failed: 1, bytesDone: 250, bytesTotal: 1000 });
  now = 1000;
  const s = progress.snapshot(now);
  assert.deepEqual([s.chunksTotal, s.chunksDone, s.chunksRunning, s.chunksPending, s.chunksExhausted], [4, 2, 1, 1, 1]);
  assert.deepEqual([s.copied, s.failed, s.ignored, s.missing], [18, 3, 1, 1]);
  assert.equal(s.bytesDone, 1000 + 250 + 400);
  assert.ok(Number.isNaN(s.etaSeconds));
  assert.match(formatAggregate(s), /^LISTING\+COPYING \| listed 4,200 \(4 chunks\) \| chunks 2\/4 done, 1 running \| copied 18 \| ignored 1 \| missing 1 \| failed 3 \| 1\.61 KiB \/ 3\.91 KiB\+ \| .* \| ETA after listing$/);

  progress.listing = null;
  progress.update(2, { copied: 6, ignored: 0, failed: 1, bytesDone: 750, bytesTotal: 1000 });
  now = 2000;
  const later = progress.snapshot(now);
  assert.equal(later.throughput, 500);
  assert.equal(later.etaSeconds, (4000 - 2150) / 500);
  assert.match(formatAggregate(later), /^COPYING \| chunks 2\/4 done, 1 running \| copied 21 \| ignored 1 \| missing 1 \| failed 3 \| 2\.10 KiB \/ 3\.91 KiB \(53\.8%\) \| 500 B\/s \| ETA 4s$/);
  assert.deepEqual(later.classes, [], 'uniform chunks: no size classes');
  assert.equal(later.averageThroughput, 750 / 2, 'what this run did (chunk 2), over its 2 seconds');
});

test('MigrationProgress: the numbers of each running chunk and the totals of each size class', () => {
  const chunks = [
    { id: 1, sizeClass: 'small', files: 10, bytes: 1000, status: 'success', copied: 10, ignored: 0, failed: 0, bytesCopied: 1000 },
    { id: 2, sizeClass: 'small', files: 20, bytes: 2000, status: 'running', copied: 0, ignored: 0, failed: 0, bytesCopied: 0 },
    { id: 3, sizeClass: 'large', files: 2, bytes: 8000, status: 'exhausted', copied: 1, ignored: 0, failed: 1, bytesCopied: 4000 },
    { id: 4, sizeClass: 'small', files: 5, bytes: 500, status: 'pending', copied: 0, ignored: 0, failed: 0, bytesCopied: 0 },
  ];
  let now = 0;
  const progress = new MigrationProgress({ chunks, now: () => now });
  progress.update(2, { copied: 6, ignored: 2, missing: 1, failed: 1, bytesDone: 500, bytesTotal: 2000, filesTotal: 20 });
  now = 1000;
  const s = progress.snapshot(now);
  assert.deepEqual(s.running, [{ id: 2, sizeClass: 'small', percent: 25, filesDone: 10, filesTotal: 20, bytesDone: 500, bytesTotal: 2000, failed: 1 }]);
  assert.deepEqual(s.classes, [
    { name: 'small', chunks: 3, done: 1, running: 1, pending: 1, exhausted: 0, files: 35, bytes: 3500, bytesDone: 1500 },
    { name: 'large', chunks: 1, done: 1, running: 0, pending: 0, exhausted: 1, files: 2, bytes: 8000, bytesDone: 4000 },
  ]);
  assert.equal(s.averageThroughput, 500, 'chunks 1 and 3 were done before this run: only chunk 2 counts');
});

// ------------------------------------------------------------- the copy of one object

/** A copier over a fake bucket and container. */
function copier(objects, options = {}) {
  const s3 = fakeS3(objects);
  const container = fakeContainer(s3);
  return { s3, container, copy: createCopier({ s3, container, prefix: 'data', ...options }) };
}

test('copier: Put Blob From URL with headers and valid metadata; append-only; S3 404 is missing; zero-byte objects', async () => {
  const { container, copy } = copier({
    'data/a b.txt': { size: 10, contentType: 'text/plain', metadata: { owner: 'x', 'original-filename': 'y' } },
    'data/empty': { size: 0 },
  });
  assert.deepEqual(await copy({ path: 'a b.txt' }), { result: 'copied', bytes: 10, invalidMetadata: ['original-filename'] });
  const blob = container.blobs.get('data/a b.txt');
  assert.deepEqual([blob.size, blob.from, blob.headers.blobContentType, blob.metadata], [10, 'data/a b.txt', 'text/plain', { owner: 'x' }]);
  assert.deepEqual(container.requests[0].conditions, { ifNoneMatch: '*' });

  // the blob exists: ignored, its content unchanged
  const before = container.blobs.get('data/a b.txt');
  assert.equal((await copy({ path: 'a b.txt' })).result, 'ignored');
  assert.equal(container.blobs.get('data/a b.txt'), before);

  assert.deepEqual(await copy({ path: 'gone' }), { result: 'missing', bytes: 0 });
  assert.equal((await copy({ path: 'empty' })).result, 'copied');
  assert.deepEqual([container.blobs.get('data/empty').size, container.blobs.get('data/empty').from], [0, 'upload']);
});

test('copier: --overwrite-modified writes an older blob again and ignores a newer one', async () => {
  const { container, copy } = copier({ 'data/old.txt': { size: 5, lastModified: '2026-02-01T00:00:00Z' }, 'data/new.txt': { size: 6, lastModified: '2026-02-01T00:00:00Z' } }, { overwriteModified: true });
  container.seed('data/old.txt', { lastModified: '2026-01-01T00:00:00Z' });
  container.seed('data/new.txt', { lastModified: '2026-03-01T00:00:00Z' });
  assert.equal((await copy({ path: 'old.txt' })).result, 'copied');
  assert.equal(container.blobs.get('data/old.txt').size, 5);
  assert.equal((await copy({ path: 'new.txt' })).result, 'ignored');
  assert.equal(container.blobs.get('data/new.txt').from, 'seed');
  assert.deepEqual(container.requests.filter((r) => r.name === 'data/old.txt').map((r) => Object.keys(r.conditions)), [['ifNoneMatch'], ['ifUnmodifiedSince']]);
});

test('copier: above the block size, staged blocks with ids of equal length, then one commit; an existing blob stages nothing', async () => {
  const { s3, container, copy } = copier({ 'data/big.bin': { size: 25 }, 'data/there.bin': { size: 30 } }, { blockSize: 10 });
  assert.equal((await copy({ path: 'big.bin' })).result, 'copied');
  const stages = container.requests.filter((r) => r.request === 'stage');
  assert.deepEqual(stages.map((r) => [r.block.offset, r.block.count]), [[0, 10], [10, 10], [20, 5]]);
  assert.equal(new Set(stages.map((r) => r.block.id.length)).size, 1);
  const commits = container.requests.filter((r) => r.request === 'commit');
  assert.equal(commits.length, 1);
  assert.deepEqual(commits[0].ids, stages.map((r) => r.block.id));
  assert.deepEqual(commits[0].conditions, { ifNoneMatch: '*' });
  assert.equal(container.blobs.get('data/big.bin').size, 25);
  assert.equal(s3.presigned, 3, 'one presigned URL per block');

  container.seed('data/there.bin');
  container.requests.length = 0;
  assert.equal((await copy({ path: 'there.bin' })).result, 'ignored');
  assert.deepEqual(container.requests.map((r) => r.request), ['properties']);
});

test('copier: a presigned URL longer than 2 KiB fails with SourceUrlTooLong without calling Azure', async () => {
  const { s3, container, copy } = copier({ 'data/a.txt': { size: 10 } });
  s3.longUrl = () => true;
  await assert.rejects(copy({ path: 'a.txt' }), (e) => e instanceof CopyError && e.code === 'SourceUrlTooLong');
  assert.equal(container.requests.length, 0);
});

test('copyChunk: counts, failed list without query strings, log with the invalid metadata names, run.json', async () => {
  const { s3, container, copy } = copier({ 'data/a.txt': { size: 1, metadata: { 'bad-name': '1' } }, 'data/b c.txt': { size: 2 }, 'data/c.txt': { size: 3 }, 'data/d.txt': { size: 4 } });
  container.seed('data/c.txt');
  container.fail = (name) => (name === 'data/b c.txt' ? httpError(403, 'AuthorizationFailure') : null);
  const runDir = path.join(tmp('chunk'), 'run');
  const snapshots = [];
  const failures = [];
  const report = await copyChunk({
    records: [{ path: 'a.txt', size: 1 }, { path: 'b c.txt', size: 2 }, { path: 'c.txt', size: 3 }, { path: 'd.txt', size: 4 }, { path: 'gone.txt', size: 5 }],
    concurrency: 2,
    copy,
    runDir,
    manifest: { kind: 'chunk', chunk: 1 },
    sourceBase: SOURCE_BASE,
    destBase: DEST_BASE,
    onProgress: (s) => snapshots.push(s),
    onFailure: (p, code) => failures.push([p, code]),
  });
  assert.deepEqual([report.outcome, report.copied, report.ignored, report.missing, report.failed, report.bytesCopied], ['partial', 2, 1, 1, 1, 5]);
  assert.deepEqual(failures, [['b c.txt', 'AuthorizationFailure']]);
  assert.deepEqual(snapshots.at(-1), { copied: 2, ignored: 1, missing: 1, failed: 1, bytesDone: 15, bytesTotal: 15, filesTotal: 5 });
  assert.deepEqual(readLines(report.files.failed).map((l) => JSON.parse(l)), [{ relativePath: 'b c.txt', src: `${SOURCE_BASE}/b%20c.txt`, dst: `${DEST_BASE}/b%20c.txt`, errorCode: 'AuthorizationFailure', size: 2 }]);
  const log = fs.readFileSync(report.files.log, 'utf8');
  assert.match(log, /metadata left out \(not a valid Azure metadata name\): bad-name/);
  assert.match(log, /missing at the source .*gone\.txt/);
  assert.match(log, /partial: copied 2, ignored 1 \(already at the target\), missing 1, failed 1/);
  const manifest = JSON.parse(fs.readFileSync(path.join(runDir, 'run.json'), 'utf8'));
  assert.deepEqual([manifest.kind, manifest.outcome, manifest.files, manifest.copied, manifest.failed], ['chunk', 'partial', 5, 2, 1]);
  assert.ok(!/X-Amz|PRESIGN/.test(log + fs.readFileSync(report.files.failed, 'utf8')));
  assert.equal(s3.heads.length, 5);
});

// ------------------------------------------------------------- migrate, end to end with the fakes

const MIXED = {
  'data/': { size: 0 },
  'data/a b.txt': { size: 10, contentType: 'text/plain', metadata: { owner: 'me' } },
  'data/dir/': { size: 0 },
  'data/dir/c.txt': { size: 20 },
  'data/é ü/ñ.txt': { size: 30 },
  'data/bad\nkey': { size: 7 },
  'data/cold.bin': { size: 40, storageClass: 'GLACIER' },
  'data/warm.bin': { size: 50, storageClass: 'GLACIER', restore: { IsRestoreInProgress: false } },
  'data/empty': { size: 0 },
  'other/x.txt': { size: 99 },
};

test('migrate: list into chunks and copy them; every object at its name and size; skipped keys; state.json and analysis', async () => {
  const { dir, base, container, migrationDir, chunkPaths } = setup(MIXED, { pageSize: 2 });
  const out = sink();
  assert.equal(await migrateCommand({ ...base, chunkFiles: '2' }, out), 0, out.text());
  const mdir = migrationDir();
  assert.match(path.basename(mdir), /^\d{8}T\d{6}Z-migration$/);
  const expected = ['data/a b.txt', 'data/dir/c.txt', 'data/empty', 'data/warm.bin', 'data/é ü/ñ.txt'];
  assert.deepEqual([...container.blobs.keys()].sort(), expected);
  for (const name of expected) assert.equal(container.blobs.get(name).size, MIXED[name].size);
  assert.deepEqual(container.blobs.get('data/a b.txt').metadata, { owner: 'me' });

  const m = readMigration(mdir);
  assert.equal(m.format, 2);
  assert.equal(m.outcome, 'success');
  assert.deepEqual([m.inventory.status, m.inventory.files, m.inventory.skipped, m.inventory.archived], ['done', 5, 2, 1]);
  assert.equal(m.inventory.resumeAfter, 'data/é ü/ñ.txt');
  assert.ok(m.chunks.length >= 3 && m.chunks.every((c) => c.status === 'success' && c.attempts === 1 && c.list.endsWith('.jsonl')));
  assert.equal(m.chunks.reduce((s, c) => s + c.copied, 0), 5);
  assert.deepEqual(chunkPaths(mdir).sort(), expected.map((p) => p.slice('data/'.length)).sort());
  const skipped = readLines(path.join(mdir, 'chunks/skipped.jsonl')).map((l) => JSON.parse(l));
  assert.deepEqual(skipped.map((r) => [r.path, r.reason]).sort(), [['bad\nkey', 'line break in the key'], ['cold.bin', 'archived (GLACIER)']]);
  assert.equal(JSON.parse(fs.readFileSync(path.join(mdir, 'inventory-summary.json'), 'utf8')).files, 7);
  assert.ok(!walk(mdir).some((f) => f.endsWith('.partial') || f.endsWith('inventory.jsonl')));
  // one attempt folder per chunk, with its files
  const run = path.join(mdir, m.chunks[0].runs[0]);
  assert.ok(fs.existsSync(path.join(run, 'run.json')) && fs.readdirSync(run).some((f) => /^copy-.*\.log$/.test(f)));

  const state = readState(path.join(dir, 'state.json'));
  assert.equal(state[stateKey(SOURCE_BASE, DEST_BASE)].runDir, mdir);
  const text = out.text();
  assert.match(text, /Inventory \(S3 ListObjectsV2\)/);
  assert.match(text, /Not copied: {7}2 key\(s\) \(1 archived \(not restored\), 1 with a line break\)/);
  assert.match(text, /Status: {11}Migration completed/);
});

test('migrate: copying starts while the listing runs (page 3 is held until chunk 1 is copied)', async () => {
  const { base, s3, container, migrationDir } = setup(many(8), { pageSize: 2 });
  let held = false;
  s3.beforePage = async (n) => {
    if (n !== 2) return;
    held = true;
    await until(() => ['data/f001.bin', 'data/f002.bin'].every((k) => container.blobs.has(k)), 5000, 'chunk 1 to be copied');
  };
  assert.equal(await migrateCommand({ ...base, chunkFiles: '2' }, sink()), 0);
  assert.ok(held);
  assert.equal(container.blobs.size, 8);
  assert.equal(readMigration(migrationDir()).chunks.length, 4);
});

test('migrate: a delta that finds 3 objects in a long listing copies them before the listing ends (--chunk-minutes)', async () => {
  const objects = { ...many(3, { name: 'a-new', lastModified: '2026-02-01T00:00:00Z' }), ...many(40, { name: 'z-old' }) };
  const { base, s3, container } = setup(objects, { pageSize: 2 });
  let clock = 0;
  const lastPage = 21; // 43 keys, 2 per page
  s3.beforePage = async (n) => {
    clock += 60_000; // each page takes a minute
    if (n === lastPage) await until(() => container.blobs.size === 3, 5000, 'the 3 modified objects to be copied');
  };
  assert.equal(await migrateCommand({ ...base, lastCopyDate: '2026-01-01', chunkMinutes: '1', now: () => clock }, sink()), 0);
  assert.equal(s3.pages.length, lastPage + 1);
  assert.deepEqual([...container.blobs.keys()].sort(), Object.keys(objects).filter((k) => k.includes('a-new')));
});

test('migrate: never more than --parallel chunks and --concurrency objects at once', async () => {
  const { base, s3, container } = setup(many(30), { pageSize: 5 });
  s3.delayMs = 5;
  container.delayMs = 5;
  let running = 0;
  let maxRunning = 0;
  const view = {
    chunkStarted: () => (maxRunning = Math.max(maxRunning, ++running)),
    chunkEnded: () => running--,
    message() {},
    failure() {},
    log() {},
    summary() {},
  };
  assert.equal(await migrateCommand({ ...base, chunkFiles: '5', parallel: '2', concurrency: '3', view }, sink()), 0);
  assert.equal(container.blobs.size, 30);
  assert.equal(maxRunning, 2);
  assert.ok(s3.maxHeadsInFlight <= 6 && container.maxWritesInFlight <= 6, `${s3.maxHeadsInFlight} / ${container.maxWritesInFlight}`);
  assert.ok(container.maxWritesInFlight > 3, 'chunks were copied at the same time');
});

test('migrate: failed files are tried again alone; a chunk out of attempts is exhausted and the outcome partial; a delta carries them', async () => {
  const { base, container, migrationDirs } = setup(many(4), { pageSize: 10 });
  let fails = 1;
  container.fail = (name) => (name === 'data/f002.bin' && fails-- > 0 ? httpError(500, 'InternalError') : null);
  assert.equal(await migrateCommand({ ...base, chunkFiles: '2' }, sink()), 0);
  let m = readMigration(migrationDirs()[0]);
  assert.deepEqual(m.chunks.map((c) => [c.status, c.attempts, c.copied, c.failed]), [['success', 2, 2, 0], ['success', 1, 2, 0]]);
  assert.equal(m.chunks[0].lastAction, 'retry');
  const retried = path.join(migrationDirs()[0], m.chunks[0].runs[1], 'run.json');
  assert.equal(JSON.parse(fs.readFileSync(retried, 'utf8')).files, 1, 'the retry copies only the failed path');

  // a file that always fails: exhausted after --max-attempts
  const second = setup(many(5), { pageSize: 10 });
  second.container.fail = (name) => (name === 'data/f005.bin' ? httpError(403, 'AuthorizationPermissionMismatch') : null);
  const out = sink();
  assert.equal(await migrateCommand({ ...second.base, chunkFiles: '10', maxAttempts: '2' }, out), 1);
  m = readMigration(second.migrationDir());
  assert.deepEqual(m.chunks.map((c) => [c.status, c.lastOutcome, c.attempts, c.failed]), [['exhausted', 'partial', 2, 1]]);
  assert.equal(m.outcome, 'partial');
  assert.match(out.text(), /Files failed: {5}1/);

  // the delta carries the failed file into its first chunk; a carried key modified since stays in its carried chunk
  second.container.fail = () => null;
  second.s3.put('data/f005.bin', { size: 10 }); // modified now
  second.s3.put('data/g-new.bin', { size: 3 });
  assert.equal(await migrateCommand({ ...second.base, lastCopyDate: 'auto' }, sink()), 0);
  const delta = second.migrationDir();
  assert.match(path.basename(delta), /-delta-migration$/);
  const d = readMigration(delta);
  assert.deepEqual(d.chunks.map((c) => [c.id, Boolean(c.carried), c.files]), [[1, true, 1], [2, false, 1]]);
  assert.deepEqual(readChunkRecords(path.join(delta, d.chunks[0].list)).map((r) => r.path), ['f005.bin']);
  assert.deepEqual(second.chunkPaths(delta), ['g-new.bin']);
  assert.equal(d.carried.inListing, 1);
  assert.equal(second.container.writeCount.get('data/f005.bin'), 1);
  assert.ok(second.container.blobs.has('data/g-new.bin'));
});

test('migrate: Ctrl+C during the listing; continuing lists again after the last closed chunk and every key is in one chunk', async () => {
  const keys = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'g\nbad', 'h', 'i', 'j'];
  const { base, s3, container, migrationDir, chunkPaths } = setup(Object.fromEntries(keys.map((k) => [`data/${k}`, { size: 1 }])), { pageSize: 2 });
  const ctrlC = new AbortController();
  s3.beforePage = async (n) => {
    if (n === 4) ctrlC.abort(); // pages: [a b] [c d] [e f] [g g\nbad] | [h i] [j]
  };
  assert.equal(await migrateCommand({ ...base, chunkFiles: '3', abortSignal: ctrlC.signal }, sink()), 130);
  const mdir = migrationDir();
  let m = readMigration(mdir);
  assert.equal(m.outcome, 'interrupted');
  assert.deepEqual([m.inventory.status, m.inventory.resumeAfter, m.chunks.length, m.inventory.skippedFileBytes], ['running', 'data/f', 2, 0]);
  assert.ok(!fs.readdirSync(path.join(mdir, 'chunks')).some((f) => f.endsWith('.partial')));

  s3.pages.length = 0;
  s3.beforePage = null;
  const out = sink();
  assert.equal(await migrateCommand({ ...base, sourceBucket: undefined, migration: mdir }, out), 0, out.text());
  assert.equal(s3.pages[0].StartAfter, 'data/f');
  m = readMigration(mdir);
  assert.equal(m.inventory.status, 'done');
  const paths = chunkPaths(mdir);
  assert.deepEqual(paths, ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j'], 'every key once, in order');
  assert.deepEqual(readLines(path.join(mdir, 'chunks/skipped.jsonl')), [JSON.stringify({ path: 'g\nbad', size: 1, reason: 'line break in the key', storageClass: 'STANDARD', lastModified: '2026-01-15T00:00:00.000Z' })]);
  assert.equal(container.blobs.size, 10);
  assert.ok([...container.writeCount.values()].every((n) => n === 1));
});

test('migrate: Ctrl+C during the copy ends with 130; continuing copies the rest, each object once', async () => {
  const { base, container, migrationDir } = setup(many(12), { pageSize: 100 });
  container.delayMs = 20;
  const ctrlC = new AbortController();
  const stop = until(() => container.blobs.size >= 2).then(() => ctrlC.abort());
  assert.equal(await migrateCommand({ ...base, chunkFiles: '4', parallel: '1', concurrency: '2', abortSignal: ctrlC.signal }, sink()), 130);
  await stop;
  const mdir = migrationDir();
  const m = readMigration(mdir);
  assert.ok(m.chunks.some((c) => c.status === 'interrupted'));
  assert.ok(container.blobs.size < 12);
  container.delayMs = 0;
  assert.equal(await migrateCommand({ ...base, sourceBucket: undefined, migration: mdir }, sink()), 0);
  assert.equal(container.blobs.size, 12);
  assert.ok([...container.writeCount.values()].every((n) => n === 1));
  assert.ok(readMigration(mdir).chunks.every((c) => c.status === 'success'));
});

test('migrate: a failed listing lets the closed chunks be copied, ends failed, and continuing lists again', async () => {
  const { base, s3, container, migrationDir } = setup(many(6), { pageSize: 2 });
  let failing = true;
  s3.failPage = (n) => (failing && n === 2 ? Object.assign(new Error('Service Unavailable'), { name: 'ServiceUnavailable' }) : null);
  const out = sink();
  assert.equal(await migrateCommand({ ...base, chunkFiles: '2' }, out), 2);
  const mdir = migrationDir();
  let m = readMigration(mdir);
  assert.deepEqual([m.outcome, m.inventory.status, m.chunks.length], ['failed', 'failed', 2]);
  assert.match(m.inventory.error, /ServiceUnavailable/);
  assert.equal(container.blobs.size, 4, 'the closed chunks were copied');
  assert.match(out.text(), /Listing failed/);
  failing = false;
  assert.equal(await migrateCommand({ ...base, sourceBucket: undefined, migration: mdir }, sink()), 0);
  m = readMigration(mdir);
  assert.deepEqual([m.outcome, m.inventory.status, m.chunks.length], ['success', 'done', 3]);
  assert.equal(container.blobs.size, 6);
});

test('migrate: --stop-after inventory lists into chunks and copies nothing; continuing copies them', async () => {
  const { base, container, migrationDir } = setup(many(3));
  const out = sink();
  assert.equal(await migrateCommand({ ...base, stopAfter: 'inventory' }, out), 0);
  assert.equal(container.requests.length, 0);
  const mdir = migrationDir();
  assert.deepEqual([readMigration(mdir).outcome, readMigration(mdir).inventory.status], ['stopped', 'done']);
  assert.match(out.text(), /3 objects, 30 B/);
  await assert.rejects(migrateCommand({ ...base, stopAfter: 'chunk' }, sink()), /--stop-after/);
  assert.equal(await migrateCommand({ ...base, sourceBucket: undefined, migration: mdir }, sink()), 0);
  assert.equal(container.blobs.size, 3);
});

test('migrate by size class: every object copied, never more than the concurrency of its class at once', async () => {
  const objects = { ...many(20, { name: 's', size: 10 }), ...many(6, { name: 'z', size: 1000 }) };
  const { base, s3, container, migrationDir } = setup(objects, { pageSize: 5 });
  s3.delayMs = 2;
  container.delayMs = 5;
  const inFlight = { small: 0, big: 0 };
  const max = { small: 0, big: 0 };
  const getClient = container.getBlockBlobClient.bind(container);
  container.getBlockBlobClient = (name) => {
    const client = getClient(name);
    const cls = name.startsWith('data/s') ? 'small' : 'big';
    return {
      ...client,
      async syncUploadFromURL(...args) {
        max[cls] = Math.max(max[cls], ++inFlight[cls]);
        try {
          return await client.syncUploadFromURL(...args);
        } finally {
          inFlight[cls]--;
        }
      },
    };
  };
  const classes = [{ name: 'small', below: 100, chunkFiles: 5, concurrency: 4 }, { name: 'big', chunkFiles: 2, concurrency: 1 }];
  const out = sink();
  assert.equal(await migrateCommand({ ...base, sizeProfile: profileFile(classes), parallel: '1' }, out), 0, out.text());
  assert.equal(container.blobs.size, 26);
  assert.deepEqual([max.small, max.big], [4, 1]);
  const m = readMigration(migrationDir());
  assert.deepEqual(m.options.sizeClasses, classes);
  assert.equal(m.options.concurrency, undefined);
  assert.deepEqual(m.chunks.map((c) => [c.sizeClass, c.files]), [['small', 5], ['small', 5], ['small', 5], ['small', 5], ['big', 2], ['big', 2], ['big', 2]]);
  assert.deepEqual([m.inventory.files, m.inventory.closedThrough], [26, { small: 'data/z006.bin', big: 'data/z006.bin' }]);
  const text = out.text();
  assert.match(text, /chunk 00001 \(small\) listed: 5 objects, 50 B/);
  assert.match(text, /chunk 00005 \(big\) success/);
  assert.match(text, /1 chunk\(s\) at a time, the objects at once of its size class in each:\n {2}small +< 100 B +5 files per chunk, 4 at once\n {2}big +≥ 100 B +2 files per chunk, 1 at once/);
});

test('migrate by size class: Ctrl+C with open chunks of two classes after another closed; continuing loses and duplicates nothing', async () => {
  // In S3's order (UTF-8 bytes) ｚ (U+FF5A) comes before 😀; JavaScript's string order has them the other way round.
  const sizes = { a: 1, b: 500, '\uFF5A': 1, '\u{1F600}': 50, '\u{1F601}': 500, '\u{1F602}': 1, '\u{1F603}': 500, '\u{1F604}': 50 };
  const { base, s3, container, migrationDir, chunkPaths } = setup(Object.fromEntries(Object.entries(sizes).map(([k, size]) => [`data/${k}`, { size }])), { pageSize: 2 });
  const classes = [{ name: 'tiny', below: 10, chunkFiles: 5, concurrency: 2 }, { name: 'mid', below: 100, chunkFiles: 5, concurrency: 2 }, { name: 'big', chunkFiles: 2, concurrency: 2 }];
  const ctrlC = new AbortController();
  s3.beforePage = async (n) => {
    if (n === 3) ctrlC.abort(); // pages: [a b] [ｚ 😀] [😁 😂] | [😃 😄]
  };
  assert.equal(await migrateCommand({ ...base, sizeProfile: profileFile(classes), abortSignal: ctrlC.signal }, sink()), 130);
  const mdir = migrationDir();
  let m = readMigration(mdir);
  // b and 😁 closed the big chunk; the tiny chunk (a ｚ 😂) and the mid chunk (😀) were open
  assert.deepEqual(m.chunks.map((c) => [c.id, c.sizeClass, c.files]), [[2, 'big', 2]]);
  assert.deepEqual(m.inventory, { ...m.inventory, status: 'running', listedThrough: 'data/\u{1F601}', closedThrough: { tiny: null, mid: 'data/\uFF5A', big: 'data/\u{1F601}' }, resumeAfter: null, files: 2 });
  assert.ok(!fs.readdirSync(path.join(mdir, 'chunks')).some((f) => f.endsWith('.partial')));

  s3.pages.length = 0;
  s3.beforePage = null;
  const out = sink();
  assert.equal(await migrateCommand({ ...base, sourceBucket: undefined, migration: mdir }, out), 0, out.text());
  assert.equal(s3.pages[0].StartAfter, undefined);
  m = readMigration(mdir);
  const paths = chunkPaths(mdir);
  assert.deepEqual([...paths].sort(), Object.keys(sizes).sort(), 'every key in a chunk');
  assert.equal(new Set(paths).size, paths.length, 'no key twice');
  assert.equal(m.inventory.files, m.chunks.reduce((s, c) => s + c.files, 0));
  assert.equal(m.inventory.files, 8);
  for (const c of m.chunks) for (const r of readChunkRecords(path.join(mdir, c.list))) assert.equal(c.sizeClass, classOf(classes, r.size).name);
  assert.equal(container.blobs.size, 8);
  assert.ok([...container.writeCount.values()].every((n) => n === 1));
});

test('migrate: a migration.json from before size classes (resumeAfter only) is continued as before', async () => {
  const keys = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];
  const { base, s3, container, migrationDir, chunkPaths } = setup(Object.fromEntries(keys.map((k) => [`data/${k}`, { size: 1 }])), { pageSize: 2 });
  const ctrlC = new AbortController();
  s3.beforePage = async (n) => {
    if (n === 3) ctrlC.abort();
  };
  assert.equal(await migrateCommand({ ...base, chunkFiles: '2', abortSignal: ctrlC.signal }, sink()), 130);
  const mdir = migrationDir();
  const file = path.join(mdir, 'migration.json');
  const legacy = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(legacy.options.sizeClasses, undefined);
  delete legacy.inventory.listedThrough;
  fs.writeFileSync(file, JSON.stringify(legacy, null, 2));

  s3.pages.length = 0;
  s3.beforePage = null;
  assert.equal(await migrateCommand({ ...base, sourceBucket: undefined, migration: mdir, concurrency: '2' }, sink()), 0);
  assert.equal(s3.pages[0].StartAfter, legacy.inventory.resumeAfter);
  assert.deepEqual(chunkPaths(mdir), keys);
  const m = readMigration(mdir);
  assert.ok(m.chunks.every((c) => c.sizeClass === undefined));
  assert.deepEqual([m.options.concurrency, m.inventory.files], [2, 8]);
  assert.ok([...container.writeCount.values()].every((n) => n === 1));
});

test('migrate: the options of size classes, for a new migration and when continuing', async () => {
  const { base, container, migrationDir } = setup({ ...many(3, { size: 10 }), ...many(2, { name: 'z', size: 1000 }) });
  const classes = [{ name: 'small', below: 100, chunkFiles: 5, concurrency: 4 }, { name: 'big', chunkFiles: 2, concurrency: 1 }];
  const profile = profileFile(classes);
  await assert.rejects(migrateCommand({ ...base, sizeProfile: profile, chunkFiles: '10' }, sink()), /--chunk-files cannot be used with --size-profile/);
  await assert.rejects(migrateCommand({ ...base, sizeProfile: profile, concurrency: '10' }, sink()), /--concurrency cannot be used with --size-profile/);
  await assert.rejects(migrateCommand({ ...base, sizeProfile: path.join(tmp('profile'), 'none.json') }, sink()), /Cannot read the size profile/);

  assert.equal(await migrateCommand({ ...base, sizeProfile: profile, stopAfter: 'inventory' }, sink()), 0);
  const mdir = migrationDir();
  const continued = { ...base, sourceBucket: undefined, migration: mdir };
  await assert.rejects(migrateCommand({ ...continued, concurrency: '8' }, sink()), /--concurrency does not apply to a migration chunked by size class: give --size-profile/);

  // only the concurrency of each class (by name) changes; anything else is reported and left as it is
  const changed = profileFile([
    { name: 'small', below: '1MiB', chunkFiles: 5, concurrency: 16 },
    { name: 'big', below: '1GiB', chunkFiles: 9, concurrency: 3 },
    { name: 'extra', chunkFiles: 1, concurrency: 1 },
  ]);
  const out = sink();
  assert.equal(await migrateCommand({ ...continued, sizeProfile: changed, parallel: '3' }, out), 0, out.text());
  assert.equal(container.blobs.size, 5);
  const m = readMigration(mdir);
  assert.deepEqual(m.options.sizeClasses, [{ ...classes[0], concurrency: 16 }, { ...classes[1], concurrency: 3 }]);
  assert.equal(m.options.parallel, 3);
  const text = out.text();
  assert.match(text, /--size-profile changes below of class "small": ignored, since its chunks already exist/);
  assert.match(text, /--size-profile changes below, chunkFiles of class "big": ignored/);
  assert.match(text, /--size-profile class "extra" is not a class of this migration: ignored/);

  // a uniform migration has no size classes to change
  const uniform = setup(many(2));
  assert.equal(await migrateCommand({ ...uniform.base, chunkFiles: '1', stopAfter: 'inventory' }, sink()), 0);
  await assert.rejects(migrateCommand({ ...uniform.base, sourceBucket: undefined, migration: uniform.migrationDir(), sizeProfile: profile }, sink()), /--size-profile does not apply to this migration: it is chunked uniformly/);
});

test('migrate: --dry-run creates nothing and prints the phases, without secrets', async () => {
  const { dir, base, container } = setup(many(3));
  const out = sink();
  assert.equal(await migrateCommand({ ...base, dryRun: true }, out), 0);
  assert.deepEqual(fs.readdirSync(dir), []);
  assert.equal(container.requests.length, 0);
  const text = out.text();
  assert.match(text, /Dry run - would run a migration/);
  assert.match(text, /into chunks by size class/);
  assert.match(text, /very-small {2}< 1 MiB {12}100,000 files per chunk, 128 at once/);
  assert.match(text, /very-large {2}≥ 100 GiB {10}50 files per chunk, 2 at once/);
  assert.match(text, /4 chunk\(s\) at once, the objects at once of its size class \(very-small 128, small 64, medium 16, large 8, very-large 2\) in each/);
  assert.ok(!text.includes('SECRETSIG123') && !text.includes(AWS_SECRET));

  // uniform chunks: --chunk-files or --concurrency
  const uniform = sink();
  assert.equal(await migrateCommand({ ...base, dryRun: true, concurrency: '32' }, uniform), 0);
  assert.match(uniform.text(), /chunks of at most 100,000 objects/);
  assert.match(uniform.text(), /4 chunk\(s\) at once, 32 object\(s\) at once in each/);
  assert.ok(!uniform.text().includes('size class'));
});

test('migrate: no SAS, AWS secret, session token or presigned signature in the migration folder or the output', async () => {
  const { dir, base, container } = setup(many(4));
  process.env.AWS_SESSION_TOKEN = SESSION_TOKEN;
  // an error message that quotes secrets, as an SDK error can
  container.fail = (name) => (name === 'data/f001.bin' ? Object.assign(httpError(403, 'AuthorizationFailure'), { message: `denied ${SAS} ${AWS_SECRET} ${SESSION_TOKEN} X-Amz-Signature=${PRESIGN_SECRET}` }) : null);
  const out = sink();
  assert.equal(await migrateCommand({ ...base, maxAttempts: '1' }, out), 1);
  const texts = [out.text(), ...walk(dir).map((f) => fs.readFileSync(f, 'utf8'))];
  for (const secret of ['SECRETSIG123', AWS_SECRET, SESSION_TOKEN, PRESIGN_SECRET]) {
    assert.ok(!texts.some((t) => t.includes(secret)), `${secret} leaked`);
  }
  assert.ok(texts.some((t) => t.includes('AuthorizationFailure')), 'the error is still recorded');
  delete process.env.AWS_SESSION_TOKEN;
});

/** A migration folder as the azcopy version (format 1) left it: one exhausted chunk per kind, and state.json pointing at it. */
function formatOneMigration(dir) {
  const mdir = path.join(dir, '20260101T000000Z-migration');
  const run = path.join(mdir, 'chunks/00001/20260101T000500Z-chunk');
  fs.mkdirSync(run, { recursive: true });
  fs.writeFileSync(path.join(mdir, 'chunks/00001.txt'), 'f001.bin\nf002.bin\n');
  fs.writeFileSync(path.join(mdir, 'chunks/00002.txt'), 'f003.bin\nf004.bin\n');
  fs.writeFileSync(path.join(run, 'failed-20260101T000600Z.jsonl'), `${JSON.stringify({ relativePath: 'f002.bin', size: 10 })}\n`);
  const m = {
    kind: 'migration',
    startedAt: '2026-01-01T00:00:00.000Z',
    outcome: 'partial',
    bucket: 'bkt',
    prefix: 'data',
    region: 'ap-southeast-2',
    sourceBase: SOURCE_BASE,
    targetBase: 'https://acct.blob.core.windows.net/cont',
    destBase: DEST_BASE,
    inventory: { status: 'done' },
    chunking: { status: 'done' },
    chunks: [
      { id: 1, list: 'chunks/00001.txt', files: 2, bytes: 20, status: 'exhausted', lastOutcome: 'partial', runs: ['chunks/00001/20260101T000500Z-chunk'] },
      { id: 2, list: 'chunks/00002.txt', files: 2, bytes: 20, status: 'exhausted', lastOutcome: 'failed', runs: [] },
    ],
  };
  fs.writeFileSync(path.join(mdir, 'migration.json'), JSON.stringify(m));
  saveState(path.join(dir, 'state.json'), stateKey(SOURCE_BASE, DEST_BASE), { startedAt: m.startedAt, runDir: mdir });
  return mdir;
}

test('a format 1 migration (azcopy) is not continued, and works as the baseline of a delta with its carried files', async () => {
  const { dir, base, container, migrationDir } = setup(many(4));
  const old = formatOneMigration(dir);
  await assert.rejects(migrateCommand({ ...base, sourceBucket: undefined, migration: old }, sink()), /earlier version .* cannot be continued/);
  const carried = collectCarried(old);
  assert.deepEqual([...carried.paths.entries()], [['f002.bin', 10], ['f003.bin', 10], ['f004.bin', 10]]);
  assert.equal(listMigrations({ outputDir: dir })[0].format, 1);

  assert.equal(await migrateCommand({ ...base, lastCopyDate: 'auto' }, sink()), 0);
  const delta = readMigration(migrationDir());
  assert.deepEqual([delta.baseline.dir, delta.carried.files, delta.chunks[0].carried], [old, 3, true]);
  assert.deepEqual([...container.blobs.keys()].sort(), ['data/f002.bin', 'data/f003.bin', 'data/f004.bin']); // nothing modified since, only the carried files
});

test('migrate: without --source-bucket the latest migration is shown and needs confirmation; --yes skips it', async () => {
  const { base, migrationDir } = setup(many(2));
  await migrateCommand({ ...base, stopAfter: 'inventory' }, sink());
  const out = sink();
  const asked = [];
  await assert.rejects(migrateCommand({ ...base, sourceBucket: undefined, yes: false, confirm: async (q) => (asked.push(q), false) }, out), /Cancelled/);
  assert.equal(asked.length, 1);
  assert.match(out.text(), new RegExp(`Latest migration: ${migrationDir().replace(/\\/g, '\\\\')}`));
  assert.equal(await migrateCommand({ ...base, sourceBucket: undefined }, sink()), 0);
  assert.equal(readMigration(migrationDir()).outcome, 'success');
});

test('listMigrations: newest first, with phase and mode; folders without a migration.json are left out', async () => {
  const { dir, base } = setup(many(2));
  assert.deepEqual(listMigrations({ outputDir: path.join(dir, 'missing') }), []);
  await migrateCommand({ ...base, stopAfter: 'inventory' }, sink());
  await migrateCommand({ ...base, lastCopyDate: '2026-01-01' }, sink());
  fs.mkdirSync(path.join(dir, '20200101T000000Z-migration'));
  const list = listMigrations({ outputDir: dir });
  assert.deepEqual(list.map((l) => [l.mode, l.format, l.outcome, l.phase]), [['delta', 2, 'success', 'done'], ['full', 2, 'stopped', 'copying']]);
  assert.deepEqual([list[1].bucket, list[1].prefix, list[1].region, list[1].chunksTotal], ['bkt', 'data', 'ap-southeast-2', 1]);
});

test('--repeat: deltas follow until one finds at most --repeat-until objects; usage errors', async () => {
  const { base, migrationDirs } = setup(many(3));
  const out = sink();
  assert.equal(await migrateCommand({ ...base, repeat: true, repeatUntil: '0' }, out), 0);
  const dirs = migrationDirs();
  assert.equal(dirs.length, 2);
  assert.equal(readMigration(dirs[1]).baseline.dir, dirs[0]);
  assert.match(out.text(), /Caught up: the last delta found 0 objects/);
  await assert.rejects(migrateCommand({ ...base, repeatUntil: '5' }, sink()), /--repeat-until needs --repeat/);
  await assert.rejects(migrateCommand({ ...base, repeat: true, stopAfter: 'inventory' }, sink()), /--repeat cannot be used with --stop-after/);
  const dry = sink();
  assert.equal(await migrateCommand({ ...base, repeat: true, dryRun: true }, dry), 0);
  assert.match(dry.text(), /Then: {4}delta migrations one after another/);
});
