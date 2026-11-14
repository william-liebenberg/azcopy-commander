import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseLastCopyDate, toUtcSeconds } from '../src/dates.js';
import { buildSourceUrl, parseBucketInput, buildTargetBase, parseTargetSasUrl, Redactor } from '../src/urls.js';
import { deltaDateFor, listCommand, UsageError } from '../src/commands.js';
import { parseCount, parseSize } from '../src/chunks.js';
import { fakeS3 } from './fakes.js';
import { renameSync, writeFileAtomic } from '../src/files.js';

const SAS = 'https://acct.blob.core.windows.net/cont?sv=2022-11-02&sp=racwl&se=2099-01-01T00:00:00Z&sig=SECRETSIG123';

const sink = () => {
  const chunks = [];
  return { isTTY: false, write: (c) => chunks.push(String(c)), text: () => chunks.join('') };
};

test('lastCopyDate: zone-less values are UTC; bad and future values are rejected', () => {
  assert.equal(toUtcSeconds(parseLastCopyDate('2026-01-31')), '2026-01-31T00:00:00Z');
  assert.equal(toUtcSeconds(parseLastCopyDate('2026-01-31T14:30:00')), '2026-01-31T14:30:00Z');
  assert.equal(toUtcSeconds(parseLastCopyDate('2026-01-31T14:30:00+11:00')), '2026-01-31T03:30:00Z');
  assert.throws(() => parseLastCopyDate('nonsense'), UsageError);
  assert.throws(() => parseLastCopyDate('2999-01-01'), /future/);
});

test('source and target URLs', () => {
  assert.equal(buildSourceUrl('my-bucket'), 'https://s3.amazonaws.com/my-bucket');
  assert.equal(buildSourceUrl('my-bucket', '/data/2024 q1/'), 'https://s3.amazonaws.com/my-bucket/data/2024%20q1');
  assert.throws(() => buildSourceUrl('Bad_Bucket'), UsageError);
  assert.equal(buildSourceUrl('my-bucket', 'data', 'ap-southeast-2'), 'https://s3.ap-southeast-2.amazonaws.com/my-bucket/data');
  assert.throws(() => buildSourceUrl('my-bucket', '', 'not a region'), UsageError);
  const target = parseTargetSasUrl(SAS);
  assert.equal(buildTargetBase(target), 'https://acct.blob.core.windows.net/cont');
  assert.equal(buildTargetBase(target, 'data/x y'), 'https://acct.blob.core.windows.net/cont/data/x%20y');
});

test('SAS validation', () => {
  assert.throws(() => parseTargetSasUrl('https://acct.blob.core.windows.net/cont'), /SAS/);
  assert.throws(() => parseTargetSasUrl('https://acct.blob.core.windows.net/?sig=abc'), /container/);
  assert.throws(() => parseTargetSasUrl(SAS.replace('2099', '2001')), /expired/);
  assert.throws(() => parseTargetSasUrl(SAS.replace('racwl', 'rl')), /write/);
  assert.equal(parseTargetSasUrl(SAS.replace('2099-01-01', new Date(Date.now() + 86400e3).toISOString().slice(0, 10))).warnings.length, 1);
});

test('Redactor strips SAS signatures, presigned S3 values and registered secrets', () => {
  const r = new Redactor();
  r.add('topsecretvalue', 'abc'); // too short to be treated as a secret
  assert.equal(r.redact('x?sig=abc%2Bdef&se=1 topsecretvalue abc'), 'x?sig=REDACTED&se=1 *** abc');
  assert.equal(
    r.redact('https://b.s3.amazonaws.com/k?X-Amz-Credential=AKIA%2F1&X-Amz-Security-Token=tok&X-Amz-Signature=deadbeef&x=1'),
    'https://b.s3.amazonaws.com/k?X-Amz-Credential=REDACTED&X-Amz-Security-Token=REDACTED&X-Amz-Signature=REDACTED&x=1',
  );
});

test('parseBucketInput accepts a name or a bucket / object ARN', () => {
  assert.deepEqual(parseBucketInput('my-bucket'), { bucket: 'my-bucket', prefix: '' });
  assert.deepEqual(parseBucketInput(' arn:aws:s3:::my-bucket '), { bucket: 'my-bucket', prefix: '' });
  assert.deepEqual(parseBucketInput('arn:aws:s3:::my-bucket/data/2024'), { bucket: 'my-bucket', prefix: 'data/2024' });
  assert.deepEqual(parseBucketInput('arn:aws:s3:::my-bucket/data/2024/'), { bucket: 'my-bucket', prefix: 'data/2024' });
  assert.throws(() => parseBucketInput('arn:aws:s3:us-east-1:123456789012:accesspoint/x'), /access point/);
  assert.throws(() => parseBucketInput('arn:aws:s3:::Bad_Bucket'), /Invalid S3 bucket/);
  assert.throws(() => parseBucketInput('Bad_Bucket'), /Invalid S3 bucket/);
  assert.throws(() => parseBucketInput(''), UsageError);
});

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

