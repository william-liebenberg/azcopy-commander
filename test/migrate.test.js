import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseCount, parseSize, createChunks } from '../src/chunks.js';
import { analyseInventory, analysisLines, s3Provider, writeInventory, InventoryError } from '../src/inventory.js';
import { MigrationProgress, formatAggregate, PlainMigrationView } from '../src/migration-view.js';
import { listMigrations, migrateCommand, readMigration } from '../src/migration.js';
import { copyCommand, listRuns, listCommand } from '../src/commands.js';
import { readState } from '../src/state.js';

const SAS = 'https://acct.blob.core.windows.net/cont?sv=2022-11-02&sp=racwl&se=2099-01-01T00:00:00Z&sig=SECRETSIG123';
const AWS_SECRET = 'awssecretawssecretawssecret';
const FAKE_VARS = ['FAKE_DRYRUN_COUNT', 'FAKE_DRYRUN_COUNTS', 'FAKE_DELAY_MS', 'FAKE_FAIL_LIST', 'FAKE_NO_TRANSFERS', 'FAKE_CHATTER'];

const sink = () => {
  const chunks = [];
  return { isTTY: false, write: (c) => chunks.push(String(c)), text: () => chunks.join('') };
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** A fresh output directory and the options that point the commands at the fake azcopy. */
function setup(fake = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'azc-mig-'));
  const argsFile = path.join(dir, 'args.jsonl');
  const eventsFile = path.join(dir, 'events.txt');
  for (const k of FAKE_VARS) delete process.env[k];
  Object.assign(process.env, { AWS_ACCESS_KEY_ID: 'AKIATESTTESTTEST', AWS_SECRET_ACCESS_KEY: AWS_SECRET, FAKE_ARGS_FILE: argsFile, FAKE_EVENTS_FILE: eventsFile, ...fake });
  const base = {
    azcopyCommand: { bin: process.execPath, prefixArgs: [fileURLToPath(new URL('fixtures/fake-azcopy.js', import.meta.url))] },
    outputDir: dir,
    targetSasUrl: SAS,
    sourceBucket: 'bkt',
    sourcePrefix: 'data',
    sourceRegion: 'ap-southeast-2',
  };
  const calls = () => (fs.existsSync(argsFile) ? fs.readFileSync(argsFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : []);
  const events = () => (fs.existsSync(eventsFile) ? fs.readFileSync(eventsFile, 'utf8').trim().split('\n').filter(Boolean).map((l) => l.split(' ')) : []);
  const migrationDir = () => path.join(dir, fs.readdirSync(dir).find((f) => f.endsWith('-migration')));
  return { dir, base, calls, events, migrationDir };
}

const listCalls = (calls) => calls.filter((a) => a[0] === 'copy' && a.includes('--list-of-files'));
const dryRunCalls = (calls) => calls.filter((a) => a.includes('--dry-run'));
const readLines = (file) => fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
/** The migration folders of an output directory, oldest first (by their start, not their name). */
const migrationDirs = (dir) => fs.readdirSync(dir).filter((f) => /-migration$/.test(f)).map((f) => path.join(dir, f)).sort((a, b) => readMigration(a).startedAt.localeCompare(readMigration(b).startedAt));
const deltaDate = (m) => new Date(Date.parse(m.startedAt) - 10 * 60_000).toISOString().replace(/\.\d{3}Z$/, 'Z');

/** The most jobs that ran at once, from the start / end events of the fake. */
function maxConcurrent(events) {
  let now = 0;
  let max = 0;
  for (const [name] of events.map(([n, t]) => [n, Number(t)]).sort((a, b) => a[1] - b[1] || (a[0] === 'end' ? -1 : 1))) {
    now += name === 'start' ? 1 : -1;
    max = Math.max(max, now);
  }
  return max;
}

// ------------------------------------------------------------- sizes and chunking

test('parseSize and parseCount', () => {
  assert.equal(parseSize('2TiB'), 2 * 2 ** 40);
  assert.equal(parseSize('500GiB'), 500 * 2 ** 30);
  assert.equal(parseSize('1.5 gib'), 1.5 * 2 ** 30);
  assert.equal(parseSize('4096'), 4096);
  for (const bad of ['', 'GiB', '0', '5 parsecs', '-1MiB']) assert.throws(() => parseSize(bad, '--chunk-bytes'), /--chunk-bytes/);
  assert.equal(parseCount('10', '--parallel'), 10);
  assert.equal(parseCount(3, '--parallel'), 3);
  for (const bad of ['0', 'x', '1.5', -2]) assert.throws(() => parseCount(bad, '--parallel'), /--parallel/);
});

function writeRawInventory(dir, records) {
  const file = path.join(dir, 'inventory.jsonl');
  fs.writeFileSync(file, records.map((r) => `${JSON.stringify(r)}\n`).join(''));
  return file;
}

test('chunking: boundaries by files and by bytes, an oversized object alone, keys with a line break skipped', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'azc-chunks-'));
  const rec = (name, size) => ({ path: name, size });

  // by files
  let file = writeRawInventory(dir, ['a', 'b', 'c', 'd', 'e'].map((n) => rec(n, 1)));
  let { chunks, skipped } = await createChunks({ inventoryFile: file, chunksDir: path.join(dir, 'chunks'), maxFiles: 2, maxBytes: 1000 });
  assert.deepEqual(chunks.map((c) => [c.id, c.files, c.bytes, c.list]), [[1, 2, 2, 'chunks/00001.txt'], [2, 2, 2, 'chunks/00002.txt'], [3, 1, 1, 'chunks/00003.txt']]);
  assert.equal(skipped, 0);
  assert.deepEqual(readLines(path.join(dir, 'chunks/00001.txt')), ['a', 'b']);
  assert.ok(!fs.existsSync(path.join(dir, 'chunks/skipped.jsonl')));

  // by bytes: a chunk never goes past the limit; 40 + 30 does not fit in 60
  file = writeRawInventory(dir, [rec('a', 40), rec('b', 30), rec('c', 30), rec('d', 20)]);
  ({ chunks } = await createChunks({ inventoryFile: file, chunksDir: path.join(dir, 'chunks'), maxFiles: 100, maxBytes: 60 }));
  assert.deepEqual(chunks.map((c) => [c.files, c.bytes]), [[1, 40], [2, 60], [1, 20]]);
  assert.deepEqual(readLines(path.join(dir, 'chunks/00002.txt')), ['b', 'c']);

  // an object larger than the limit has a chunk of its own, wherever it is
  file = writeRawInventory(dir, [rec('a', 10), rec('huge', 500), rec('b', 10), rec('c', 10)]);
  ({ chunks } = await createChunks({ inventoryFile: file, chunksDir: path.join(dir, 'chunks'), maxFiles: 100, maxBytes: 100 }));
  assert.deepEqual(chunks.map((c) => [c.files, c.bytes]), [[1, 10], [1, 500], [2, 20]]);
  assert.deepEqual(readLines(path.join(dir, 'chunks/00002.txt')), ['huge']);

  // keys with a line break cannot be in a list of files
  file = writeRawInventory(dir, [rec('a', 1), rec('bad\nkey', 7), rec('bad\rkey', 8), rec('b', 1)]);
  ({ chunks, skipped } = await createChunks({ inventoryFile: file, chunksDir: path.join(dir, 'chunks'), maxFiles: 100, maxBytes: 100 }));
  assert.equal(skipped, 2);
  assert.deepEqual(readLines(path.join(dir, 'chunks/00001.txt')), ['a', 'b']);
  const skippedRecords = readLines(path.join(dir, 'chunks/skipped.jsonl')).map((l) => JSON.parse(l));
  assert.deepEqual(skippedRecords.map((r) => [r.path, r.size]), [['bad\nkey', 7], ['bad\rkey', 8]]);

  // an empty inventory has no chunks
  file = writeRawInventory(dir, []);
  ({ chunks } = await createChunks({ inventoryFile: file, chunksDir: path.join(dir, 'chunks'), maxFiles: 2, maxBytes: 100 }));
  assert.deepEqual(chunks, []);
});

