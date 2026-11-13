import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseLastCopyDate, toAzcopyDate } from '../src/dates.js';
import { buildSourceUrl, parseBucketInput, buildTargetBase, buildTargetUrl, parseTargetSasUrl, relativeSourcePath, Redactor } from '../src/urls.js';
import { Metrics } from '../src/metrics.js';
import { parseAzcopyLine } from '../src/runner.js';
import { copyCommand, listCommand, listRuns, deltaDateFor, retryCommand, resumeCommand, UsageError } from '../src/commands.js';

const SAS = 'https://acct.blob.core.windows.net/cont?sv=2022-11-02&sp=racwl&se=2099-01-01T00:00:00Z&sig=SECRETSIG123';

test('lastCopyDate: zone-less values are UTC; bad and future values are rejected', () => {
  assert.equal(toAzcopyDate(parseLastCopyDate('2026-01-31')), '2026-01-31T00:00:00Z');
  assert.equal(toAzcopyDate(parseLastCopyDate('2026-01-31T14:30:00')), '2026-01-31T14:30:00Z');
  assert.equal(toAzcopyDate(parseLastCopyDate('2026-01-31T14:30:00+11:00')), '2026-01-31T03:30:00Z');
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
  assert.equal(buildTargetUrl(target, 'data'), `https://acct.blob.core.windows.net/cont/data?${target.query}`);
});

test('SAS validation', () => {
  assert.throws(() => parseTargetSasUrl('https://acct.blob.core.windows.net/cont'), /SAS/);
  assert.throws(() => parseTargetSasUrl('https://acct.blob.core.windows.net/?sig=abc'), /container/);
  assert.throws(() => parseTargetSasUrl(SAS.replace('2099', '2001')), /expired/);
  assert.throws(() => parseTargetSasUrl(SAS.replace('racwl', 'rl')), /write/);
  assert.equal(parseTargetSasUrl(SAS.replace('2099-01-01', new Date(Date.now() + 86400e3).toISOString().slice(0, 10))).warnings.length, 1);
});

test('relativeSourcePath handles path-style, virtual-host and relative sources', () => {
  const ctx = { bucket: 'bkt', prefix: 'data' };
  assert.equal(relativeSourcePath('https://s3.amazonaws.com/bkt/data/a%20b/c.txt?x=1', ctx), 'a b/c.txt');
  assert.equal(relativeSourcePath('https://bkt.s3.amazonaws.com/data/c.txt', ctx), 'c.txt');
  assert.equal(relativeSourcePath('a/b.txt', ctx), 'a/b.txt');
  assert.equal(relativeSourcePath('https://s3.amazonaws.com/bkt/x.txt', { bucket: 'bkt' }), 'x.txt');
});

test('Redactor strips SAS signatures and registered secrets', () => {
  const r = new Redactor();
  r.add('topsecretvalue', 'abc'); // too short to be treated as a secret
  assert.equal(r.redact('x?sig=abc%2Bdef&se=1 topsecretvalue abc'), 'x?sig=REDACTED&se=1 *** abc');
});

test('parseAzcopyLine decodes nested JSON content and tolerates non-JSON', () => {
  const line = JSON.stringify({ MessageType: 'Progress', MessageContent: JSON.stringify({ TotalTransfers: '5' }) });
  assert.deepEqual(parseAzcopyLine(line).data, { TotalTransfers: '5' });
  assert.equal(parseAzcopyLine('INFO: plain text').type, 'Raw');
  assert.equal(parseAzcopyLine(JSON.stringify({ MessageType: 'Info', MessageContent: '{not json' })).data, undefined);
});

test('Metrics maps the azcopy summary to counters, throughput and ETA', () => {
  const m = new Metrics(0);
  const summary = { TotalTransfers: '10', TransfersCompleted: '6', TransfersFailed: '1', TransfersSkipped: '2', TotalBytesExpected: '2000', CompleteJobOrdered: true };
  m.update({ ...summary, TotalBytesTransferred: '0' }, 0);
  m.update({ ...summary, TotalBytesTransferred: '1000' }, 1000);
  const s = m.snapshot(1000);
  assert.deepEqual([s.discovered, s.copied, s.failed, s.ignored], [10, 6, 1, 2]);
  assert.deepEqual([s.throughput, s.etaSeconds, s.percent], [1000, 1, 50]);
  m.update({ ...summary, CompleteJobOrdered: false, TotalBytesTransferred: '1000' }, 2000);
  assert.ok(Number.isNaN(m.snapshot(2000).etaSeconds), 'no ETA while still scanning');
});

// ------------------------------------------------------------- end to end with a fake azcopy