test('deltaDateFor subtracts the overlap', () => {
  assert.equal(deltaDateFor({ startedAt: '2026-10-19T02:48:00.000Z' }).toISOString(), '2026-10-19T02:38:00.000Z');
});

test('list prints s3://bucket/key<TAB>size from the S3 listing, needs no SAS and saves nothing', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'azc-list-'));
  Object.assign(process.env, { AWS_ACCESS_KEY_ID: 'AKIATESTTESTTEST', AWS_SECRET_ACCESS_KEY: 'awssecretawssecretawssecret' });
  const s3 = fakeS3({
    'data/a b.txt': { size: 10, lastModified: '2026-02-01T00:00:00Z' },
    'data/dir/': { size: 0 }, // a folder marker
    'data/dir/c.txt': { size: 20, lastModified: '2026-02-01T00:00:00Z' },
    'data/old.txt': { size: 5, lastModified: '2025-01-01T00:00:00Z' },
    'data/cold.bin': { size: 7, lastModified: '2026-02-01T00:00:00Z', storageClass: 'GLACIER' },
    'other/x.txt': { size: 1 },
  });
  const out = sink();
  const err = sink();
  const base = { outputDir: dir, sourceBucket: 'bkt', sourcePrefix: 'data', s3, targetSasUrl: undefined };
  assert.equal(await listCommand({ ...base, lastCopyDate: '2026-01-01' }, out, err), 0);
  assert.equal(out.text(), 's3://bkt/data/a b.txt\t10\ns3://bkt/data/cold.bin\t7\ns3://bkt/data/dir/c.txt\t20\n');
  assert.match(err.text(), /3 file\(s\), 37 B modified on\/after 2026-01-01T00:00:00Z\. 1 of them archived/);
  assert.deepEqual(s3.pages.map((p) => p.Prefix), ['data/']);
  assert.deepEqual(fs.readdirSync(dir), []); // no run folder, no state
  await assert.rejects(listCommand({ ...base, lastCopyDate: 'auto' }, sink(), sink()), /saved state/);

  // an ARN carries the prefix; a different --source-prefix is refused
  const arn = sink();
  await listCommand({ ...base, sourceBucket: 'arn:aws:s3:::bkt/data', sourcePrefix: undefined }, arn, sink());
  assert.match(arn.text(), /^s3:\/\/bkt\/data\/a b\.txt\t10\n/);
  await assert.rejects(listCommand({ ...base, sourceBucket: 'arn:aws:s3:::bkt/data', sourcePrefix: 'other' }, sink(), sink()), /use only one/);

  // a listing that fails is reported, with exit code 2
  s3.failPage = () => Object.assign(new Error('Access Denied'), { name: 'AccessDenied' });
  const failed = sink();
  assert.equal(await listCommand(base, sink(), failed), 2);
  assert.match(failed.text(), /S3 listing failed: AccessDenied: Access Denied/);
});

test('writeFileAtomic tries a rename again while the file is held open for a moment (EPERM on Windows)', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'azc-files-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'migration.json');
  fs.writeFileSync(file, 'old\n');
  const real = fs.renameSync;
  let calls = 0;
  t.mock.method(fs, 'renameSync', (from, to) => {
    calls++;
    if (calls <= 2) throw Object.assign(new Error(`EPERM: operation not permitted, rename '${from}' -> '${to}'`), { code: 'EPERM' });
    return real(from, to);
  });
  writeFileAtomic(file, 'new\n');
  assert.equal(calls, 3);
  assert.equal(fs.readFileSync(file, 'utf8'), 'new\n');
  assert.equal(fs.existsSync(`${file}.tmp`), false);

  // A hold that lasts throws the error once the time is up; another error is thrown at once.
  calls = 0;
  t.mock.method(fs, 'renameSync', () => {
    calls++;
    throw Object.assign(new Error('EPERM'), { code: 'EPERM' });
  });
  assert.throws(() => renameSync(`${file}.tmp`, file, { totalMs: 50 }), { code: 'EPERM' });
  assert.ok(calls > 1);
  calls = 0;
  t.mock.method(fs, 'renameSync', () => {
    calls++;
    throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
  });
  assert.throws(() => renameSync(`${file}.tmp`, file), { code: 'ENOENT' });
  assert.equal(calls, 1);
});