// ------------------------------------------------------------- inventory

test('the inventory is written as JSON lines, through .partial; a failed listing leaves no file', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'azc-inv-'));
  const file = path.join(dir, 'inventory.jsonl');
  const progress = [];
  const records = [{ path: 'a\tb c.txt', size: 10 }, { path: 'big.bin', size: 5, storageClass: 'STANDARD' }];
  const result = await writeInventory({ file, provider: { list: async (on) => records.forEach(on) }, onProgress: (p) => progress.push(p) });
  assert.deepEqual(result, { files: 2, bytes: 15 });
  assert.deepEqual(progress.at(-1), { files: 2, bytes: 15 });
  assert.deepEqual(readLines(file).map((l) => JSON.parse(l)), records); // tabs in keys survive
  assert.ok(!fs.existsSync(`${file}.partial`));

  const other = path.join(dir, 'other.jsonl');
  await assert.rejects(writeInventory({ file: other, provider: { list: async (on) => { on(records[0]); throw new InventoryError('boom'); } } }), /boom/);
  assert.deepEqual(fs.readdirSync(dir).sort(), ['inventory.jsonl']);
});

test('writing many records under backpressure adds no listeners per record (no MaxListenersExceededWarning)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'azc-inv-'));
  const file = path.join(dir, 'inventory.jsonl');
  const warnings = [];
  const onWarning = (w) => warnings.push(w);
  process.on('warning', onWarning);
  try {
    // ~100 KiB per record against the stream's 16 KiB buffer: every write reports backpressure, and the
    // provider (like azcopy's) does not wait on the promise `onObject` returns.
    const records = Array.from({ length: 50 }, (_, i) => ({ path: `${i}/${'x'.repeat(100_000)}`, size: i }));
    const result = await writeInventory({ file, provider: { list: async (on) => records.forEach((r) => on(r)) } });
    await new Promise((resolve) => setImmediate(resolve)); // process warnings are emitted on a later tick
    assert.equal(result.files, 50);
    assert.equal(readLines(file).length, 50);
    assert.deepEqual(warnings.map((w) => w.name), []);
  } finally {
    process.off('warning', onWarning);
  }
});

test('analysis: counts, size histogram, largest objects, top-level prefixes, storage classes and a warning for archived ones', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'azc-ana-'));
  const GiB = 2 ** 30;
  const file = writeRawInventory(dir, [
    { path: 'data/a.txt', size: 10, storageClass: 'STANDARD' },
    { path: 'data/b.txt', size: 2 * 2 ** 20, storageClass: 'STANDARD' },
    { path: 'logs/c.log', size: 5 * GiB, storageClass: 'GLACIER' },
    { path: 'logs/d.log', size: 200 * GiB, storageClass: 'DEEP_ARCHIVE' },
    { path: 'root.txt', size: 1 },
  ]);
  const summary = await analyseInventory(file);
  assert.deepEqual([summary.files, summary.bytes], [5, 10 + 2 * 2 ** 20 + 205 * GiB + 1]);
  assert.deepEqual(summary.sizes.map((s) => s.files), [2, 1, 1, 1]); // < 1 MiB, 1 MiB-1 GiB, 1-100 GiB, > 100 GiB
  assert.deepEqual(summary.largest.map((l) => l.path), ['logs/d.log', 'logs/c.log', 'data/b.txt', 'data/a.txt', 'root.txt']);
  assert.deepEqual(summary.topLevel.map((p) => [p.prefix, p.files]), [['logs/', 2], ['data/', 2], ['(root)', 1]]);
  assert.deepEqual(summary.storageClasses.map((c) => [c.storageClass, c.files]).sort(), [['DEEP_ARCHIVE', 1], ['GLACIER', 1], ['STANDARD', 2]]);
  assert.equal(summary.archived.files, 2);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'inventory-summary.json'), 'utf8')).files, 5);

  const lines = analysisLines(summary, { shownPrefixes: 2 });
  assert.match(lines[0], /^5 objects, 205\.00 GiB/);
  assert.match(lines[1], /^sizes {6}< 1 MiB 2 · 1 MiB–1 GiB 1 · 1–100 GiB 1 · > 100 GiB 1/);
  assert.match(lines[2], /^top level {2}logs\/ 2 \(205\.00 GiB\) · data\/ 2 \(.*\) · 1 more/);
  assert.ok(lines.some((l) => /^WARNING: 2 archived object\(s\)/.test(l)));

  // without a storage class (azcopy provider) there is no such part
  const plainFile = writeRawInventory(dir, [{ path: 'x', size: 1 }]);
  const plain = await analyseInventory(plainFile, path.join(dir, 'plain-summary.json'));
  assert.equal(plain.storageClasses, undefined);
  assert.ok(!analysisLines(plain).some((l) => /storage|WARNING/.test(l)));
});

/** A ListObjectsV2 stand-in over `keys` ([key, size, modified, class]) with a small page size. */
function fakeS3(keys) {
  const requests = [];
  const listPage = async (params) => {
    requests.push(params);
    const rows = keys.filter(([key]) => !params.Prefix || key.startsWith(params.Prefix));
    const start = params.ContinuationToken ? Number(params.ContinuationToken) : 0;
    const page = rows.slice(start, start + 2);
    return {
      Contents: page.map(([Key, Size, LastModified, StorageClass]) => ({ Key, Size, LastModified: new Date(LastModified), StorageClass })),
      IsTruncated: start + 2 < rows.length,
      NextContinuationToken: String(start + 2),
    };
  };
  return { listPage, requests };
}

const S3_KEYS = [
  ['data/', 0, '2026-01-01T00:00:00Z'], // a folder marker
  ['data/a.txt', 10, '2026-01-01T00:00:00Z', 'STANDARD'],
  ['data/sub/b c.txt', 20, '2026-02-01T00:00:00Z', 'GLACIER'],
  ['data/sub/', 0, '2026-02-01T00:00:00Z'],
  ['data/new.txt', 30, '2026-03-01T00:00:00Z'],
  ['other/x.txt', 99, '2026-03-01T00:00:00Z'],
];