const sink = () => {
  const chunks = [];
  return { isTTY: false, write: (c) => chunks.push(String(c)), text: () => chunks.join('') };
};

function harness() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'azc-'));
  const argsFile = path.join(dir, 'args.jsonl');
  Object.assign(process.env, { AWS_ACCESS_KEY_ID: 'AKIATESTTESTTEST', AWS_SECRET_ACCESS_KEY: 'awssecretawssecretawssecret', FAKE_ARGS_FILE: argsFile });
  delete process.env.FAKE_NO_TRANSFERS;
  const base = {
    azcopyCommand: { bin: process.execPath, prefixArgs: [fileURLToPath(new URL('fixtures/fake-azcopy.js', import.meta.url))] },
    outputDir: dir,
    targetSasUrl: SAS,
    sourceBucket: 'bkt',
    sourcePrefix: 'data',
    sourceRegion: 'ap-southeast-2',
  };
  const copyCalls = () => fs.readFileSync(argsFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l)).filter((a) => a[0] === 'copy');
  const runDir = (suffix) => path.join(dir, fs.readdirSync(dir).find((f) => f.endsWith(suffix)));
  return { dir, base, copyCalls, runDir };
}

test('copy -> delta(auto) -> retry', async () => {
  const { base, copyCalls, runDir } = harness();

  // Full copy. The fake reports 2 failures: one in a progress message, the other only via `jobs show`.
  const out = sink();
  assert.equal(await copyCommand(base, out), 1);
  const full = runDir('-full');
  const files = fs.readdirSync(full);
  assert.ok(files.some((f) => /^copy-\d{8}T\d{6}Z\.log$/.test(f)), 'timestamped copy log');
  const failedFile = files.find((f) => f.startsWith('failed-'));
  const failed = fs.readFileSync(path.join(full, failedFile), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(failed.map((f) => f.relativePath), ['a b.txt', 'dir/c.txt']);

  const [args] = copyCalls();
  assert.ok(args.includes('--overwrite=false') && args.includes('--as-subdir=false') && !args.includes('--include-after'));
  assert.equal(args[1], 'https://s3.ap-southeast-2.amazonaws.com/bkt/data');
  assert.ok(args[2].startsWith('https://acct.blob.core.windows.net/cont/data?'));

  const manifest = JSON.parse(fs.readFileSync(path.join(full, 'run.json'), 'utf8'));
  assert.deepEqual([manifest.summary.discovered, manifest.summary.copied, manifest.summary.failed, manifest.summary.ignored], [4, 1, 2, 1]);
  assert.equal(manifest.outcome, 'partial');
  for (const f of fs.readdirSync(full).filter((f) => /\.(log|jsonl|json)$/.test(f))) {
    assert.ok(!/SECRETSIG123|awssecretawssecret/.test(fs.readFileSync(path.join(full, f), 'utf8')), `secret leaked in ${f}`);
  }
  assert.ok(!out.text().includes('SECRETSIG123'));
  assert.match(out.text(), /Files discovered: 4/);

  // Delta run: the date comes from state.json.
  await copyCommand({ ...base, lastCopyDate: 'auto' }, sink());
  const delta = copyCalls().at(-1);
  assert.match(delta[delta.indexOf('--include-after') + 1], /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);

  // Retry reads the failed list of the first run.
  assert.equal(await retryCommand({ ...base, run: full }, sink()), 0);
  const retry = copyCalls().at(-1);
  assert.equal(retry[1], 'https://s3.ap-southeast-2.amazonaws.com/bkt/data');
  assert.ok(retry.includes('--list-of-files') && !retry.includes('--include-after'));
});

test('retry and resume without --run use the latest run after confirmation', async () => {
  const { base, copyCalls } = harness();
  await assert.rejects(retryCommand(base, sink()), /No earlier run/);

  await copyCommand(base, sink()); // full copy with 2 failed files
  const calls = copyCalls().length;

  const asked = [];
  const no = async (q) => (asked.push(q), false);
  await assert.rejects(retryCommand({ ...base, confirm: no }, sink()), /Cancelled/);
  assert.match(asked[0], /Retry the failed files of this run\?/);
  assert.equal(copyCalls().length, calls, 'declining runs nothing');

  const out = sink();
  assert.equal(await retryCommand({ ...base, confirm: async () => true }, out), 0);
  assert.match(out.text(), /Latest run: .*-full\n {2}copy, started .*, outcome partial, 2 failed file\(s\)/);
  assert.ok(copyCalls().at(-1).includes('--list-of-files'));

  // --yes skips the question. The latest run is now the successful retry, so there is nothing to resume.
  await assert.rejects(resumeCommand({ ...base, run: undefined, yes: true, confirm: async () => assert.fail('asked') }, sink()), /already completed/);
});
test('--overwrite-modified uses ifSourceNewer, is reused by retry and rejected by resume', async () => {
  const { base, copyCalls, runDir } = harness();
  await copyCommand({ ...base, lastCopyDate: '2026-01-01', overwriteModified: true }, sink());
  const [first] = copyCalls();
  assert.ok(first.includes('--overwrite=ifSourceNewer') && !first.includes('--overwrite=false') && first.includes('--include-after'));

  await retryCommand({ ...base, run: runDir('-delta') }, sink());
  assert.ok(copyCalls().at(-1).includes('--overwrite=ifSourceNewer'));
  await assert.rejects(resumeCommand({ ...base, run: runDir('-delta'), overwriteModified: true }, sink()), UsageError);
});

test('a delta run with nothing to copy succeeds', async () => {
  const { base } = harness();
  process.env.FAKE_NO_TRANSFERS = '1';
  assert.equal(await copyCommand({ ...base, lastCopyDate: '2026-01-01' }, sink()), 0);
});

test('usage errors; dry run touches nothing', async () => {
  const { dir, base } = harness();
  await assert.rejects(copyCommand({ ...base, lastCopyDate: 'auto' }, sink()), /no earlier run/);
  await assert.rejects(copyCommand({ ...base, lastCopyDate: 'bad' }, sink()), UsageError);
  await assert.rejects(copyCommand({ ...base, sourceBucket: undefined }, sink()), UsageError);
  const out = sink();
  assert.equal(await copyCommand({ ...base, dryRun: true }, out), 0);
  assert.match(out.text(), /Dry run/);
  assert.ok(!out.text().includes('SECRETSIG123'));
  assert.deepEqual(fs.readdirSync(dir), []);
});

test('list prints the source files and saves nothing', async () => {
  const { dir, base, copyCalls } = harness();
  const out = sink();
  const err = sink();
  assert.equal(await listCommand({ ...base, lastCopyDate: '2026-01-01' }, out, err), 0);
  assert.equal(out.text(), 's3://bkt/data/a b.txt\t10\ns3://bkt/data/dir/c.txt\t20\n'); // the Folder entry is skipped
  assert.match(err.text(), /2 file\(s\), 30 B modified on\/after 2026-01-01T00:00:00Z/);
  const [args] = copyCalls();
  assert.ok(args.includes('--dry-run') && args.includes('--include-after'));
  assert.equal(args[args.indexOf('--log-level') + 1], 'NONE');
  assert.deepEqual(fs.readdirSync(dir).filter((f) => f !== 'args.jsonl'), []); // no run dir, manifest or state
  await assert.rejects(listCommand({ ...base, lastCopyDate: 'auto' }, sink(), sink()), /saved state/);
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

test('--source-bucket accepts an ARN; its prefix must not contradict --source-prefix', async () => {
  const { base, copyCalls } = harness();
  await copyCommand({ ...base, sourceBucket: 'arn:aws:s3:::bkt/data', sourcePrefix: undefined }, sink());
  assert.equal(copyCalls()[0][1], 'https://s3.ap-southeast-2.amazonaws.com/bkt/data');
  await copyCommand({ ...base, sourceBucket: 'arn:aws:s3:::bkt/data', sourcePrefix: 'data' }, sink()); // same prefix: fine
  await assert.rejects(copyCommand({ ...base, sourceBucket: 'arn:aws:s3:::bkt/data', sourcePrefix: 'other' }, sink()), /use only one/);
  const out = sink();
  await listCommand({ ...base, sourceBucket: 'arn:aws:s3:::bkt/data', sourcePrefix: undefined }, out, sink());
  assert.match(out.text(), /^s3:\/\/bkt\/data\/a b\.txt\t10\n/);
});

test('listRuns returns the runs newest first with counts and region; deltaDateFor subtracts the overlap', async () => {
  const { dir, base } = harness();
  assert.deepEqual(listRuns({ outputDir: path.join(dir, 'missing') }), []);
  await copyCommand(base, sink()); // full, regional endpoint, 2 failed files
  await new Promise((r) => setTimeout(r, 1100)); // run directory names have a one second resolution
  await copyCommand({ ...base, sourceRegion: undefined, lastCopyDate: '2026-01-01' }, sink());
  fs.mkdirSync(path.join(dir, '20200101T000000Z-full')); // no run.json: ignored
  fs.mkdirSync(path.join(dir, 'not-a-run'));

  const runs = listRuns({ outputDir: dir });
  assert.deepEqual(runs.map((r) => r.kind), ['delta', 'full']);
  const [delta, full] = runs;
  assert.deepEqual([full.outcome, full.copied, full.failed, full.jobId, full.bucket, full.prefix, full.region], ['partial', 1, 2, 'job-1', 'bkt', 'data', 'ap-southeast-2']);
  assert.equal(full.targetBase, 'https://acct.blob.core.windows.net/cont');
  assert.equal(full.overwriteModified, false);
  assert.equal(delta.region, '', 'the global endpoint has no region');
  assert.ok(full.dir.startsWith(dir) && fs.existsSync(path.join(full.dir, 'run.json')));
  assert.equal(deltaDateFor({ startedAt: '2026-10-19T02:48:00.000Z' }).toISOString(), '2026-10-19T02:38:00.000Z');
});
test('a dashboard view changes nothing in the log, failed list, run.json or exit code, and leaks no secret', async () => {
  const { Dashboard } = await import('../src/ui/dashboard.js');
  const artefacts = (dir) => {
    const run = path.join(dir, fs.readdirSync(dir).find((f) => f.endsWith('-full')));
    const read = (re) => fs.readFileSync(path.join(run, fs.readdirSync(run).find((f) => re.test(f))), 'utf8');
    const manifest = JSON.parse(read(/^run\.json$/));
    return {
      run,
      failed: read(/^failed-.*\.jsonl$/),
      log: read(/^copy-.*\.log$/).split('\n').filter((l) => /FAILED|Status:|Files /.test(l)).map((l) => l.replace(/^\S+ /, '')),
      summary: { ...manifest.summary, elapsedSeconds: 0, files: undefined },
      outcome: manifest.outcome,
    };
  };

  const plainRun = harness();
  const plainOut = sink();
  const plainCode = await copyCommand(plainRun.base, plainOut);
  const plain = artefacts(plainRun.dir);

  const fancyRun = harness();
  const writes = [];
  const term = { isTTY: true, columns: 100, write: (c) => writes.push(String(c)), on() {}, off() {} };
  const fancyCode = await copyCommand({ ...fancyRun.base, view: new Dashboard({ out: term, color: true }) }, term);
  const fancy = artefacts(fancyRun.dir);

  assert.equal(fancyCode, plainCode);
  assert.equal(fancy.failed, plain.failed);
  assert.deepEqual(fancy.log, plain.log);
  assert.deepEqual(fancy.summary, plain.summary);
  assert.equal(fancy.outcome, plain.outcome);

  const screen = writes.join('').replaceAll('\x1b[?2026h', '').replaceAll('\x1b[?2026l', '');
  assert.ok(screen.includes('Completed with failed files'), 'result panel');
  assert.ok(screen.includes('failed 2'));
  assert.ok(!screen.includes('Copy summary') && !screen.includes('Source:'), 'no plain output with a view');
  assert.ok(screen.trimEnd().endsWith('\x1b[?25h'), 'cursor shown at the end');
  for (const [text, where] of [[screen, 'screen'], [fancy.failed, 'failed list'], [fs.readdirSync(fancy.run).filter((f) => fs.statSync(path.join(fancy.run, f)).isFile()).map((f) => fs.readFileSync(path.join(fancy.run, f), 'utf8')).join(''), 'run directory']]) {
    assert.ok(!/SECRETSIG123|awssecretawssecret/.test(text), `secret in ${where}`);
  }
});
test('the view gets failures with their error code and the azcopy messages that are only logged, redacted', async () => {
  const { PlainView } = await import('../src/view.js');
  const { base, runDir } = harness();
  const seen = { failures: [], logs: [], calls: [] };
  const view = new PlainView(sink());
  view.failure = (p, code) => seen.failures.push([p, code]);
  view.log = (level, text) => seen.logs.push([level, text]);
  view.close = () => seen.calls.push('close');
  process.env.FAKE_CHATTER = '1';
  try {
    await copyCommand({ ...base, view }, sink());
  } finally {
    delete process.env.FAKE_CHATTER;
  }
  assert.deepEqual(seen.failures, [['a b.txt', '403'], ['dir/c.txt', '403']]);
  // stdout and stderr are separate pipes: which line arrives first is a race
  assert.deepEqual(seen.logs.map(([level]) => level).sort(), ['INFO', 'STDERR']);
  assert.ok(seen.logs.every(([, text]) => !/SECRETSIG123|awssecretawssecret/.test(text)), JSON.stringify(seen.logs));
  assert.match(seen.logs.find(([level]) => level === 'INFO')[1], /listing .*sig=REDACTED/);
  assert.deepEqual(seen.calls, ['close']);
  assert.match(fs.readFileSync(path.join(runDir('-full'), fs.readdirSync(runDir('-full')).find((f) => f.endsWith('.log'))), 'utf8'), /STDERR/);
});
