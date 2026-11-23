import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { copyChunk } from '../src/blob-copy.js';
import { defaultCopyProcesses, startCopyProcesses } from '../src/copy-processes.js';

const FAKE = fileURLToPath(new URL('./copy-process-fake.js', import.meta.url));
const records = (n) => Array.from({ length: n }, (_, i) => ({ path: `f${i}.txt`, size: 10 }));

test('defaultCopyProcesses: one per chunk copied at once, at most the CPU cores but one', () => {
  assert.equal(defaultCopyProcesses(4, 12), 4);
  assert.equal(defaultCopyProcesses(8, 4), 3);
  assert.equal(defaultCopyProcesses(4, 2), 1);
  assert.equal(defaultCopyProcesses(4, 1), 0);
});

test('copy processes: copies are spread over the processes; a failure keeps its message and code', async () => {
  const copiers = await startCopyProcesses({ processes: 2, data: {}, file: FAKE });
  try {
    const done = await Promise.all(records(8).map((r) => copiers.copy(r)));
    assert.deepEqual(new Set(done.map((d) => d.result)), new Set(['copied']));
    assert.equal(new Set(done.map((d) => d.pid)).size, 2);
    assert.ok(!done.some((d) => d.pid === process.pid));
    await assert.rejects(copiers.copy({ path: 'fail', size: 1 }), { message: 'The specified container does not exist.', code: 'ContainerNotFound' });
  } finally {
    await copiers.close();
  }
});

test('copy processes: copyChunk records their copies and failures, and an abort interrupts it', async () => {
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), 'acc-copiers-'));
  const copiers = await startCopyProcesses({ processes: 2, data: {}, file: FAKE });
  try {
    const report = await copyChunk({ records: [...records(5), { path: 'fail', size: 3 }], concurrency: 4, copy: copiers.copy, runDir, sourceBase: 'https://s3/b', destBase: 'https://acct/c' });
    assert.equal(report.outcome, 'partial');
    assert.equal(report.copied, 5);
    assert.equal(report.failed, 1);
    assert.match(fs.readFileSync(report.files.failed, 'utf8'), /"errorCode":"ContainerNotFound"/);

    const abort = new AbortController();
    const interrupted = copyChunk({ records: [{ path: 'wait', size: 1 }], concurrency: 1, signal: abort.signal, copy: copiers.copy, runDir, sourceBase: 's', destBase: 'd' });
    setTimeout(() => abort.abort(), 50);
    assert.equal((await interrupted).outcome, 'interrupted');
    await assert.rejects(copiers.copy({ path: 'f.txt' }, { signal: abort.signal }), { name: 'AbortError' });
  } finally {
    await copiers.close();
    fs.rmSync(runDir, { recursive: true, force: true });
  }
});

test('copy processes: one that stops is fatal; one that cannot start fails the start', async () => {
  const fatal = [];
  const copiers = await startCopyProcesses({ processes: 1, data: {}, file: FAKE, onFatal: (e) => fatal.push(e) });
  try {
    const waiting = copiers.copy({ path: 'wait' });
    await assert.rejects(copiers.copy({ path: 'exit' }), /A copy process stopped \(exit code 3\)/);
    await assert.rejects(waiting, /A copy process stopped/);
    assert.equal(fatal.length, 1);
    await assert.rejects(copiers.copy({ path: 'f.txt' }), /No copy process is running/);
  } finally {
    await copiers.close();
  }
  await assert.rejects(startCopyProcesses({ processes: 2, data: { failStart: true }, file: FAKE }), /^Error: the SDK cannot be loaded$/);
  await assert.rejects(startCopyProcesses({ processes: 1, data: { crash: true }, file: FAKE }), /A copy process stopped \(exit code 1\): TypeError: crashed while starting\./);
});