test('S3 provider: pages, prefix, folder markers, date filter, storage class', async () => {
  const collect = async (extra = {}) => {
    const fake = fakeS3(S3_KEYS);
    const seen = [];
    await s3Provider({ bucket: 'bkt', prefix: 'data', listPage: fake.listPage, ...extra }).list((o) => seen.push(o));
    return { seen, fake };
  };
  const { seen, fake } = await collect();
  assert.deepEqual(seen.map((o) => [o.path, o.size, o.storageClass]), [['a.txt', 10, 'STANDARD'], ['sub/b c.txt', 20, 'GLACIER'], ['new.txt', 30, 'STANDARD']]);
  assert.equal(seen[0].lastModified, '2026-01-01T00:00:00.000Z');
  assert.ok(fake.requests.length >= 3, 'several pages');
  assert.ok(fake.requests.every((r) => r.Bucket === 'bkt' && r.Prefix === 'data/' && r.MaxKeys === 1000));
  assert.equal(fake.requests[0].ContinuationToken, undefined);

  const delta = await collect({ includeAfter: '2026-02-01T00:00:00Z' });
  assert.deepEqual(delta.seen.map((o) => o.path), ['sub/b c.txt', 'new.txt'], 'on/after the date');

  const whole = await collect({ prefix: '' });
  assert.deepEqual(whole.seen.map((o) => o.path), ['data/a.txt', 'data/sub/b c.txt', 'data/new.txt', 'other/x.txt']);
  assert.equal(whole.fake.requests[0].Prefix, undefined);

  await assert.rejects(s3Provider({ bucket: 'bkt', listPage: async () => { throw new Error('AccessDenied'); } }).list(() => {}), /S3 listing failed: AccessDenied/);
});

// ------------------------------------------------------------- aggregate progress

test('MigrationProgress adds finished chunks and live jobs against the inventory total', () => {
  const chunks = [
    { id: 1, bytes: 1000, status: 'success', copied: 10, ignored: 1, failed: 0, bytesCopied: 900 },
    { id: 2, bytes: 1000, status: 'running', copied: 0, ignored: 0, failed: 0, bytesCopied: 0 },
    { id: 3, bytes: 1000, status: 'pending', copied: 0, ignored: 0, failed: 0, bytesCopied: 0 },
    { id: 4, bytes: 1000, status: 'exhausted', copied: 5, ignored: 0, failed: 2, bytesCopied: 400 },
  ];
  let now = 0;
  const progress = new MigrationProgress({ chunks, totalBytes: 4000, now: () => now });
  progress.update(2, { copied: 3, ignored: 0, failed: 1, bytesDone: 250, bytesTotal: 1000 });
  now = 1000;
  const s = progress.snapshot(now);
  assert.deepEqual([s.chunksTotal, s.chunksDone, s.chunksRunning, s.chunksPending, s.chunksExhausted], [4, 2, 1, 1, 1]);
  assert.deepEqual([s.copied, s.failed, s.ignored], [18, 3, 1]);
  assert.equal(s.bytesDone, 1000 + 250 + 400); // a finished chunk counts as a whole
  assert.equal(s.percent, (1650 / 4000) * 100);
  assert.deepEqual(s.running, [{ id: 2, percent: 25 }]);
  progress.update(2, { copied: 6, ignored: 0, failed: 1, bytesDone: 750, bytesTotal: 1000 });
  now = 2000;
  const later = progress.snapshot(now);
  assert.equal(later.throughput, 500); // 500 bytes in one second
  assert.equal(later.etaSeconds, (4000 - 2150) / 500);
  assert.match(formatAggregate(later), /^COPYING \| chunks 2\/4 done, 1 running \| copied 21 \| failed 3 \| 2\.10 KiB \/ 3\.91 KiB \(53\.8%\) \| 500 B\/s \| ETA 4s$/);
});

// ------------------------------------------------------------- migrate, end to end with the fake azcopy

test('migrate: inventory -> analysis -> chunks -> every chunk copied; state.json saved', async () => {
  const { dir, base, calls, migrationDir } = setup({ FAKE_DRYRUN_COUNT: '25' });
  const out = sink();
  const code = await migrateCommand({ ...base, chunkFiles: 10, parallel: 2 }, out);
  assert.equal(code, 0, out.text());

  const mdir = migrationDir();
  const m = readMigration(mdir);
  assert.equal(m.outcome, 'success');
  assert.deepEqual([m.inventory.status, m.inventory.files, m.inventory.bytes], ['done', 25, 10 * (25 * 26) / 2]);
  assert.deepEqual([m.chunking.status, m.chunking.chunks, m.chunking.skipped], ['done', 3, 0]);
  assert.deepEqual(m.chunks.map((c) => [c.id, c.files, c.status, c.attempts, c.runs.length]), [[1, 10, 'success', 1, 1], [2, 10, 'success', 1, 1], [3, 5, 'success', 1, 1]]);
  assert.equal(m.sourceBase, 'https://s3.ap-southeast-2.amazonaws.com/bkt/data');
  assert.equal(m.targetBase, 'https://acct.blob.core.windows.net/cont');
  assert.equal(m.chunks.reduce((s, c) => s + c.copied, 0), 25);

  // the folder: inventory, summary, chunk lists with paths relative to the source root, chunk runs
  const inventory = readLines(path.join(mdir, 'inventory.jsonl')).map((l) => JSON.parse(l));
  assert.deepEqual(inventory[0], { path: 'd1/obj-00001.bin', size: 10 });
  assert.equal(JSON.parse(fs.readFileSync(path.join(mdir, 'inventory-summary.json'), 'utf8')).files, 25);
  assert.deepEqual(readLines(path.join(mdir, 'chunks/00003.txt')), inventory.slice(20).map((r) => r.path));
  assert.ok(fs.readdirSync(mdir).some((f) => /^migration-\d{8}T\d{6}Z\.log$/.test(f)));
  const run = path.join(mdir, m.chunks[0].runs[0]);
  assert.ok(/chunks[\\/]00001[\\/]\d{8}T\d{6}Z-chunk$/.test(run));
  assert.deepEqual(fs.readdirSync(run).filter((f) => /^(run\.json|copy-.*\.log|azcopy-plans|azcopy-logs)$/.test(f)).length, 4);
  const runJson = JSON.parse(fs.readFileSync(path.join(run, 'run.json'), 'utf8'));
  assert.deepEqual([runJson.kind, runJson.chunk, runJson.outcome], ['chunk', 1, 'success']);

  // the azcopy commands: one dry run, then three list-of-files copies from the same source to the same target
  assert.equal(dryRunCalls(calls()).length, 1);
  const copies = listCalls(calls());
  assert.equal(copies.length, 3);
  for (const args of copies) {
    assert.equal(args[1], 'https://s3.ap-southeast-2.amazonaws.com/bkt/data');
    assert.ok(args[2].startsWith('https://acct.blob.core.windows.net/cont/data?') && args.includes('--overwrite=false') && !args.includes('--include-after'));
  }
  assert.deepEqual(copies.map((a) => path.basename(a[a.indexOf('--list-of-files') + 1])).sort(), ['00001.txt', '00002.txt', '00003.txt']);

  // the delta baseline is the start of the migration, so `--last-copy-date auto` works afterwards
  const state = readState(path.join(dir, 'state.json'));
  assert.deepEqual(Object.values(state).map((s) => [s.startedAt, s.runDir]), [[m.startedAt, mdir]]);
  await copyCommand({ ...base, lastCopyDate: 'auto' }, sink());
  assert.ok(calls().findLast((a) => a[0] === 'copy').includes('--include-after'));

  assert.match(out.text(), /Inventory \(azcopy dry-run\) of https:\/\/s3\.ap-southeast-2\.amazonaws\.com\/bkt\/data/);
  assert.match(out.text(), /25 objects, 3\.17 KiB/);
  assert.match(out.text(), /Chunks: 3 \(≤ 10 objects or ≤ 1\.00 TiB each\)/);
  assert.match(out.text(), /Copying 3 chunk\(s\), 2 at a time/);
  assert.match(out.text(), /chunk 00001 success {3}copied 10 {2}ignored 0 {2}failed 0/);
  assert.match(out.text(), /Status: +Migration completed\n.*Chunks: +3 copied/s);
});

test('migrate: never more than --parallel jobs at once, chunks started in order, a slot is refilled when a job ends', async () => {
  const { base, calls, events, migrationDir } = setup({ FAKE_DRYRUN_COUNT: '12', FAKE_DELAY_MS: '250' });
  const view = new PlainMigrationView(sink());
  const order = [];
  view.chunkStarted = (id) => order.push(id);
  const began = Date.now();
  assert.equal(await migrateCommand({ ...base, chunkFiles: 2, parallel: 3, view }, sink()), 0);
  assert.equal(listCalls(calls()).length, 6);
  assert.equal(maxConcurrent(events()), 3);
  assert.deepEqual(order, [1, 2, 3, 4, 5, 6]);
  assert.ok(Date.now() - began < 6 * 250 + 3000, 'not one after the other');
  // the first three jobs are chunks 1-3 (the fake azcopy processes race each other to write their line)
  assert.deepEqual(listCalls(calls()).slice(0, 3).map((a) => path.basename(a[a.indexOf('--list-of-files') + 1])).sort(), ['00001.txt', '00002.txt', '00003.txt']);

  // each job has its own plan and log folders
  const m = readMigration(migrationDir());
  const planDirs = new Set(m.chunks.map((c) => JSON.parse(fs.readFileSync(path.join(migrationDir(), c.runs[0], 'run.json'), 'utf8')).planDir));
  assert.equal(planDirs.size, 6);
});

test('migrate: --plan-dir is split per chunk so jobs that run at once do not share a plan folder', async () => {
  const { dir, base } = setup({ FAKE_DRYRUN_COUNT: '4' });
  const planDir = path.join(dir, 'plans');
  assert.equal(await migrateCommand({ ...base, chunkFiles: 2, planDir }, sink()), 0);
  const m = readMigration(path.join(dir, fs.readdirSync(dir).find((f) => f.endsWith('-migration'))));
  const dirs = m.chunks.map((c) => JSON.parse(fs.readFileSync(path.join(dir, fs.readdirSync(dir).find((f) => f.endsWith('-migration')), c.runs[0], 'run.json'), 'utf8')).planDir);
  assert.equal(new Set(dirs).size, 2);
  assert.ok(dirs.every((d) => d.startsWith(planDir)));
});

test('migrate: failed files are retried (from the failed list) up to --max-attempts', async () => {
  // d1/obj-00001.bin fails the first two times: partial, retry (partial), retry (success)
  const { base, calls, migrationDir } = setup({ FAKE_DRYRUN_COUNT: '4', FAKE_FAIL_LIST: 'd1/obj-00001.bin:2' });
  const out = sink();
  assert.equal(await migrateCommand({ ...base, chunkFiles: 2, parallel: 1 }, out), 0, out.text());
  const m = readMigration(migrationDir());
  assert.deepEqual(m.chunks.map((c) => [c.status, c.attempts, c.runs.length, c.failed]), [['success', 3, 3, 0], ['success', 1, 1, 0]]);
  const lists = listCalls(calls()).map((a) => path.basename(a[a.indexOf('--list-of-files') + 1]));
  assert.deepEqual(lists, ['00001.txt', 'retry-input.txt', 'retry-input.txt', '00002.txt']);
  const retryList = path.join(migrationDir(), m.chunks[0].runs[1], 'retry-input.txt');
  assert.deepEqual(readLines(retryList), ['d1/obj-00001.bin'], 'only the failed file');
  assert.equal(m.chunks[0].copied, 1 + 0 + 1, 'copied counts add up over the attempts: 1, then 0, then 1');
});

test('migrate: a chunk that keeps failing is exhausted; the outcome is partial; continuing tries it again', async () => {
  const { dir, base, calls, migrationDir } = setup({ FAKE_DRYRUN_COUNT: '4', FAKE_FAIL_LIST: 'd2/obj-00002.bin' });
  const out = sink();
  assert.equal(await migrateCommand({ ...base, chunkFiles: 2, maxAttempts: 2 }, out), 1);
  const mdir = migrationDir();
  let m = readMigration(mdir);
  assert.equal(m.outcome, 'partial');
  assert.deepEqual(m.chunks.map((c) => [c.status, c.attempts, c.lastOutcome]), [['exhausted', 2, 'partial'], ['success', 1, undefined]]);
  assert.equal(listCalls(calls()).length, 3);
  assert.match(out.text(), /Migration completed with failed files/);
  assert.ok(readState(path.join(dir, 'state.json')), 'a partial migration still moves the delta date');
  assert.ok(listMigrations({ outputDir: dir })[0].chunksDone === 2);

  // The files work now: continuing gives the exhausted chunk new attempts, and nothing else is copied again.
  delete process.env.FAKE_FAIL_LIST;
  const before = calls().length;
  assert.equal(await migrateCommand({ ...base, migration: mdir }, sink()), 0);
  m = readMigration(mdir);
  assert.deepEqual(m.chunks.map((c) => [c.status, c.attempts]), [['success', 1], ['success', 1]]);
  assert.equal(calls().length - before, 1, 'one retry job, no inventory');
  assert.equal(m.outcome, 'success');
});

test('migrate: an interrupted migration continues without listing or chunking again; the running job is resumed', async () => {
  const { base, calls, events, migrationDir } = setup({ FAKE_DRYRUN_COUNT: '6', FAKE_DELAY_MS: '2000' });
  const abort = new AbortController();
  const out = sink();
  const running = migrateCommand({ ...base, chunkFiles: 2, parallel: 1, abortSignal: abort.signal }, out);
  while (events().length === 0) await sleep(20); // the first job has started
  abort.abort();
  assert.equal(await running, 130, out.text());

  const mdir = migrationDir();
  let m = readMigration(mdir);
  assert.equal(m.outcome, 'interrupted');
  assert.deepEqual([m.inventory.status, m.chunking.status], ['done', 'done']);
  assert.deepEqual(m.chunks.map((c) => c.status), ['interrupted', 'pending', 'pending']);
  assert.equal(listCalls(calls()).length, 1, 'no new job started after the interrupt');
  assert.match(out.text(), /Status: +Migration interrupted/);
  assert.match(out.text(), /Continue: +azcopy-commander migrate --migration/);
  const inventoryStat = fs.statSync(path.join(mdir, 'inventory.jsonl')).mtimeMs;
  const chunkStat = fs.statSync(path.join(mdir, 'chunks/00001.txt')).mtimeMs;

  delete process.env.FAKE_DELAY_MS;
  const before = calls().length;
  const out2 = sink();
  assert.equal(await migrateCommand({ ...base, migration: mdir, parallel: 2 }, out2), 0, out2.text());
  m = readMigration(mdir);
  assert.equal(m.outcome, 'success');
  assert.deepEqual(m.chunks.map((c) => c.status), ['success', 'success', 'success']);
  const after = calls().slice(before);
  assert.equal(dryRunCalls(after).length, 0, 'the inventory is not listed again');
  assert.equal(fs.statSync(path.join(mdir, 'inventory.jsonl')).mtimeMs, inventoryStat);
  assert.equal(fs.statSync(path.join(mdir, 'chunks/00001.txt')).mtimeMs, chunkStat, 'the chunks are not cut again');
  assert.deepEqual(after.filter((a) => a[0] === 'jobs').map((a) => a.slice(0, 3)), [['jobs', 'resume', 'job-2']], 'the interrupted job is resumed');
  assert.ok(after.find((a) => a[0] === 'jobs')[3] === '--destination-sas');
  assert.equal(listCalls(after).length, 2, 'the two pending chunks are new copies');
  assert.equal(m.chunks[0].runs.length, 1, 'a resumed job stays in its run folder');
  assert.match(out2.text(), /Copying 3 chunk\(s\), 2 at a time/);
});

test('migrate: --stop-after inventory and --stop-after chunk, then continue', async () => {
  const { base, calls, migrationDir } = setup({ FAKE_DRYRUN_COUNT: '6' });
  const out = sink();
  assert.equal(await migrateCommand({ ...base, chunkFiles: 2, stopAfter: 'inventory' }, out), 0);
  const mdir = migrationDir();
  assert.ok(fs.existsSync(path.join(mdir, 'inventory.jsonl')) && fs.existsSync(path.join(mdir, 'inventory-summary.json')));
  assert.ok(!fs.existsSync(path.join(mdir, 'chunks')), 'nothing is chunked yet');
  assert.equal(readMigration(mdir).outcome, 'stopped');
  assert.match(out.text(), /6 objects/);
  assert.match(out.text(), /Status: +Migration stopped/);
  assert.equal(listCalls(calls()).length, 0);

  // a continued migration keeps the chunking options it started with
  assert.equal(await migrateCommand({ ...base, migration: mdir, chunkFiles: 3, stopAfter: 'chunk' }, sink()), 0);
  let m = readMigration(mdir);
  assert.equal(m.outcome, 'stopped');
  assert.equal(m.chunking.status, 'done');
  assert.equal(m.chunks.length, 3, 'chunk size 2 from the start of the migration');
  assert.equal(listCalls(calls()).length, 0);
  assert.equal(dryRunCalls(calls()).length, 1);

  assert.equal(await migrateCommand({ ...base, migration: mdir }, sink()), 0);
  m = readMigration(mdir);
  assert.equal(m.outcome, 'success');
  assert.equal(listCalls(calls()).length, 3);
  assert.equal(dryRunCalls(calls()).length, 1, 'the inventory was listed once');

  await assert.rejects(migrateCommand({ ...base, stopAfter: 'copy' }, sink()), /--stop-after/);
});

test('migrate: --dry-run creates nothing and prints the phases and commands, without secrets', async () => {
  const { dir, base } = setup();
  const out = sink();
  assert.equal(await migrateCommand({ ...base, dryRun: true, chunkFiles: 5, parallel: 4, chunkBytes: '500GiB' }, out), 0);
  assert.deepEqual(fs.readdirSync(dir), []);
  const text = out.text();
  assert.match(text, /Dry run - would run a migration \(nothing is created\)/);
  assert.match(text, /1\. Inventory \(azcopy dry-run\).*\n.*--dry-run/);
  assert.match(text, /Chunks of at most 5 objects or 500\.00 GiB/);
  assert.match(text, /4 azcopy jobs at once.*\n.*--list-of-files .*00001\.txt/);
  assert.ok(!text.includes('SECRETSIG123') && !text.includes(AWS_SECRET));
  assert.match(text, /cont\/data\?\*\*\*/);
});

test('migrate: no SAS or AWS secret in migration.json, the logs, the chunk lists or the chunk runs', async () => {
  const { dir, base } = setup({ FAKE_DRYRUN_COUNT: '6', FAKE_FAIL_LIST: 'd1/obj-00001.bin' });
  const out = sink();
  await migrateCommand({ ...base, chunkFiles: 3, maxAttempts: 2 }, out);
  const files = fs.readdirSync(dir, { recursive: true, withFileTypes: true }).filter((e) => e.isFile() && !/^args\.jsonl/.test(e.name));
  assert.ok(files.length > 10);
  for (const f of files) {
    const text = fs.readFileSync(path.join(f.parentPath, f.name), 'utf8');
    for (const secret of ['SECRETSIG123', AWS_SECRET, 'sv=2022-11-02']) assert.ok(!text.includes(secret), `${secret} in ${f.name}`);
  }
  assert.ok(!out.text().includes('SECRETSIG123'));
  assert.ok(files.some((f) => f.name === 'migration.json') && files.some((f) => /^failed-.*\.jsonl$/.test(f.name)));
});

test('migrate with --inventory-source s3: the SDK listing feeds the same chunks; keys with a line break are skipped', async () => {
  const keys = [
    ['data/a.txt', 10, '2026-01-01T00:00:00Z', 'STANDARD'],
    ['data/bad\nkey.txt', 20, '2026-01-01T00:00:00Z', 'STANDARD'],
    ['data/x y.txt', 30, '2026-01-01T00:00:00Z', 'GLACIER'],
  ];
  const { base, calls, migrationDir } = setup();
  const fake = fakeS3(keys);
  const out = sink();
  assert.equal(await migrateCommand({ ...base, inventorySource: 's3', s3ListPage: fake.listPage, chunkFiles: 10 }, out), 0, out.text());
  const mdir = migrationDir();
  const m = readMigration(mdir);
  assert.equal(m.options.inventorySource, 's3');
  assert.deepEqual([m.inventory.files, m.chunking.skipped, m.chunks.length], [3, 1, 1]);
  assert.deepEqual(readLines(path.join(mdir, 'chunks/00001.txt')), ['a.txt', 'x y.txt']);
  assert.equal(JSON.parse(readLines(path.join(mdir, 'chunks/skipped.jsonl'))[0]).path, 'bad\nkey.txt');
  assert.equal(dryRunCalls(calls()).length, 0, 'azcopy did not list');
  assert.match(out.text(), /Inventory \(S3 ListObjectsV2\)/);
  assert.match(out.text(), /WARNING: 1 archived object\(s\)/);
  assert.match(out.text(), /1 key\(s\) with a line break cannot be copied/);
  assert.match(out.text(), /Not copied: +1 key\(s\) with a line break/);
  assert.ok(JSON.parse(readLines(path.join(mdir, 'inventory.jsonl'))[0]).lastModified);

  await assert.rejects(migrateCommand({ ...base, inventorySource: 'ftp' }, sink()), /--inventory-source/);
});

test('migrate: a failed inventory ends the migration as failed, and continuing lists again', async () => {
  const { base, migrationDir } = setup();
  const failing = fakeS3([]);
  failing.listPage = async () => { throw new Error('AccessDenied'); };
  const out = sink();
  assert.equal(await migrateCommand({ ...base, inventorySource: 's3', s3ListPage: failing.listPage }, out), 2);
  const mdir = migrationDir();
  assert.equal(readMigration(mdir).outcome, 'failed');
  assert.equal(readMigration(mdir).inventory.status, 'pending');
  assert.match(out.text(), /Inventory failed: S3 listing failed: AccessDenied/);
  assert.ok(!fs.existsSync(path.join(mdir, 'inventory.jsonl')));
  assert.equal(await migrateCommand({ ...base, migration: mdir, s3ListPage: fakeS3([['data/a', 1, '2026-01-01T00:00:00Z']]).listPage }, sink()), 0);
  assert.equal(readMigration(mdir).outcome, 'success');
});

test('migrate: without --source-bucket the latest migration is shown and needs confirmation; --yes skips it', async () => {
  const { dir, base } = setup({ FAKE_DRYRUN_COUNT: '2' });
  const { sourceBucket, sourcePrefix, sourceRegion, ...target } = base;
  await assert.rejects(migrateCommand(target, sink()), /No earlier migration/);
  await migrateCommand({ ...base, stopAfter: 'inventory' }, sink());

  const asked = [];
  const out = sink();
  await assert.rejects(migrateCommand({ ...target, confirm: async (q) => (asked.push(q), false) }, out), /Cancelled/);
  assert.match(out.text(), /Latest migration: .*-migration\n {2}started .*, outcome stopped, 0\/0 chunk\(s\) done/);
  assert.deepEqual(asked, ['Continue this migration? [y/N] ']);
  assert.equal(readMigration(path.join(dir, fs.readdirSync(dir).find((f) => f.endsWith('-migration')))).outcome, 'stopped');

  assert.equal(await migrateCommand({ ...target, yes: true, confirm: async () => assert.fail('asked') }, sink()), 0);
  // a SAS for another target is refused
  await assert.rejects(migrateCommand({ ...target, yes: true, targetSasUrl: SAS.replace('/cont?', '/elsewhere?') }, sink()), /does not match/);
});

test('listMigrations returns migrations newest first; run lists and `list` ignore them', async () => {
  const { dir, base } = setup({ FAKE_DRYRUN_COUNT: '4' });
  assert.deepEqual(listMigrations({ outputDir: path.join(dir, 'missing') }), []);
  await migrateCommand({ ...base, chunkFiles: 2 }, sink());
  await sleep(1100); // folder names have a one second resolution
  await migrateCommand({ ...base, chunkFiles: 2, sourceRegion: undefined, stopAfter: 'chunk' }, sink());
  fs.mkdirSync(path.join(dir, '20200101T000000Z-migration')); // no migration.json: ignored
  const migrations = listMigrations({ outputDir: dir });
  assert.equal(migrations.length, 2);
  const [stopped, done] = migrations;
  assert.deepEqual([done.outcome, done.phase, done.chunksDone, done.chunksTotal, done.region, done.bucket, done.prefix], ['success', 'done', 2, 2, 'ap-southeast-2', 'bkt', 'data']);
  assert.deepEqual([stopped.outcome, stopped.phase, stopped.chunksDone, stopped.region], ['stopped', 'copying', 0, '']);
  assert.equal(done.targetBase, 'https://acct.blob.core.windows.net/cont');
  assert.deepEqual(listRuns({ outputDir: dir }), []);

  const out = sink();
  assert.equal(await listCommand({ ...base, lastCopyDate: '2026-01-01' }, out, sink()), 0);
  assert.match(out.text(), /^s3:\/\/bkt\/data\/d1\/obj-00001\.bin\t10\n/);
});

test('a chunk run is an ordinary run: retry --run and resume --run work on it', async () => {
  const { base, migrationDir } = setup({ FAKE_DRYRUN_COUNT: '2', FAKE_FAIL_LIST: 'd1/obj-00001.bin' });
  const { retryCommand } = await import('../src/commands.js');
  assert.equal(await migrateCommand({ ...base, chunkFiles: 5, maxAttempts: 1 }, sink()), 1);
  const m = readMigration(migrationDir());
  const run = path.join(migrationDir(), m.chunks[0].runs[0]);
  delete process.env.FAKE_FAIL_LIST;
  const out = sink();
  assert.equal(await retryCommand({ ...base, run }, out), 0, out.text());
  assert.match(out.text(), /Retrying 1 failed file\(s\)/);
});


// ------------------------------------------------------------- delta migrations

test('chunking with carried paths: they come first, split by --chunk-files; one also in the inventory stays there', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'azc-carried-'));
  const file = writeRawInventory(dir, [{ path: 'a', size: 1 }, { path: 'c2', size: 5 }, { path: 'b', size: 1 }]);
  const carried = new Map([['c1', 10], ['c2', 20], ['c3', 30], ['c4', 40]]);
  const { chunks, carriedInInventory } = await createChunks({ inventoryFile: file, chunksDir: path.join(dir, 'chunks'), maxFiles: 2, maxBytes: 1000, carried });
  assert.equal(carriedInInventory, 1);
  assert.deepEqual(chunks.map((c) => [c.id, c.list, c.files, c.bytes, Boolean(c.carried)]), [
    [1, 'chunks/00001.txt', 2, 40, true], [2, 'chunks/00002.txt', 1, 40, true], [3, 'chunks/00003.txt', 2, 6, false], [4, 'chunks/00004.txt', 1, 1, false],
  ]);
  assert.deepEqual(readLines(path.join(dir, 'chunks/00001.txt')), ['c1', 'c3']);
  assert.deepEqual(readLines(path.join(dir, 'chunks/00003.txt')), ['a', 'c2']);
  assert.deepEqual(fs.readdirSync(path.join(dir, 'chunks')).sort(), ['00001.txt', '00002.txt', '00003.txt', '00004.txt'], 'no temporary file left');
});

test('delta migration: --last-copy-date auto after a full migration; date, folder, baseline, lists and state.json', async () => {
  const { dir, base, calls } = setup({ FAKE_DRYRUN_COUNT: '4' });
  assert.equal(await migrateCommand({ ...base, chunkFiles: 2 }, sink()), 0);
  const [full] = migrationDirs(dir);
  const fullM = readMigration(full);

  // the dry run shows the date and the baseline and creates nothing
  const names = fs.readdirSync(dir);
  const dry = sink();
  assert.equal(await migrateCommand({ ...base, lastCopyDate: 'auto', dryRun: true }, dry), 0);
  assert.deepEqual(fs.readdirSync(dir), names);
  assert.match(dry.text(), new RegExp(`Mode: +delta \\(objects modified on/after ${deltaDate(fullM)}\\)`));
  assert.match(dry.text(), /Delta: +objects modified on\/after .* \(start of .*-migration, minus 10 min\)/);
  assert.match(dry.text(), /Folder: +.*-delta-migration/);

  const before = calls().length;
  const out = sink();
  assert.equal(await migrateCommand({ ...base, chunkFiles: 2, lastCopyDate: 'auto' }, out), 0, out.text());
  const delta = migrationDirs(dir)[1];
  assert.match(path.basename(delta), /^\d{8}T\d{6}Z-delta-migration$/);
  const m = readMigration(delta);
  assert.equal(m.includeAfter, deltaDate(fullM));
  assert.deepEqual(m.baseline, { startedAt: fullM.startedAt, dir: full });
  assert.equal(m.carried, null, 'the full migration copied everything');
  const after = calls().slice(before);
  const inventory = dryRunCalls(after);
  assert.equal(inventory.length, 1);
  assert.equal(inventory[0][inventory[0].indexOf('--include-after') + 1], m.includeAfter);
  assert.ok(listCalls(after).length === 2 && listCalls(after).every((a) => !a.includes('--include-after')), 'the chunk lists name the files');
  assert.deepEqual(Object.values(readState(path.join(dir, 'state.json'))).map((s) => [s.startedAt, s.runDir]), [[m.startedAt, delta]]);
  assert.match(out.text(), /Delta: +objects modified on\/after .* \(start of .*-migration, minus 10 min\)/);
  assert.match(out.text(), /Inventory \(azcopy dry-run\) of .*, modified on\/after /);
  assert.match(out.text(), /Status: +Migration completed\nDelta: +objects modified/);

  const listed = listMigrations({ outputDir: dir });
  assert.deepEqual(listed.map((x) => [x.mode, x.includeAfter]), [['delta', m.includeAfter], ['full', null]]);
});

test('delta migration: the failed files of a partial baseline are carried into the first chunk; a typed date carries nothing', async () => {
  // The full migration: chunks [obj-00001, obj-00002] and [obj-00003, obj-00004]; obj-00002 and obj-00004 fail.
  const { dir, base } = setup({ FAKE_DRYRUN_COUNTS: '4,2', FAKE_FAIL_LIST: 'd1/obj-00004.bin,d2/obj-00002.bin' });
  assert.equal(await migrateCommand({ ...base, chunkFiles: 2, maxAttempts: 1 }, sink()), 1);
  const [full] = migrationDirs(dir);
  delete process.env.FAKE_FAIL_LIST;

  // The delta lists obj-00001 and obj-00002 (modified since): obj-00002 is copied with the inventory, obj-00004 is carried.
  const out = sink();
  assert.equal(await migrateCommand({ ...base, chunkFiles: 2, lastCopyDate: 'auto' }, out), 0, out.text());
  const delta = migrationDirs(dir)[1];
  const m = readMigration(delta);
  assert.deepEqual(m.carried, { files: 2, bytes: 20, fromChunks: [1, 2], chunks: 1, inInventory: 1 });
  assert.deepEqual(m.chunks.map((c) => [c.id, c.files, Boolean(c.carried), c.status]), [[1, 1, true, 'success'], [2, 2, false, 'success']]);
  assert.deepEqual(readLines(path.join(delta, 'chunks/00001.txt')), ['d1/obj-00004.bin']);
  assert.deepEqual(readLines(path.join(delta, 'chunks/00002.txt')), ['d1/obj-00001.bin', 'd2/obj-00002.bin']);
  assert.match(out.text(), /Carried: +2 file\(s\) that .*-migration did not copy \(2 chunk\(s\)\), 20 B, in the first chunk\(s\)/);
  assert.match(out.text(), /Chunks: 2 \(1 carried over \+ 1 from the inventory\)/);
  assert.match(out.text(), /Carried: +2 file\(s\) .* in 1 chunk\(s\), 1 of them modified since/);
  const baseline = readMigration(full);
  assert.deepEqual([baseline.outcome, ...baseline.chunks.map((c) => c.status)], ['partial', 'exhausted', 'exhausted'], 'the baseline is left as it was');

  // a typed date has no baseline
  process.env.FAKE_DRYRUN_COUNTS = '2';
  assert.equal(await migrateCommand({ ...base, chunkFiles: 2, lastCopyDate: '2026-01-01' }, sink()), 0);
  const typed = readMigration(migrationDirs(dir)[2]);
  assert.deepEqual([typed.includeAfter, typed.baseline, typed.carried, typed.chunks.length], ['2026-01-01T00:00:00Z', null, null, 1]);
});

test('delta migration: a baseline chunk whose job failed is carried as its whole list; an inventory with nothing modified is fine', async () => {
  const { dir, base } = setup({ FAKE_DRYRUN_COUNTS: '4,0' });
  assert.equal(await migrateCommand({ ...base, chunkFiles: 2, stopAfter: 'chunk' }, sink()), 0);
  const [full] = migrationDirs(dir);
  // as if the job of chunk 1 failed on every attempt
  const fullM = readMigration(full);
  Object.assign(fullM.chunks[0], { status: 'exhausted', lastOutcome: 'failed', attempts: 5 });
  Object.assign(fullM.chunks[1], { status: 'success' });
  fullM.outcome = 'partial';
  fs.writeFileSync(path.join(full, 'migration.json'), JSON.stringify(fullM));

  const out = sink();
  assert.equal(await migrateCommand({ ...base, chunkFiles: 5, baselineDir: full }, out), 0, out.text());
  const m = readMigration(migrationDirs(dir)[1]);
  assert.equal(m.includeAfter, deltaDate(fullM));
  assert.deepEqual(m.carried, { files: 2, bytes: 30, fromChunks: [1], chunks: 1, inInventory: 0 });
  assert.equal(m.inventory.files, 0);
  assert.deepEqual(m.chunks.map((c) => [c.files, c.bytes, c.carried, c.status]), [[2, 30, true, 'success']]);
  assert.deepEqual(readLines(path.join(migrationDirs(dir)[1], 'chunks/00001.txt')), ['d1/obj-00001.bin', 'd2/obj-00002.bin']);
});

test('delta migration: nothing modified and nothing carried ends at once as success, and the baseline moves forward', async () => {
  const { dir, base, calls } = setup({ FAKE_DRYRUN_COUNTS: '4,0' });
  assert.equal(await migrateCommand({ ...base, chunkFiles: 2 }, sink()), 0);
  const copies = listCalls(calls()).length;
  const out = sink();
  assert.equal(await migrateCommand({ ...base, lastCopyDate: 'auto' }, out), 0, out.text());
  const delta = migrationDirs(dir)[1];
  const m = readMigration(delta);
  assert.deepEqual([m.outcome, m.chunking.status, m.chunks.length], ['success', 'done', 0]);
  assert.equal(listCalls(calls()).length, copies, 'no copy job');
  assert.match(out.text(), /Nothing was modified on\/after .* and nothing is carried over: no chunk to copy\./);
  assert.match(out.text(), /Status: +Migration completed\n[^]*Chunks: +0 copied/);
  assert.ok(!out.text().includes('Copying'));
  assert.equal(Object.values(readState(path.join(dir, 'state.json')))[0].runDir, delta);
});

test('state.json only moves forward: an older migration continued after a newer delta keeps the delta as the baseline', async () => {
  const { dir, base } = setup({ FAKE_DRYRUN_COUNTS: '4,1', FAKE_FAIL_LIST: 'd1/obj-00004.bin' });
  assert.equal(await migrateCommand({ ...base, chunkFiles: 2, maxAttempts: 1 }, sink()), 1);
  const [full] = migrationDirs(dir);
  process.env.FAKE_FAIL_LIST = 'd1/obj-00004.bin'; // the carried file still fails in the delta
  assert.equal(await migrateCommand({ ...base, lastCopyDate: 'auto', maxAttempts: 1 }, sink()), 1);
  const delta = migrationDirs(dir)[1];
  delete process.env.FAKE_FAIL_LIST;
  assert.equal(await migrateCommand({ ...base, migration: full }, sink()), 0);
  assert.equal(readMigration(full).outcome, 'success');
  assert.equal(Object.values(readState(path.join(dir, 'state.json')))[0].runDir, delta);
  const log = fs.readdirSync(full).filter((f) => f.endsWith('.log')).map((f) => fs.readFileSync(path.join(full, f), 'utf8')).join('');
  assert.match(log, /state\.json kept: a later run is recorded/);
});

test('delta migration with --inventory-source s3 and auto: the listing keeps the keys modified since the baseline', async () => {
  const { dir, base } = setup();
  const s3 = (extra = {}) => migrateCommand({ ...base, inventorySource: 's3', s3ListPage: fakeS3(S3_KEYS).listPage, chunkFiles: 10, ...extra }, sink());
  assert.equal(await s3(), 0);
  const file = path.join(dir, 'state.json');
  const [[key, entry]] = Object.entries(readState(file));
  fs.writeFileSync(file, JSON.stringify({ [key]: { ...entry, startedAt: '2026-02-01T00:10:00.000Z' } }));
  assert.equal(await s3({ lastCopyDate: 'auto' }), 0);
  const delta = migrationDirs(dir).find((d) => d.endsWith('-delta-migration'));
  assert.equal(readMigration(delta).includeAfter, '2026-02-01T00:00:00Z');
  assert.deepEqual(readLines(path.join(delta, 'inventory.jsonl')).map((l) => JSON.parse(l).path), ['sub/b c.txt', 'new.txt']);
});

// ------------------------------------------------------------- --repeat

test('--repeat: deltas follow until one finds at most --repeat-until objects; each is based on the one before', async () => {
  const { dir, base, calls } = setup({ FAKE_DRYRUN_COUNTS: '25,12,5' });
  const out = sink();
  assert.equal(await migrateCommand({ ...base, chunkFiles: 10, repeat: true, repeatUntil: '5' }, out), 0, out.text());
  const dirs = migrationDirs(dir);
  assert.equal(dirs.length, 3);
  const [full, d1, d2] = dirs.map(readMigration);
  assert.equal(full.includeAfter, null);
  assert.deepEqual([d1.baseline.dir, d1.includeAfter, d1.inventory.files], [dirs[0], deltaDate(full), 12]);
  assert.deepEqual([d2.baseline.dir, d2.includeAfter, d2.inventory.files], [dirs[1], deltaDate(d1), 5]);
  assert.deepEqual([d1.options.chunkFiles, d2.prefix, d2.region], [10, 'data', 'ap-southeast-2'], 'the settings of the round before');
  assert.deepEqual(dryRunCalls(calls()).map((a) => a.includes('--include-after')), [false, true, true]);
  const text = out.text();
  assert.match(text, /Round 0: the migration, then deltas until one finds ≤ 5 objects/);
  assert.match(text, /Round 2: delta 2 of at most 10/);
  assert.match(text, /Repeat summary[^]*\nfull +\S+-migration +25 +25 +success\n1 +\S+-delta-migration +12 +12 +success\n2 +\S+-delta-migration +5 +5 +success\n/);
  assert.match(text, /Caught up: the last delta found 5 objects \(≤ 5\)\. Stop the writers and run one more delta for cutover:\n {2}azcopy-commander migrate --source-bucket bkt --source-prefix data --source-region ap-southeast-2 --last-copy-date auto/);
});

test('--repeat: stops at --repeat-max; the failed files of a partial round are carried into the next one', async () => {
  // obj-00004 fails once (the full migration ends partial); every delta lists obj-00001 and obj-00002
  const { dir, base } = setup({ FAKE_DRYRUN_COUNTS: '4,2', FAKE_FAIL_LIST: 'd1/obj-00004.bin:1' });
  const out = sink();
  assert.equal(await migrateCommand({ ...base, chunkFiles: 2, maxAttempts: 1, repeat: true, repeatUntil: 1, repeatMax: '2' }, out), 0, out.text());
  const dirs = migrationDirs(dir);
  assert.equal(dirs.length, 3, 'the migration and two deltas');
  const d1 = readMigration(dirs[1]);
  assert.deepEqual(d1.chunks.map((c) => [Boolean(c.carried), c.status]), [[true, 'success'], [false, 'success']]);
  assert.deepEqual(readLines(path.join(dirs[1], 'chunks/00001.txt')), ['d1/obj-00004.bin']);
  assert.equal(readMigration(dirs[2]).carried, null);
  assert.match(out.text(), /full +\S+ +4 +3 +partial\n1 +\S+ +2 +3 +success\n2 +\S+ +2 +2 +success/);
  assert.match(out.text(), /Not caught up after 2 delta\(s\): the last one found 2 objects \(more than 1\)\.\nThe source is still changing faster/);
});

test('--repeat: an interrupted round stops the loop with 130 and says how to continue', async () => {
  const { dir, base, events } = setup({ FAKE_DRYRUN_COUNTS: '2', FAKE_DELAY_MS: '1500' });
  const abort = new AbortController();
  const out = sink();
  const running = migrateCommand({ ...base, repeat: true, abortSignal: abort.signal }, out);
  while (events().filter(([n]) => n === 'start').length < 2) await sleep(20); // the copy job of the first delta has started
  abort.abort();
  assert.equal(await running, 130, out.text());
  const dirs = migrationDirs(dir);
  assert.equal(dirs.length, 2);
  assert.equal(readMigration(dirs[1]).outcome, 'interrupted');
  assert.match(out.text(), /\n1 +\S+-delta-migration +2 +0 +interrupted\n/);
  assert.match(out.text(), /Interrupted in round 1\. Continue it, and the deltas after it, with:\n {2}azcopy-commander migrate --migration ".*-delta-migration" --repeat\n/);
});

test('--repeat: usage errors, and a dry run says that deltas would follow', async () => {
  const { dir, base } = setup();
  await assert.rejects(migrateCommand({ ...base, repeat: true, stopAfter: 'chunk' }, sink()), /--repeat cannot be used with --stop-after/);
  await assert.rejects(migrateCommand({ ...base, repeatUntil: '5' }, sink()), /--repeat-until needs --repeat/);
  await assert.rejects(migrateCommand({ ...base, repeat: true, repeatUntil: '-1' }, sink()), /--repeat-until/);
  await assert.rejects(migrateCommand({ ...base, repeat: true, repeatMax: '0' }, sink()), /--repeat-max/);
  const out = sink();
  assert.equal(await migrateCommand({ ...base, repeat: true, repeatUntil: '0', dryRun: true }, out), 0);
  assert.deepEqual(fs.readdirSync(dir), []);
  assert.match(out.text(), /Then: +delta migrations one after another, until one finds at most 0 objects \(at most 10 deltas\)/);
});
