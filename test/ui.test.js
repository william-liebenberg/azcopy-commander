import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runWizard, fit } from '../src/ui/wizard.js';
import { Secrets } from '../src/ui/secrets.js';
import { Dashboard, renderDashboard } from '../src/ui/dashboard.js';
import { colorEnabled, createStyle, unicodeSupported, visible } from '../src/ui/style.js';
import * as realCommands from '../src/commands.js';
import * as realMigration from '../src/migration.js';
import { MigrationDashboard, renderMigrationDashboard } from '../src/ui/migration-dashboard.js';

const SAS = 'https://acct.blob.core.windows.net/cont?sv=2022-11-02&sp=racwl&se=2099-01-01T00:00:00Z&sig=SECRETSIG123';
const OTHER_SAS = 'https://other.blob.core.windows.net/elsewhere?sv=2022-11-02&sp=racwl&se=2099-01-01T00:00:00Z&sig=OTHERSIG456';
const KEY = 'AKIATYPEDKEY12345';
const SECRET = 'typedAwsSecretValue0123456789';
const TOKEN = 'typedSessionTokenValue987';
const SECRET_TEXTS = [KEY, SECRET, TOKEN, 'SECRETSIG123', 'OTHERSIG456'];
const CANCEL = Symbol('cancel');

/**
 * A scripted stand-in for @clack/prompts: every select / text / password / confirm takes the next answer
 * (a value, CANCEL, or a function of the prompt options). Typed answers go through the prompt's own validate.
 */
function fakePrompts(answers) {
  const queue = [...answers];
  const asked = [];
  const shown = [];
  const ask = (kind) => async (options) => {
    asked.push({ kind, ...options });
    assert.ok(queue.length, `unscripted ${kind} prompt: ${options.message}`);
    const answer = queue.shift();
    const value = typeof answer === 'function' ? answer(options) : answer;
    if (value !== CANCEL && (kind === 'text' || kind === 'password') && options.validate) {
      assert.equal(options.validate(value), undefined, `"${options.message}" rejected the scripted answer`);
    }
    return value;
  };
  const say = (type) => (message) => shown.push(`${type}: ${message}`);
  return {
    asked,
    shown,
    remaining: () => queue.length,
    isCancel: (v) => v === CANCEL,
    select: ask('select'),
    text: ask('text'),
    password: ask('password'),
    confirm: ask('confirm'),
    intro: say('intro'),
    outro: say('outro'),
    cancel: say('cancel'),
    note: (message, title) => shown.push(`note ${title}: ${message}`),
    log: { info: say('info'), warn: say('warn'), error: say('error') },
  };
}

const pick = (value) => (o) => o.options.find((x) => (typeof x.value === 'string' ? x.value === value : false))?.value ?? assert.fail(`no option ${value}`);
const pickRun = (index) => (o) => o.options[index].value;

const sink = () => {
  const chunks = [];
  return { isTTY: false, write: (c) => chunks.push(String(c)), text: () => chunks.join('') };
};

/** A temporary output directory with fabricated runs (newest last in this list). */
function fabricatedRuns(runs) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'azc-ui-'));
  for (const r of runs) {
    const runDir = path.join(dir, r.name);
    fs.mkdirSync(runDir);
    if (r.manifest === false) continue; // a folder without run.json
    fs.writeFileSync(
      path.join(runDir, 'run.json'),
      JSON.stringify({
        kind: 'copy',
        startedAt: r.startedAt,
        outcome: r.outcome,
        jobId: r.jobId ?? null,
        bucket: r.bucket ?? 'bkt',
        prefix: r.prefix ?? '',
        sourceBase: r.region ? `https://s3.${r.region}.amazonaws.com/bkt` : 'https://s3.amazonaws.com/bkt',
        targetBase: r.targetBase ?? 'https://acct.blob.core.windows.net/cont',
        overwriteModified: Boolean(r.overwriteModified),
        summary: { copied: r.copied ?? 0, failed: r.failed ?? 0 },
      }),
    );
  }
  return dir;
}

const RUNS = [
  { name: '20261018T210300Z-full', startedAt: '2026-10-18T21:03:00.000Z', outcome: 'partial', jobId: 'job-a', copied: 5, failed: 41, region: 'ap-southeast-2', prefix: 'data' },
  { name: '20261019T024800Z-full', startedAt: '2026-10-19T02:48:00.000Z', outcome: 'success', jobId: 'job-b', copied: 0, failed: 0 },
  { name: '20261019T025000Z-delta', startedAt: '2026-10-19T02:50:00.000Z', outcome: 'interrupted', jobId: 'job-c', copied: 1, failed: 0, overwriteModified: true },
  { name: '20261019T030000Z-retry', startedAt: '2026-10-19T03:00:00.000Z', outcome: 'failed', jobId: null, copied: 0, failed: 0 },
  { name: '20261019T031000Z-full', manifest: false },
];

/** Commands that only record the options they were called with. */
function spyCommands(calls, code = 0) {
  const record = (name) => async (opts) => {
    calls.push({ name, opts: { ...opts } });
    return code;
  };
  return { listRuns: realCommands.listRuns, deltaDateFor: realCommands.deltaDateFor, copyCommand: record('copy'), listCommand: record('list'), retryCommand: record('retry'), resumeCommand: record('resume'), migrateCommand: record('migrate'), listMigrations: realMigration.listMigrations };
}

const typedCredentials = [KEY, SECRET, TOKEN, SAS];
const sourceAnswers = ['bkt', 'data', 'ap-southeast-2', false]; // bucket, prefix, region, overwrite-modified

test('fit shortens in the middle and leaves short text alone', () => {
  assert.equal(fit('short', 10), 'short');
  const f = fit('https://example.com/a/very/long/path', 20);
  assert.equal(f.length, 20);
  assert.ok(f.startsWith('https://') && f.endsWith('/path') && f.includes('…'));
});

test('Secrets applies typed AWS values to the environment and restores the old ones', () => {
  const env = { AWS_ACCESS_KEY_ID: 'old-key-id', AWS_SESSION_TOKEN: 'old-session-token' };
  const s = new Secrets(env);
  s.setAws({ accessKeyId: KEY, secretAccessKey: SECRET });
  s.setSas(SAS, 'typed');
  s.apply();
  assert.deepEqual(env, { AWS_ACCESS_KEY_ID: KEY, AWS_SECRET_ACCESS_KEY: SECRET }); // the old session token is hidden
  s.restore();
  assert.deepEqual(env, { AWS_ACCESS_KEY_ID: 'old-key-id', AWS_SESSION_TOKEN: 'old-session-token' });
  assert.equal(s.redact(`${KEY} ${SECRET} ?sig=SECRETSIG123`), '*** *** ?sig=REDACTED');
  assert.ok(!s.describe().includes(SECRET) && !s.describe().includes('SECRETSIG123'));
});

test('full copy with typed secrets: right options, nothing leaked, environment restored', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'azc-ui-e2e-'));
  const argsFile = path.join(dir, 'args.jsonl');
  const saved = {};
  for (const k of ['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN', 'AZCOPY_COMMANDER_TARGET_SAS_URL', 'FAKE_ARGS_FILE', 'FAKE_NO_TRANSFERS']) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  process.env.FAKE_ARGS_FILE = argsFile;
  try {
    const prompts = fakePrompts([pick('copy'), ...typedCredentials, ...sourceAnswers, true]);
    const out = sink();
    const err = sink();
    const code = await runWizard({
      prompts,
      env: process.env,
      out,
      err,
      baseOpts: {
        outputDir: dir,
        azcopyCommand: { bin: process.execPath, prefixArgs: [fileURLToPath(new URL('fixtures/fake-azcopy.js', import.meta.url))] },
      },
    });
    assert.equal(code, 1, 'the fake azcopy completes with failed files');
    assert.equal(prompts.remaining(), 0);
    assert.deepEqual(prompts.asked.filter((a) => a.kind === 'password').length, 4); // key, secret, token, SAS

    const call = fs.readFileSync(argsFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l)).find((a) => a[0] === 'copy');
    assert.equal(call[1], 'https://s3.ap-southeast-2.amazonaws.com/bkt/data');
    assert.ok(call[2].startsWith('https://acct.blob.core.windows.net/cont/data?') && call.includes('--overwrite=false'));

    // Nothing secret anywhere on screen or in the run directory.
    const everything = [out.text(), err.text(), prompts.shown.join('\n'), JSON.stringify(prompts.asked.map((a) => a.message))].join('\n');
    for (const secret of SECRET_TEXTS) assert.ok(!everything.includes(secret), `${secret} on screen`);
    assert.match(prompts.shown.join('\n'), /Secrets {2}AWS key: typed \(memory only\)/);
    const runDir = path.join(dir, fs.readdirSync(dir).find((f) => f.endsWith('-full')));
    const files = fs.readdirSync(runDir, { recursive: true, withFileTypes: true }).filter((e) => e.isFile());
    assert.ok(files.length > 0);
    for (const f of files) {
      const text = fs.readFileSync(path.join(f.parentPath, f.name), 'utf8');
      for (const secret of SECRET_TEXTS) assert.ok(!text.includes(secret), `${secret} in ${f.name}`);
    }
    for (const k of ['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN']) assert.equal(process.env[k], undefined, `${k} restored`);
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
});

test('typed AWS values are visible to the command while it runs, and gone after', async () => {
  const env = {};
  const calls = [];
  const commands = spyCommands(calls);
  commands.copyCommand = async (opts) => {
    calls.push({ name: 'copy', opts: { ...opts }, awsKey: env.AWS_ACCESS_KEY_ID, awsSecret: env.AWS_SECRET_ACCESS_KEY, token: env.AWS_SESSION_TOKEN });
    return 0;
  };
  const prompts = fakePrompts([pick('copy'), ...typedCredentials, ...sourceAnswers, true]);
  assert.equal(await runWizard({ prompts, env, baseOpts: { outputDir: 'unused' }, commands }), 0);
  assert.equal(calls.length, 1);
  assert.deepEqual([calls[0].awsKey, calls[0].awsSecret, calls[0].token], [KEY, SECRET, TOKEN]);
  assert.equal(calls[0].opts.sourceBucket, 'bkt');
  assert.equal(calls[0].opts.sourcePrefix, 'data');
  assert.equal(calls[0].opts.sourceRegion, 'ap-southeast-2');
  assert.equal(calls[0].opts.targetSasUrl, SAS);
  assert.equal(calls[0].opts.lastCopyDate, undefined);
  assert.equal(calls[0].opts.overwriteModified, false);
  assert.deepEqual(env, {});
});

test('secrets from the environment: "Use them" does not ask for typed values', async () => {
  const env = { AWS_ACCESS_KEY_ID: KEY, AWS_SECRET_ACCESS_KEY: SECRET, AZCOPY_COMMANDER_TARGET_SAS_URL: SAS };
  const calls = [];
  const prompts = fakePrompts([pick('list'), pick('env'), pick('env'), 'arn:aws:s3:::bkt/data/x', '', '', false, true]);
  assert.equal(await runWizard({ prompts, env, commands: spyCommands(calls) }), 0);
  assert.equal(prompts.asked.filter((a) => a.kind === 'password').length, 0);
  assert.deepEqual(calls.map((c) => c.name), ['list']);
  assert.equal(calls[0].opts.sourceBucket, 'bkt');
  assert.equal(calls[0].opts.sourcePrefix, 'data/x', 'the ARN prefix is used when none is typed');
  assert.equal(calls[0].opts.targetSasUrl, SAS);
  assert.match(prompts.shown.join('\n'), /AWS key: environment · AWS secret: environment · SAS: environment/);
  assert.deepEqual(env, { AWS_ACCESS_KEY_ID: KEY, AWS_SECRET_ACCESS_KEY: SECRET, AZCOPY_COMMANDER_TARGET_SAS_URL: SAS });
});

test('an ARN prefix and a different typed prefix: the user chooses', async () => {
  const calls = [];
  const prompts = fakePrompts([pick('copy'), ...typedCredentials, 'arn:aws:s3:::bkt/from-arn', 'typed', (o) => o.options[0].value, '', false, true]);
  await runWizard({ prompts, env: {}, commands: spyCommands(calls) });
  assert.equal(calls[0].opts.sourcePrefix, 'from-arn');
});

test('prompt validators reject bad input without leaking it', async () => {
  const prompts = fakePrompts([pick('copy'), KEY, SECRET, '', SAS, 'bkt', '', '', false, false, pick('quit')]);
  await runWizard({ prompts, env: {}, commands: spyCommands([]) });
  const byMessage = (m) => prompts.asked.find((a) => a.message.includes(m));
  assert.match(byMessage('Target SAS URL').validate('https://acct.blob.core.windows.net/cont'), /SAS/);
  assert.match(byMessage('Target SAS URL').validate(SAS.replace('racwl', 'rl')), /write/);
  assert.equal(byMessage('Target SAS URL').validate(''), 'Target SAS URL is not a valid URL.');
  assert.match(byMessage('bucket name or ARN').validate('Bad_Bucket'), /Invalid S3 bucket/);
  assert.match(byMessage('bucket name or ARN').validate('arn:aws:s3:us-east-1:123:accesspoint/x'), /access point/);
  assert.match(byMessage('region').validate('nowhere'), /Invalid AWS region/);
  assert.equal(byMessage('region').validate(''), undefined);
  assert.match(byMessage('access key ID').validate(' '), /required/);
});

test('Ctrl+C at every step ends with exit code 130 and runs nothing', async () => {
  const script = [pick('copy'), ...typedCredentials, ...sourceAnswers, true];
  for (let i = 0; i < script.length; i++) {
    const calls = [];
    const env = {};
    const prompts = fakePrompts([...script.slice(0, i), CANCEL]);
    assert.equal(await runWizard({ prompts, env, commands: spyCommands(calls) }), 130, `cancel at step ${i}`);
    assert.deepEqual(calls, []);
    assert.deepEqual(env, {});
    assert.ok(prompts.shown.some((s) => s === 'cancel: Cancelled'));
  }
});

test('declining the confirmation runs nothing and returns to the menu', async () => {
  const calls = [];
  const prompts = fakePrompts([pick('copy'), ...typedCredentials, ...sourceAnswers, false, pick('quit')]);
  assert.equal(await runWizard({ prompts, env: {}, commands: spyCommands(calls) }), 0);
  assert.deepEqual(calls, []);
});

test('delta copy: pick a run; baseline = its start minus 10 minutes; source prefilled from the run', async () => {
  const dir = fabricatedRuns(RUNS);
  const calls = [];
  let runOptions;
  const prompts = fakePrompts([
    pick('delta'), ...typedCredentials,
    (o) => ((runOptions = o.options), o.options[0].value), // newest run that listed the bucket: the interrupted delta is not "success or partial"
    ...sourceAnswers, true,
  ]);
  assert.equal(await runWizard({ prompts, env: {}, baseOpts: { outputDir: dir }, commands: spyCommands(calls) }), 0);
  // Delta lists success / partial runs only, newest first: the 02:48 full run (success) then the 21:03 full run (partial).
  const labels = runOptions.map((o) => o.label);
  assert.equal(labels.length, 3, 'two runs and "Enter a date instead"');
  assert.match(labels[0], /^2026-10-19 02:48 {2}full +success +0 copied · 0 failed · bkt/);
  assert.match(labels[1], /^2026-10-18 21:03 {2}full +partial +5 copied · 41 failed · bkt\/data/);
  assert.match(labels[2], /Enter a date instead/);
  assert.equal(calls[0].opts.lastCopyDate, '2026-10-19T02:38:00.000Z');
  assert.equal(calls[0].opts.sourceBucket, 'bkt');
});

test('delta copy from an older run prefills prefix, region and overwrite-modified', async () => {
  const dir = fabricatedRuns(RUNS);
  const calls = [];
  const prompts = fakePrompts([
    pick('delta'), ...typedCredentials,
    pickRun(1), // the 21:03 partial run: prefix "data", region ap-southeast-2
    (o) => (assert.equal(o.initialValue, 'bkt'), o.initialValue),
    (o) => (assert.equal(o.initialValue, 'data'), o.initialValue),
    (o) => (assert.equal(o.initialValue, 'ap-southeast-2'), o.initialValue),
    (o) => (assert.equal(o.initialValue, false), false),
    true,
  ]);
  await runWizard({ prompts, env: {}, baseOpts: { outputDir: dir }, commands: spyCommands(calls) });
  assert.equal(calls[0].opts.lastCopyDate, '2026-10-18T20:53:00.000Z');
  assert.deepEqual([calls[0].opts.sourcePrefix, calls[0].opts.sourceRegion], ['data', 'ap-southeast-2']);
});

test('delta copy: "Enter a date instead" and no runs at all', async () => {
  const dir = fabricatedRuns(RUNS);
  const calls = [];
  const prompts = fakePrompts([pick('delta'), ...typedCredentials, (o) => o.options.at(-1).value, '2026-01-31', ...sourceAnswers, true]);
  await runWizard({ prompts, env: {}, baseOpts: { outputDir: dir }, commands: spyCommands(calls) });
  assert.equal(calls[0].opts.lastCopyDate, '2026-01-31T00:00:00.000Z');

  const empty = fabricatedRuns([]);
  const calls2 = [];
  const prompts2 = fakePrompts([pick('delta'), ...typedCredentials, '2026-02-01T10:00:00Z', ...sourceAnswers, true]);
  await runWizard({ prompts: prompts2, env: {}, baseOpts: { outputDir: empty }, commands: spyCommands(calls2) });
  assert.equal(calls2[0].opts.lastCopyDate, '2026-02-01T10:00:00.000Z');
  assert.ok(!prompts2.asked.some((a) => a.message.startsWith('Delta since')), 'no run to pick');
});

test('delta copy warns when the run copied to another target', async () => {
  const dir = fabricatedRuns(RUNS);
  const calls = [];
  const prompts = fakePrompts([
    pick('delta'), ...typedCredentials.slice(0, 3), OTHER_SAS, pickRun(0), ...sourceAnswers, false, // "Run anyway?" -> no
    pick('quit'),
  ]);
  await runWizard({ prompts, env: {}, baseOpts: { outputDir: dir }, commands: spyCommands(calls) });
  assert.deepEqual(calls, []);
  assert.ok(prompts.shown.some((s) => s.startsWith('warn: That run copied to')));
});

test('retry lists only runs with failed files and passes the chosen run', async () => {
  const dir = fabricatedRuns(RUNS);
  const calls = [];
  let options;
  const prompts = fakePrompts([pick('retry'), ...typedCredentials, (o) => ((options = o.options), o.options[0].value), true]);
  assert.equal(await runWizard({ prompts, env: {}, baseOpts: { outputDir: dir }, commands: spyCommands(calls) }), 0);
  assert.equal(options.length, 1);
  assert.match(options[0].label, /41 failed/);
  assert.equal(calls[0].name, 'retry');
  assert.equal(calls[0].opts.run, path.join(dir, '20261018T210300Z-full'));
  assert.equal(calls[0].opts.targetSasUrl, SAS);
});

test('retry with a SAS for another target is refused before anything runs; a new SAS is asked for', async () => {
  const dir = fabricatedRuns(RUNS);
  const calls = [];
  const prompts = fakePrompts([pick('retry'), ...typedCredentials.slice(0, 3), OTHER_SAS, pickRun(0), pick('retry'), SAS, pickRun(0), true]);
  assert.equal(await runWizard({ prompts, env: {}, baseOpts: { outputDir: dir }, commands: spyCommands(calls) }), 0);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].opts.targetSasUrl, SAS);
  assert.ok(prompts.shown.some((s) => s.startsWith('error: The SAS URL targets')));
});

test('resume lists only unfinished runs that have an azcopy job', async () => {
  const dir = fabricatedRuns(RUNS);
  const calls = [];
  let options;
  const prompts = fakePrompts([pick('resume'), ...typedCredentials, (o) => ((options = o.options), o.options[0].value), true]);
  assert.equal(await runWizard({ prompts, env: {}, baseOpts: { outputDir: dir }, commands: spyCommands(calls) }), 0);
  assert.equal(options.length, 2, 'the interrupted delta and the partial full run');
  assert.match(options[0].label, /delta interrupted/);
  assert.equal(calls[0].name, 'resume');
  assert.equal(calls[0].opts.run, path.join(dir, '20261019T025000Z-delta'));
  assert.equal(calls[0].opts.overwriteModified, undefined);
});

test('no run to retry or resume: says so and returns to the menu', async () => {
  const dir = fabricatedRuns([{ name: '20261019T024800Z-full', startedAt: '2026-10-19T02:48:00.000Z', outcome: 'success', jobId: 'job-b' }]);
  const calls = [];
  const prompts = fakePrompts([pick('retry'), pick('resume'), pick('quit')]);
  assert.equal(await runWizard({ prompts, env: {}, baseOpts: { outputDir: dir }, commands: spyCommands(calls) }), 0);
  assert.deepEqual(calls, []);
  assert.equal(prompts.shown.filter((s) => s.startsWith('warn: No earlier run')).length, 2);
  assert.equal(prompts.asked.filter((a) => a.kind === 'password').length, 0, 'credentials are not asked for nothing');
});

test('a usage error from the command is shown without secrets and gives exit code 64', async () => {
  const commands = spyCommands([]);
  commands.copyCommand = async () => {
    throw new realCommands.UsageError(`bad thing with ${SECRET}`);
  };
  const prompts = fakePrompts([pick('copy'), ...typedCredentials, ...sourceAnswers, true]);
  assert.equal(await runWizard({ prompts, env: {}, commands }), 64);
  assert.ok(prompts.shown.some((s) => s === 'error: bad thing with ***'));
});

test('long values are ellipsised to the terminal width', async () => {
  const calls = [];
  const longPrefix = 'a-very-long-prefix/'.repeat(8);
  const prompts = fakePrompts([pick('copy'), ...typedCredentials, 'bkt', longPrefix, '', false, true]);
  await runWizard({ prompts, env: {}, columns: 50, commands: spyCommands(calls) });
  const summary = prompts.shown.find((s) => s.startsWith('note Summary'));
  for (const line of summary.split('\n').slice(1)) assert.ok(line.length <= 50 - 6, `"${line}" is too wide`);
  assert.ok(summary.includes('…'));
});

test('coalescedOutput sends the writes of one redraw as one synchronized write', async () => {
  const { coalescedOutput } = await import('../src/ui/output.js');
  const written = [];
  const stream = { columns: 77, isTTY: true, write: (c) => written.push(c), on() { return 'on'; } };
  const out = coalescedOutput(stream);

  out.write('\x1b[1A');
  out.write('\x1b[J');
  out.write('frame', () => {});
  assert.equal(written.length, 0, 'nothing is written before the tick ends');
  await Promise.resolve();
  assert.deepEqual(written, ['\x1b[?2026h\x1b[1A\x1b[Jframe\x1b[?2026l']);

  out.write('next'); // a later redraw is a separate write
  await Promise.resolve();
  assert.equal(written.length, 2);
  assert.equal(out.columns, 77, 'other properties and methods reach the real stream');
  assert.equal(out.on(), 'on');
  assert.equal(coalescedOutput(stream, { synchronized: false }).write('x'), true);
  await Promise.resolve();
  assert.equal(written.at(-1), 'x');
});

test('withCoalescedOutput gives the redrawing prompts the coalescing stream', async () => {
  const { withCoalescedOutput } = await import('../src/ui/output.js');
  const seen = {};
  const prompts = { select: (o) => (seen.select = o), text: (o) => (seen.text = o), log: { warn() {} }, isCancel: () => false };
  const wrapped = withCoalescedOutput(prompts, { write() {} });
  wrapped.select({ message: 'm' });
  wrapped.text({ message: 't', output: 'custom' });
  assert.equal(seen.select.message, 'm');
  assert.ok(seen.select.output, 'select got an output stream');
  assert.equal(seen.text.output, 'custom', 'an explicit output wins');
  assert.equal(wrapped.log, prompts.log);
  assert.equal(wrapped.isCancel, prompts.isCancel);
});

// ------------------------------------------------------------- the live dashboard

const SNAPSHOT = { scanning: false, discovered: 16206, copied: 1204, failed: 2, ignored: 15000, bytesDone: 2.13 * 2 ** 40, bytesTotal: 3.65 * 2 ** 40, percent: 58.3, throughput: 412 * 2 ** 20, etaSeconds: 4320 };
const DASH_STATE = {
  title: 'Copying  bkt → cont',
  snapshot: SNAPSHOT,
  frame: 3,
  elapsedSeconds: 134,
  speeds: [100, 200, 300, 400, 500, 500, 400, 500],
  failures: [{ path: 'data/2024/big file.bin', code: '403' }],
  output: [{ level: 'INFO', text: 'scanning bucket page 12' }, { level: 'STDERR', text: 'connection reset, retrying' }],
  errorCodes: [['403', 2]],
  logFile: 'runs\\x\\copy.log',
};
const REPORT = {
  outcome: 'partial', jobStatus: 'CompletedWithErrors', jobId: 'job-1', lastError: null, discovered: 16206, copied: 1204, failed: 2, ignored: 15000,
  bytesCopied: 2.13 * 2 ** 40, bytesExpected: 3.65 * 2 ** 40, elapsedSeconds: 9660, files: { log: 'runs\\x\\copy.log', failed: 'runs\\x\\failed.jsonl' },
};
const plain = (lines) => lines.join('\n');

test('renderDashboard: wide layout shows bar, speed, ETA, counters, failures, azcopy output and log', () => {
  const lines = renderDashboard(DASH_STATE, { columns: 120 });
  const text = plain(lines);
  for (const part of ['58.3%', '2.13 TiB / 3.65 TiB', 'elapsed 2m 14s', 'ETA 1h 12m', 'copied 1,204', 'ignored 15,000', 'failed 2', 'found 16,206', '✖ 403  data/2024/big file.bin', 'azcopy output', 'scanning bucket page 12', 'stderr connection reset, retrying', 'log  runs\\x\\copy.log', '▂']) {
    assert.ok(text.includes(part), `missing "${part}" in\n${text}`);
  }
  assert.ok(!text.includes('\x1b'), 'no colour codes with color: false');
  assert.ok(lines.every((l) => l.length <= 119));
});

test('renderDashboard: no line is wider than the terminal at any width', () => {
  for (const columns of [120, 80, 60, 59, 40, 36, 35, 20]) {
    for (const state of [DASH_STATE, { ...DASH_STATE, snapshot: { ...SNAPSHOT, scanning: true } }, { ...DASH_STATE, snapshot: null }, { report: REPORT }]) {
      for (const color of [false, true]) {
        for (const l of renderDashboard(state, { columns, color })) {
          assert.ok(visible(l).length <= columns - 1, `${columns} columns: "${visible(l)}" is too wide`);
        }
      }
    }
  }
});

test('renderDashboard: narrow and very narrow layouts drop the extras', () => {
  const narrow = renderDashboard(DASH_STATE, { columns: 50 });
  assert.equal(narrow.length, 4);
  const text = plain(narrow);
  assert.ok(text.includes('58.3%') && text.includes('ETA 1h 12m') && text.includes('✔ 1,204') && text.includes('✖ 2'));
  assert.ok(!text.includes('▂') && !text.includes('403') && !text.includes('azcopy output') && !text.includes('copy.log'));
  assert.deepEqual(renderDashboard(DASH_STATE, { columns: 30 }), ['58.3% 412.00MiB/s 1h12m']);
});

test('renderDashboard: while scanning the bar is animated and there is no ETA', () => {
  const scanning = { ...DASH_STATE, snapshot: { ...SNAPSHOT, scanning: true, etaSeconds: NaN } };
  const a = plain(renderDashboard(scanning, { columns: 120 }));
  assert.ok(a.includes('Scanning source, totals still growing') && !a.includes('ETA') && !a.includes('58.3%'));
  const b = plain(renderDashboard({ ...scanning, frame: 7 }, { columns: 120 }));
  assert.notEqual(a, b, 'the block moves from frame to frame');
  assert.ok(!plain(renderDashboard(scanning, { columns: 50 })).includes('ETA'));
  assert.ok(!plain(renderDashboard(scanning, { columns: 30 })).includes('ETA'));
});

test('renderDashboard: colour and symbols follow the options', () => {
  const coloured = plain(renderDashboard(DASH_STATE, { columns: 120, color: true }));
  assert.ok(coloured.includes('\x1b[32m') && coloured.includes('\x1b[31m'), 'green copied, red failed');
  const ascii = plain(renderDashboard(DASH_STATE, { columns: 120, unicode: false }));
  assert.ok(ascii.includes('* copied') && ascii.includes('x failed') && ascii.includes('- ignored') && !/[✔✖↷█░│]/.test(ascii));
  const clean = plain(renderDashboard({ ...DASH_STATE, snapshot: { ...SNAPSHOT, failed: 0 }, failures: [] }, { columns: 120, color: true }));
  assert.ok(!clean.includes('\x1b[31m'), 'no red when nothing failed');
});

test('renderDashboard: the result panel per outcome', () => {
  const partial = plain(renderDashboard({ report: REPORT, errorCodes: [['403', 2]] }, { columns: 100 }));
  for (const part of ['Completed with failed files', 'copied 1,204 · ignored 15,000 · failed 2', 'data 2.13 TiB in 2h 41m (average', 'errors       403 (2)', 'failed list  runs\\x\\failed.jsonl', 'choose "Retry failed files" in the menu', 'runs\\x\\copy.log']) {
    assert.ok(partial.includes(part), `missing "${part}" in\n${partial}`);
  }
  assert.ok(plain(renderDashboard({ report: REPORT }, { columns: 100, color: true })).includes('\x1b[33m'), 'yellow for failures');
  const ok = { ...REPORT, outcome: 'success', jobStatus: 'Completed', failed: 0, files: { log: 'l', failed: null } };
  assert.ok(plain(renderDashboard({ report: ok }, { columns: 100, color: true })).includes('\x1b[32m'));
  assert.ok(!plain(renderDashboard({ report: ok }, { columns: 100 })).includes('Retry'));
  const failed = plain(renderDashboard({ report: { ...ok, outcome: 'failed', jobStatus: 'Failed', lastError: 'boom' } }, { columns: 100, color: true }));
  assert.ok(failed.includes('\x1b[31m') && failed.includes('boom') && failed.includes('Resume a run'));
  assert.ok(plain(renderDashboard({ report: { ...ok, outcome: 'interrupted', jobStatus: 'Interrupted' } }, { columns: 100 })).includes('Interrupted'));
  assert.deepEqual(renderDashboard({ report: REPORT }, { columns: 30 }), ['1,204 ok · 2 failed']);
});

test('style: NO_COLOR, FORCE_COLOR and the TTY decide the colour; unicode follows the terminal', () => {
  assert.equal(colorEnabled({ isTTY: true }, {}), true);
  assert.equal(colorEnabled({ isTTY: false }, {}), false);
  assert.equal(colorEnabled({ isTTY: true }, { NO_COLOR: '1' }), false);
  assert.equal(colorEnabled({ isTTY: false }, { FORCE_COLOR: '1' }), true);
  assert.equal(colorEnabled({ isTTY: true }, { FORCE_COLOR: '0' }), false);
  assert.equal(colorEnabled({ isTTY: true }, { NO_COLOR: '1', FORCE_COLOR: '1' }), false);
  assert.equal(createStyle(false).green('x'), 'x');
  assert.equal(createStyle(true).green('x'), '\x1b[32mx\x1b[39m');
  assert.equal(unicodeSupported({ WT_SESSION: 'x' }, 'win32'), true);
  assert.equal(unicodeSupported({}, 'win32'), false);
  assert.equal(unicodeSupported({ TERM: 'xterm' }, 'linux'), true);
  assert.equal(unicodeSupported({ TERM: 'linux' }, 'linux'), false);
});

/** A terminal stand-in that records each write. */
function fakeTerminal(columns = 100) {
  const writes = [];
  const listeners = {};
  return {
    isTTY: true,
    columns,
    writes,
    listeners,
    write: (chunk) => { writes.push(String(chunk)); return true; },
    on: (event, fn) => { (listeners[event] ??= []).push(fn); },
    off: (event, fn) => { listeners[event] = (listeners[event] ?? []).filter((f) => f !== fn); },
  };
}
const flush = () => new Promise((resolve) => setImmediate(resolve));
const SYNC = '\x1b[?2026h';
const unsync = (write) => write.replace(SYNC, '').replace('\x1b[?2026l', '');

test('Dashboard: every update is one write that replaces the block drawn before', async () => {
  const term = fakeTerminal();
  const dash = new Dashboard({ out: term, color: false, unicode: true, tickMs: 1e6 });
  dash.start({ logFile: 'l.log' });
  await flush();
  assert.equal(term.writes.length, 1);
  const first = unsync(term.writes[0]);
  assert.ok(first.startsWith('\x1b[?25l'), 'cursor hidden before the first frame');
  const height = first.split('\n').length - 1;

  dash.progress(SNAPSHOT);
  dash.progress({ ...SNAPSHOT, percent: 60 });
  await flush();
  assert.equal(term.writes.length, 2, 'two updates in one tick are one write');
  const second = unsync(term.writes[1]);
  assert.ok(second.startsWith(`\x1b[${height}A\x1b[J`), 'moves up over the previous block and erases it');
  assert.ok(second.includes('60.0%'));
  dash.close();
});

test('Dashboard: message() prints above the block, finish leaves the result panel and shows the cursor', async () => {
  const term = fakeTerminal();
  const dash = new Dashboard({ out: term, color: false, unicode: true, tickMs: 1e6 });
  dash.start({ logFile: 'l.log' });
  await flush();
  dash.progress(SNAPSHOT);
  await flush();
  const height = unsync(term.writes.at(-1)).split('\n').length - 1;

  dash.message('WARN', 'azcopy: slow down');
  await flush();
  const msg = unsync(term.writes.at(-1));
  assert.ok(msg.startsWith(`\x1b[${height}A\x1b[J`));
  assert.ok(msg.indexOf('azcopy: slow down') < msg.indexOf('58.3%'), 'the message is above the dashboard');

  dash.failure('a/b.txt');
  dash.summary(REPORT, {});
  await flush();
  const end = unsync(term.writes.at(-1));
  assert.ok(end.startsWith(`\x1b[${height}A\x1b[J`));
  assert.ok(end.includes('Completed with failed files'));
  assert.ok(end.endsWith('\x1b[?25h'), 'the cursor is shown again');
  const count = term.writes.length;
  dash.close();
  dash.summary(REPORT, {});
  await flush();
  assert.equal(term.writes.length, count, 'nothing more is drawn after the end');
});

test('Dashboard: the timer animates the clock, resize redraws, and close() clears both', async () => {
  const term = fakeTerminal(100);
  let now = 0;
  const dash = new Dashboard({ out: term, color: false, unicode: true, tickMs: 5, now: () => now });
  dash.start({ logFile: 'l.log' });
  await flush();
  now = 61_000;
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.ok(term.writes.length > 1, 'the timer redraws');
  assert.ok(unsync(term.writes.at(-1)).includes('elapsed 1m 1s'));

  assert.equal(term.listeners.resize.length, 1);
  term.columns = 50;
  term.listeners.resize[0]();
  await flush();
  const narrow = unsync(term.writes.at(-1));
  assert.ok(!narrow.includes('elapsed'), 'redrawn with the narrow layout');
  assert.match(narrow, /^\x1b\[\d+A\x1b\[J/);

  dash.close();
  assert.equal(term.listeners.resize.length, 0, 'resize listener removed');
  await flush();
  const count = term.writes.length;
  assert.ok(term.writes.at(-1).includes('\x1b[?25h'), 'the cursor is shown');
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(term.writes.length, count, 'the timer stopped');
});

test('wizard: a copy on a terminal gets the dashboard as its view, without one it gets none', async () => {
  const calls = [];
  const run = async (out) => {
    const prompts = fakePrompts(['copy', ...typedCredentials, ...sourceAnswers, true]);
    await runWizard({ prompts, env: {}, out, baseOpts: {}, commands: spyCommands(calls) });
  };
  await run(fakeTerminal());
  await run(sink());
  assert.ok(calls[0].opts.view instanceof Dashboard);
  assert.equal(calls[0].opts.view.title.split('  ')[0], 'Copying');
  assert.ok(calls[0].opts.view.title.includes('bkt') && calls[0].opts.view.title.includes('cont'));
  assert.equal(calls[1].opts.view, undefined);
});
test('renderDashboard: failures keep their error code, and the azcopy output pane follows the terminal height', () => {
  const failures = ['a', 'b', 'c', 'd'].map((n, i) => ({ path: `dir/${n}.bin`, code: String(400 + i) }));
  const output = Array.from({ length: 30 }, (_, i) => ({ level: 'INFO', text: `message ${i}` }));
  const state = { ...DASH_STATE, failures, output };
  const text = plain(renderDashboard(state, { columns: 100 }));
  assert.ok(!text.includes('dir/a.bin') && text.includes('✖ 403  dir/d.bin') && text.includes('✖ 401  dir/b.bin'), 'the last three failures');
  const long = renderDashboard({ ...state, failures: [{ path: 'x/'.repeat(60) + 'file.bin', code: '503' }] }, { columns: 60 });
  assert.ok(long.some((l) => l.includes('✖ 503  ')), 'the code survives shortening');

  const outputLines = (rows) => renderDashboard(state, { columns: 100, rows }).filter((l) => /message \d+/.test(l));
  assert.equal(outputLines(20).length, 20 - 1 - renderDashboard({ ...state, output: [] }, { columns: 100 }).length - 1, 'fills the free rows');
  assert.ok(outputLines(60).length === 10, 'at most 10 lines');
  assert.ok(plain(renderDashboard(state, { columns: 100, rows: 60 })).includes('message 29'), 'the newest lines are shown');
  assert.ok(!plain(renderDashboard(state, { columns: 100, rows: 60 })).includes('message 19'));
  for (const rows of [10, 14, 20, 24, 40]) {
    const lines = renderDashboard(state, { columns: 100, rows });
    const base = renderDashboard({ ...state, output: [] }, { columns: 100 }).length;
    assert.ok(lines.length <= Math.max(rows - 1, base), `${rows} rows: ${lines.length} lines`);
  }
  assert.equal(outputLines(undefined).length, 3, 'three lines when the height is unknown');
  assert.ok(!plain(renderDashboard({ ...state, output: [] }, { columns: 100 })).includes('azcopy output'), 'no pane without output');
});

test('renderDashboard: the result panel lists the most frequent error codes', () => {
  const codes = [['403', 5], ['404', 3], ['500', 2], ['503', 1]];
  const text = plain(renderDashboard({ report: REPORT, errorCodes: codes }, { columns: 100 }));
  assert.ok(text.includes('errors') && text.includes('403 (5) · 404 (3) · 500 (2) · +1 more'), text);
  assert.ok(!plain(renderDashboard({ report: { ...REPORT, failed: 0, files: { log: 'l', failed: null } }, errorCodes: [] }, { columns: 100 })).includes('errors'));
});

test('Dashboard: failures and azcopy output are recorded, shown on the next redraw and sanitised', async () => {
  const term = fakeTerminal();
  term.rows = 40;
  const dash = new Dashboard({ out: term, color: false, unicode: true, tickMs: 1e6 });
  dash.start({ logFile: 'l.log' });
  await flush();
  const before = term.writes.length;
  dash.failure('a/b.txt', '403');
  dash.failure('c.txt', '403');
  dash.failure('d.txt');
  dash.log('INFO', 'hello\x1b[31m red\x1b[0m\r\nworld');
  dash.log('STDERR', '   ');
  await flush();
  assert.equal(term.writes.length, before, 'recording alone draws nothing');
  dash.progress(SNAPSHOT);
  await flush();
  const frame = unsync(term.writes.at(-1));
  assert.ok(frame.includes('✖ 403  a/b.txt') && frame.includes('✖ unknown  d.txt'));
  assert.ok(frame.includes('hello red world') && !frame.includes('\x1b[31m'));
  assert.ok(!frame.includes('stderr'), 'blank lines are dropped');
  dash.summary({ ...REPORT }, {});
  await flush();
  assert.ok(unsync(term.writes.at(-1)).includes('errors       403 (2) · unknown (1)'));
});
// ------------------------------------------------------------- chunked migrations in the wizard

const migrateAnswers = (over = {}) => [pick('azcopy'), over.chunkFiles ?? '2000', over.chunkBytes ?? '500GiB', over.parallel ?? '4', pick(over.ends ?? 'stop'), true]; // inventory, objects, size, jobs, when it ends, confirm

test('wizard: large migration asks for the chunk limits and runs migrate with typed secrets, nothing leaked', async () => {
  const env = {};
  const calls = [];
  const commands = spyCommands(calls);
  commands.migrateCommand = async (opts) => {
    calls.push({ name: 'migrate', opts: { ...opts }, awsKey: env.AWS_ACCESS_KEY_ID });
    return 0;
  };
  const prompts = fakePrompts([pick('migrate'), ...typedCredentials, ...sourceAnswers, ...migrateAnswers()]);
  assert.equal(await runWizard({ prompts, env, baseOpts: { outputDir: 'unused' }, commands }), 0);
  assert.equal(prompts.remaining(), 0);
  const { opts, awsKey } = calls[0];
  assert.equal(awsKey, KEY, 'the typed key is in the environment while it runs');
  assert.deepEqual(
    [opts.sourceBucket, opts.sourcePrefix, opts.sourceRegion, opts.targetSasUrl, opts.overwriteModified, opts.inventorySource, opts.chunkFiles, opts.chunkBytes, opts.parallel],
    ['bkt', 'data', 'ap-southeast-2', SAS, false, 'azcopy', '2000', '500GiB', '4'],
  );
  assert.equal(opts.view, undefined, 'no dashboard without a terminal');
  assert.deepEqual(env, {});
  const defaults = ['Most objects in a chunk', 'Most data in a chunk', 'azcopy jobs at once'].map((m) => prompts.asked.find((a) => a.message.startsWith(m)).initialValue);
  assert.deepEqual(defaults, ['1000000', '1TiB', '10']);
  const summary = prompts.shown.find((s) => s.startsWith('note Summary'));
  assert.match(summary, /Inventory +azcopy dry run/);
  assert.match(summary, /Chunks +at most 2000 objects or 500GiB each/);
  assert.match(summary, /Copy +4 azcopy jobs at once/);
  for (const secret of SECRET_TEXTS) assert.ok(!prompts.shown.join('\n').includes(secret));
});

test('wizard: the chunk prompts validate their answers; the S3 inventory can be chosen', async () => {
  const calls = [];
  const prompts = fakePrompts([pick('migrate'), ...typedCredentials, ...sourceAnswers, pick('s3'), '10', '2TiB', '3', pick('stop'), false, pick('quit')]);
  assert.equal(await runWizard({ prompts, env: {}, commands: spyCommands(calls) }), 0);
  assert.deepEqual(calls, [], 'declining runs nothing');
  const byMessage = (m) => prompts.asked.find((a) => a.message.includes(m));
  assert.match(byMessage('Most objects').validate('0'), /whole number/);
  assert.match(byMessage('Most objects').validate('many'), /whole number/);
  assert.equal(byMessage('Most objects').validate('500000'), undefined);
  assert.match(byMessage('Most data').validate('lots'), /Invalid the chunk size/);
  assert.equal(byMessage('Most data').validate('750 GiB'), undefined);
  assert.match(byMessage('jobs at once').validate('-1'), /whole number/);
  assert.deepEqual(byMessage('How is the source listed').options.map((o) => o.value), ['azcopy', 's3']);
});

/** Fabricated migration folders. */
function fabricatedMigrations(list) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'azc-ui-mig-'));
  for (const x of list) {
    fs.mkdirSync(path.join(dir, x.name));
    if (x.manifest === false) continue;
    fs.writeFileSync(path.join(dir, x.name, 'migration.json'), JSON.stringify({
      kind: 'migration', startedAt: x.startedAt, outcome: x.outcome, bucket: x.bucket ?? 'bkt', prefix: x.prefix ?? '', region: x.region ?? '',
      overwriteModified: Boolean(x.overwriteModified), includeAfter: x.includeAfter ?? null,
      sourceBase: 'https://s3.amazonaws.com/bkt', targetBase: x.targetBase ?? 'https://acct.blob.core.windows.net/cont',
      inventory: { status: x.inventory ?? 'done' }, chunking: { status: x.chunking ?? 'done' },
      chunks: (x.chunks ?? []).map((status, i) => ({ id: i + 1, status, bytes: 1 })),
    }));
  }
  return dir;
}

const MIGRATIONS = [
  { name: '20261101T010000Z-migration', startedAt: '2026-11-01T01:00:00.000Z', outcome: 'success', chunks: ['success', 'success'] },
  { name: '20261105T020000Z-migration', startedAt: '2026-11-05T02:00:00.000Z', outcome: 'interrupted', prefix: 'data', chunks: ['success', 'exhausted', 'pending', 'interrupted'] },
  { name: '20261106T030000Z-migration', startedAt: '2026-11-06T03:00:00.000Z', outcome: 'stopped', inventory: 'done', chunking: 'pending' },
  { name: '20261107T040000Z-migration', manifest: false },
];

test('wizard: continue a migration lists the unfinished ones, newest first, and passes the chosen folder', async () => {
  const dir = fabricatedMigrations(MIGRATIONS);
  const calls = [];
  let options;
  const prompts = fakePrompts([pick('continue'), ...typedCredentials, (o) => ((options = o.options), o.options[1].value), true]);
  assert.equal(await runWizard({ prompts, env: {}, baseOpts: { outputDir: dir }, commands: spyCommands(calls) }), 0);
  assert.equal(options.length, 2, 'the finished migration and the folder without migration.json are not offered');
  assert.match(options[0].label, /^2026-11-06 03:00 {2}full {3}chunking {2}0\/0 chunks · stopped/);
  assert.match(options[1].label, /^2026-11-05 02:00 {2}full {3}copying {3}2\/4 chunks · interrupted +bkt\/data/);
  assert.equal(calls[0].name, 'migrate');
  assert.equal(calls[0].opts.migration, path.join(dir, '20261105T020000Z-migration'));
  assert.equal(calls[0].opts.targetSasUrl, SAS);
  assert.equal(calls[0].opts.sourceBucket, undefined);
  assert.match(prompts.shown.find((s) => s.startsWith('note Summary')), /State +copying, 2\/4 chunks done, interrupted/);
});

test('wizard: continue refuses a SAS for another target and asks for a new one; says so when nothing is unfinished', async () => {
  const dir = fabricatedMigrations(MIGRATIONS);
  const calls = [];
  const prompts = fakePrompts([pick('continue'), ...typedCredentials.slice(0, 3), OTHER_SAS, pickRun(0), pick('continue'), SAS, pickRun(0), true]);
  assert.equal(await runWizard({ prompts, env: {}, baseOpts: { outputDir: dir }, commands: spyCommands(calls) }), 0);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].opts.targetSasUrl, SAS);
  assert.ok(prompts.shown.some((s) => s.startsWith('error: The SAS URL targets')));

  const done = fabricatedMigrations([MIGRATIONS[0]]);
  const none = fakePrompts([pick('continue'), pick('quit')]);
  assert.equal(await runWizard({ prompts: none, env: {}, baseOpts: { outputDir: done }, commands: spyCommands([]) }), 0);
  assert.ok(none.shown.some((s) => s.startsWith('warn: No unfinished migration')));
  assert.equal(none.asked.filter((a) => a.kind === 'password').length, 0);
});

test('wizard: Ctrl+C at every step of the migration flow ends with 130 and runs nothing', async () => {
  const script = [pick('migrate'), ...typedCredentials, ...sourceAnswers, ...migrateAnswers()];
  for (let i = 0; i < script.length; i++) {
    const calls = [];
    const env = {};
    const prompts = fakePrompts([...script.slice(0, i), CANCEL]);
    assert.equal(await runWizard({ prompts, env, commands: spyCommands(calls) }), 130, `cancel at step ${i}`);
    assert.deepEqual(calls, []);
    assert.deepEqual(env, {});
  }
});

test('wizard: a migration on a terminal gets the migration dashboard as its view', async () => {
  const calls = [];
  const run = async (out, answers) => runWizard({ prompts: fakePrompts(answers), env: {}, out, baseOpts: {}, commands: spyCommands(calls) });
  await run(fakeTerminal(), [pick('migrate'), ...typedCredentials, ...sourceAnswers, ...migrateAnswers()]);
  await run(sink(), [pick('migrate'), ...typedCredentials, ...sourceAnswers, ...migrateAnswers()]);
  assert.equal(calls[0].opts.view, undefined, 'a view per round instead of one');
  const view = calls[0].opts.makeView({ delta: false, round: 0 });
  assert.ok(view instanceof MigrationDashboard);
  assert.ok(view.title.startsWith('Migrating') && view.title.includes('bkt') && view.title.includes('cont') && !view.title.includes('round'));
  const deltaView = calls[0].opts.makeView({ delta: true, round: 2 });
  assert.match(deltaView.title, /^Delta migration {2}bkt \S+ cont · round 2$/);
  assert.equal(calls[1].opts.makeView, undefined);
});

// ------------------------------------------------------------- the migration dashboard

const AGGREGATE = {
  chunksTotal: 190, chunksDone: 42, chunksRunning: 4, chunksPending: 144, chunksExhausted: 1,
  running: [{ id: 13, percent: 71 }, { id: 14, percent: 18 }, { id: 15, percent: 52 }, { id: 16, percent: 2 }],
  copied: 3012554, ignored: 0, failed: 3, bytesDone: 44.1 * 2 ** 40, bytesTotal: 184.2 * 2 ** 40, percent: 23.9, throughput: 1.62 * 2 ** 30, etaSeconds: 90720, elapsedSeconds: 600,
};
const MIG_STATE = {
  title: 'Migrating  my-bucket → files3', phase: 'copying', frame: 2, elapsedSeconds: 134, snapshot: AGGREGATE, parallel: 10,
  speeds: [1, 2, 3, 4, 5, 6, 5, 6], failures: [{ id: 9, path: 'data/2024/big file.bin', code: '403' }], logFile: 'runs\\m\\migration.log', output: [],
};
const MIG_RESULT = {
  outcome: 'partial', dir: 'runs\\m', maxAttempts: 5, chunksTotal: 190, chunksSuccess: 188, chunksExhausted: 2, chunksOpen: 0, copied: 12480000, ignored: 5, failed: 113,
  bytesCopied: 184 * 2 ** 40, elapsedSeconds: 90000, skipped: 2, skippedFile: 'runs\\m\\chunks\\skipped.jsonl', files: { log: 'runs\\m\\migration.log', migration: 'runs\\m\\migration.json' },
};

test('renderMigrationDashboard: the copy phase shows the bar, ETA, chunk counters, running chunks, failures and log', () => {
  const text = plain(renderMigrationDashboard(MIG_STATE, { columns: 120 }));
  for (const part of [
    'Migrating  my-bucket → files3', '23.9%', '44.10 TiB / 184.20 TiB', 'speed 1.62 GiB/s', 'ETA 1d 1h 12m', 'elapsed 2m 14s',
    'chunks ✔ 42  ▶ 4  144 pending  ✖ 1', 'copied 3,012,554', '✖ failed 3',
    '▶ 00013', '71%', '▶ 00016', '✖ 403  data/2024/big file.bin   (chunk 00009)', 'log  runs\\m\\migration.log', '▂',
  ]) assert.ok(text.includes(part), `missing "${part}" in\n${text}`);
  assert.ok(!text.includes('\x1b'));
  const many = { ...AGGREGATE, chunksRunning: 40, running: Array.from({ length: 40 }, (_, i) => ({ id: i + 1, percent: i })) };
  const crowded = plain(renderMigrationDashboard({ ...MIG_STATE, snapshot: many }, { columns: 120 }));
  assert.match(crowded, /\+\d+ more running/);
  assert.ok(renderMigrationDashboard({ ...MIG_STATE, snapshot: many }, { columns: 120 }).length < 20);
});

test('renderMigrationDashboard: the inventory and analysis phases', () => {
  const inventory = { title: 'Migrating', phase: 'inventory', provider: 'azcopy dry-run', frame: 0, elapsedSeconds: 5, inventory: { files: 1234567, bytes: 3 * 2 ** 40 } };
  const text = plain(renderMigrationDashboard(inventory, { columns: 100 }));
  assert.ok(text.includes('Inventory (azcopy dry-run)') && text.includes('1,234,567 objects · 3.00 TiB so far'), text);
  assert.notEqual(text, plain(renderMigrationDashboard({ ...inventory, frame: 4 }, { columns: 100 })), 'the bar moves');

  const analysis = { ...inventory, phase: 'analysis', analysis: ['12 objects, 1 KiB', 'WARNING: 2 archived object(s) cannot be copied'], chunkCount: undefined };
  const a = plain(renderMigrationDashboard(analysis, { columns: 100 }));
  assert.ok(a.includes('12 objects, 1 KiB') && a.includes('WARNING: 2 archived') && a.includes('cutting the inventory into chunks'));
  assert.ok(plain(renderMigrationDashboard({ ...analysis, chunkCount: 190 }, { columns: 100 })).includes('190 chunks, starting the copy'));
  assert.ok(plain(renderMigrationDashboard({ ...MIG_STATE, snapshot: null }, { columns: 100 })).includes('Migrating'), 'copy phase before the first progress');
});

test('renderMigrationDashboard: no line is wider than the terminal at any width, in any phase', () => {
  const states = [
    MIG_STATE,
    { ...MIG_STATE, snapshot: null },
    { ...MIG_STATE, phase: 'inventory', inventory: { files: 12, bytes: 99 } },
    { ...MIG_STATE, phase: 'analysis', analysis: ['x'.repeat(200)] },
    { result: MIG_RESULT },
  ];
  for (const columns of [120, 80, 60, 59, 40, 36, 35, 20]) {
    for (const state of states) {
      for (const color of [false, true]) {
        for (const unicode of [true, false]) {
          const lines = renderMigrationDashboard(state, { columns, color, unicode });
          assert.ok(lines.length > 0);
          for (const l of lines) assert.ok(visible(l).length <= columns - 1, `${columns} columns: "${visible(l)}" is too wide`);
        }
      }
    }
  }
  assert.deepEqual(renderMigrationDashboard(MIG_STATE, { columns: 30 }), ['23.9% 1.62GiB/s 1d1h']);
  assert.equal(renderMigrationDashboard(MIG_STATE, { columns: 50 }).length, 4);
  assert.ok(plain(renderMigrationDashboard(MIG_STATE, { columns: 50 })).includes('✔ 42/190'));
  const ascii = plain(renderMigrationDashboard(MIG_STATE, { columns: 120, unicode: false }));
  assert.ok(ascii.includes('> 00013') && !/[✔✖▶█░│]/.test(ascii));
});

test('renderMigrationDashboard: the result panel per outcome', () => {
  const partial = plain(renderMigrationDashboard({ result: MIG_RESULT, errorCodes: [['403', 113]] }, { columns: 110 }));
  for (const part of [
    'Migration completed with failed files', 'chunks 188/190 copied · 2 with failed files · 0 not finished', 'copied 12,480,000 · ignored 5 · failed 113',
    'not copied   2 key(s) with a line break', 'errors       403 (113)', 'choose "Continue a migration" in the menu', 'folder       runs\\m', 'migration.log',
  ]) assert.ok(partial.includes(part), `missing "${part}" in\n${partial}`);
  const ok = { ...MIG_RESULT, outcome: 'success', chunksSuccess: 190, chunksExhausted: 0, failed: 0, skipped: 0 };
  const okText = plain(renderMigrationDashboard({ result: ok }, { columns: 110, color: true }));
  assert.ok(okText.includes('Migration completed') && okText.includes('\x1b[32m') && !okText.includes('Continue a migration'));
  assert.ok(plain(renderMigrationDashboard({ result: { ...MIG_RESULT, outcome: 'failed' } }, { columns: 110, color: true })).includes('\x1b[31m'));
  assert.ok(plain(renderMigrationDashboard({ result: { ...MIG_RESULT, outcome: 'interrupted', chunksOpen: 5 } }, { columns: 110 })).includes('Migration interrupted'));
  assert.deepEqual(renderMigrationDashboard({ result: MIG_RESULT }, { columns: 30 }), ['188/190 chunks · 113 failed']);
});

test('MigrationDashboard: a whole migrate run on a terminal is drawn in place and ends with the result panel; nothing leaks', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'azc-ui-mig-e2e-'));
  const argsFile = path.join(dir, 'args.jsonl');
  const saved = {};
  for (const k of ['FAKE_ARGS_FILE', 'FAKE_DRYRUN_COUNT', 'FAKE_DELAY_MS', 'FAKE_FAIL_LIST', 'FAKE_EVENTS_FILE', 'FAKE_NO_TRANSFERS', 'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY']) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  Object.assign(process.env, { FAKE_ARGS_FILE: argsFile, FAKE_DRYRUN_COUNT: '6', FAKE_DELAY_MS: '300', AWS_ACCESS_KEY_ID: KEY, AWS_SECRET_ACCESS_KEY: SECRET });
  try {
    const term = fakeTerminal(100);
    term.rows = 40;
    const view = new MigrationDashboard({ out: term, color: true, unicode: true });
    const code = await realMigration.migrateCommand({
      azcopyCommand: { bin: process.execPath, prefixArgs: [fileURLToPath(new URL('fixtures/fake-azcopy.js', import.meta.url))] },
      outputDir: dir, targetSasUrl: SAS, sourceBucket: 'bkt', sourcePrefix: 'data', chunkFiles: 2, parallel: 2, view,
    }, term);
    assert.equal(code, 0);
    const screen = term.writes.join('').replaceAll('\x1b[?2026h', '').replaceAll('\x1b[?2026l', '');
    assert.ok(screen.includes('Inventory (azcopy dry-run)'), 'the inventory phase was drawn');
    assert.ok(visible(screen).includes('▶ 00001'), 'the running chunks were drawn');
    assert.ok(screen.includes('Migration completed') && screen.includes('chunks 3/3 copied'), 'the result panel');
    assert.ok(!screen.includes('Migration summary') && !screen.includes('Migration: '), 'no plain output with a view');
    assert.ok(screen.trimEnd().endsWith('\x1b[?25h'), 'cursor shown at the end');
    for (const secret of SECRET_TEXTS) assert.ok(!screen.includes(secret), `${secret} on screen`);
    assert.equal(term.listeners.resize?.length ?? 0, 0, 'resize listener removed');
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
});

// ---- options given on the command line

const cliSelect = (value) => (o) => o.options.find((x) => x.value === value)?.value ?? assert.fail(`no option ${value}`);

test('command line options: migrate takes them over without asking again', async () => {
  const env = { AWS_ACCESS_KEY_ID: KEY, AWS_SECRET_ACCESS_KEY: SECRET };
  const calls = [];
  const presets = { sourceBucket: 'bkt', sourceRegion: 'ap-southeast-2', chunkFiles: '2000', chunkBytes: '500GiB', parallel: '4', maxAttempts: '3', inventorySource: 's3', targetSasUrl: SAS };
  const prompts = fakePrompts([pick('migrate'), cliSelect('use'), pick('env'), false, pick('stop'), true]);
  assert.equal(await runWizard({ prompts, env, presets, commands: spyCommands(calls) }), 0);
  assert.equal(prompts.remaining(), 0);
  assert.deepEqual(prompts.asked.map((a) => a.kind), ['select', 'select', 'select', 'confirm', 'select', 'confirm']);
  const { opts } = calls[0];
  assert.deepEqual(
    [opts.sourceBucket, opts.sourcePrefix, opts.sourceRegion, opts.targetSasUrl, opts.overwriteModified, opts.inventorySource, opts.chunkFiles, opts.chunkBytes, opts.parallel, opts.maxAttempts],
    ['bkt', '', 'ap-southeast-2', SAS, false, 's3', '2000', '500GiB', '4', '3'],
  );
  const shownText = prompts.shown.join('\n');
  assert.match(shownText, /From the command line:[^]*Bucket +bkt[^]*Prefix +\(whole bucket\)[^]*Parallel jobs +4/);
  assert.match(shownText, /SAS: command line/);
  assert.ok(!shownText.includes('SECRETSIG123'));
});

test('command line options: "go through the questions" prefills them; options not given are asked', async () => {
  const calls = [];
  const presets = { sourceBucket: 'bkt', parallel: '4', overwriteModified: true };
  const prompts = fakePrompts([pick('migrate'), cliSelect('review'), ...typedCredentials, (o) => o.initialValue, '', '', true, pick('azcopy'), '2000', '1TiB', (o) => o.initialValue, pick('stop'), true]);
  assert.equal(await runWizard({ prompts, env: {}, presets, commands: spyCommands(calls) }), 0);
  assert.equal(prompts.remaining(), 0);
  const initial = (m) => prompts.asked.find((a) => a.message.includes(m)).initialValue;
  assert.equal(initial('bucket name or ARN'), 'bkt');
  assert.equal(initial('azcopy jobs at once'), '4');
  assert.equal(initial('Replace blobs'), true);
  assert.equal(calls[0].opts.parallel, '4');
  assert.equal(calls[0].opts.chunkFiles, '2000');
});

test('command line options: an unusable one is reported and asked for as usual', async () => {
  const calls = [];
  const prompts = fakePrompts([pick('migrate'), cliSelect('use'), ...typedCredentials, '', 'ap-southeast-2', false, pick('azcopy'), '2000', '1TiB', '4', pick('stop'), true]);
  await runWizard({ prompts, env: {}, presets: { sourceBucket: 'bkt', sourceRegion: 'nowhere', parallel: '0' }, commands: spyCommands(calls) });
  assert.match(prompts.shown.join('\n'), /warn: --source-region from the command line is not usable[^]*warn: --parallel from the command line is not usable/);
  assert.ok(prompts.asked.some((a) => a.message.includes('AWS region')), 'the region is asked for');
  assert.ok(prompts.asked.some((a) => a.message.includes('azcopy jobs at once')), 'the job count is asked for');
  assert.equal(calls[0].opts.parallel, '4');
});

test('command line options: delta copy with a date skips the run list; full copy ignores the date', async () => {
  const dir = fabricatedRuns(RUNS);
  const presets = { sourceBucket: 'bkt', sourcePrefix: 'data', lastCopyDate: '2026-01-31', overwriteModified: true };
  const calls = [];
  const delta = fakePrompts([pick('delta'), cliSelect('use'), ...[KEY, SECRET, '', SAS], true]);
  assert.equal(await runWizard({ prompts: delta, env: {}, presets, baseOpts: { outputDir: dir }, commands: spyCommands(calls) }), 0);
  assert.equal(delta.remaining(), 0);
  assert.deepEqual([calls[0].opts.sourceBucket, calls[0].opts.sourcePrefix, calls[0].opts.sourceRegion, calls[0].opts.lastCopyDate, calls[0].opts.overwriteModified], ['bkt', 'data', undefined, '2026-01-31T00:00:00.000Z', true]);

  const full = fakePrompts([pick('copy'), cliSelect('use'), ...[KEY, SECRET, '', SAS], true]);
  await runWizard({ prompts: full, env: {}, presets, commands: spyCommands(calls) });
  assert.equal(calls[1].name, 'copy');
  assert.equal(calls[1].opts.lastCopyDate, undefined);
  assert.ok(!full.shown.join('\n').includes('Modified since'));
});

test('command line options: continue applies --parallel and --max-attempts', async () => {
  const calls = [];
  const dir = fabricatedMigrations([MIGRATIONS[1]]);
  const prompts = fakePrompts([pick('continue'), KEY, SECRET, '', SAS, pickRun(0), true]);
  await runWizard({ prompts, env: {}, presets: { parallel: '2', maxAttempts: '9' }, baseOpts: { outputDir: dir }, commands: spyCommands(calls) });
  assert.equal(prompts.remaining(), 0);
  assert.deepEqual([calls[0].opts.parallel, calls[0].opts.maxAttempts], ['2', '9']);
  assert.match(prompts.shown.join('\n'), /Changes +--parallel 2 --max-attempts 9/);
});


// ---- delta migrations

const FINISHED = { name: '20261108T050000Z-migration', startedAt: '2026-11-08T05:00:00.000Z', outcome: 'partial', prefix: 'data', region: 'ap-southeast-2', overwriteModified: true, chunks: ['success', 'exhausted'] };
const sameAsInitial = (o) => o.initialValue;

test('wizard: delta migration lists the finished migrations, passes its date and folder, and prefills the source', async () => {
  const dir = fabricatedMigrations([MIGRATIONS[0], MIGRATIONS[1], FINISHED]);
  const calls = [];
  let options;
  const prompts = fakePrompts([pick('delta-migrate'), ...typedCredentials, (o) => ((options = o.options), o.options[0].value), sameAsInitial, sameAsInitial, sameAsInitial, sameAsInitial, ...migrateAnswers()]);
  assert.equal(await runWizard({ prompts, env: {}, baseOpts: { outputDir: dir }, commands: spyCommands(calls), columns: 400 }), 0);
  assert.equal(prompts.remaining(), 0);
  assert.equal(prompts.asked.find((a) => a.kind === 'select' && a.message.startsWith('Delta since which migration')).message, 'Delta since which migration? (times are UTC, newest first)');
  assert.deepEqual(options.map((o) => o.label), [
    '2026-11-08 05:00  full   done      2/2 chunks · partial     bkt/data',
    '2026-11-01 01:00  full   done      2/2 chunks · success     bkt',
    'Enter a date instead',
  ], 'the interrupted migration is not a baseline');
  const { opts } = calls[0];
  assert.equal(calls[0].name, 'migrate');
  assert.equal(opts.lastCopyDate, '2026-11-08T04:50:00.000Z');
  assert.equal(opts.baselineDir, path.join(dir, FINISHED.name));
  assert.deepEqual([opts.sourceBucket, opts.sourcePrefix, opts.sourceRegion, opts.overwriteModified, opts.repeat], ['bkt', 'data', 'ap-southeast-2', true, undefined]);
  const summary = prompts.shown.find((s) => s.startsWith('note Summary'));
  assert.match(summary, /Mode +delta, objects modified on\/after 2026-11-08T04:50:00\.000Z \(start of .*20261108T050000Z-migration, minus 10 min\)/);
  assert.match(summary, /Carried +nothing/);
});

test('wizard: delta migration with no finished migration goes straight to the date', async () => {
  const dir = fabricatedMigrations([MIGRATIONS[1]]);
  const calls = [];
  const prompts = fakePrompts([pick('delta-migrate'), ...typedCredentials, '2026-01-31', ...sourceAnswers, ...migrateAnswers()]);
  assert.equal(await runWizard({ prompts, env: {}, baseOpts: { outputDir: dir }, commands: spyCommands(calls) }), 0);
  assert.equal(prompts.remaining(), 0);
  assert.ok(prompts.asked.some((a) => a.message.startsWith('List objects modified on/after')));
  assert.deepEqual([calls[0].opts.lastCopyDate, calls[0].opts.baselineDir], ['2026-01-31T00:00:00.000Z', undefined]);
  assert.match(prompts.shown.find((s) => s.startsWith('note Summary')), /Mode +delta, objects modified on\/after 2026-01-31T00:00:00\.000Z\n/);
});

test('wizard: delta migration from a migration to another target asks for confirmation', async () => {
  const dir = fabricatedMigrations([{ ...FINISHED, targetBase: 'https://other.blob.core.windows.net/elsewhere' }]);
  const calls = [];
  const declined = fakePrompts([pick('delta-migrate'), ...typedCredentials, pickRun(0), false, pick('quit')]);
  assert.equal(await runWizard({ prompts: declined, env: {}, baseOpts: { outputDir: dir }, commands: spyCommands(calls) }), 0);
  assert.deepEqual(calls, []);
  assert.ok(declined.shown.some((s) => s.startsWith('warn: That migration copied to')));
  const accepted = fakePrompts([pick('delta-migrate'), ...typedCredentials, pickRun(0), true, ...sourceAnswers, ...migrateAnswers()]);
  assert.equal(await runWizard({ prompts: accepted, env: {}, baseOpts: { outputDir: dir }, commands: spyCommands(calls) }), 0);
  assert.equal(calls.length, 1);
});

test('command line options: --last-copy-date auto answers the baseline question of a delta migration', async () => {
  const dir = fabricatedMigrations([FINISHED]);
  const calls = [];
  const prompts = fakePrompts([pick('delta-migrate'), cliSelect('use'), ...typedCredentials, false, ...migrateAnswers()]);
  assert.equal(await runWizard({ prompts, env: {}, presets: { sourceBucket: 'bkt', lastCopyDate: 'auto' }, baseOpts: { outputDir: dir }, commands: spyCommands(calls) }), 0);
  assert.equal(prompts.remaining(), 0);
  assert.ok(!prompts.asked.some((a) => a.message.startsWith('Delta since which migration')));
  assert.deepEqual([calls[0].opts.lastCopyDate, calls[0].opts.baselineDir], ['auto', undefined]);
  assert.match(prompts.shown.find((s) => s.startsWith('note Summary')), /Mode +delta, objects modified since the previous run \(auto\)/);

  // a full migration ignores the date
  const full = fakePrompts([pick('migrate'), cliSelect('use'), ...typedCredentials, false, ...migrateAnswers()]);
  await runWizard({ prompts: full, env: {}, presets: { sourceBucket: 'bkt', lastCopyDate: 'auto' }, baseOpts: { outputDir: dir }, commands: spyCommands(calls) });
  assert.equal(calls[1].opts.lastCopyDate, undefined);
});

test('wizard: "Keep running deltas" passes --repeat and its limit; command line options answer the question', async () => {
  const calls = [];
  const prompts = fakePrompts([pick('migrate'), ...typedCredentials, ...sourceAnswers, pick('azcopy'), '2000', '1TiB', '4', pick('repeat'), (o) => (assert.equal(o.initialValue, '10000'), '5000'), true]);
  assert.equal(await runWizard({ prompts, env: {}, commands: spyCommands(calls) }), 0);
  assert.equal(prompts.remaining(), 0);
  assert.deepEqual([calls[0].opts.repeat, calls[0].opts.repeatUntil, calls[0].opts.repeatMax], [true, '5000', undefined]);
  assert.match(prompts.shown.find((s) => s.startsWith('note Summary')), /Repeat +until ≤ 5,000 objects, at most 10 deltas/);
  assert.match(prompts.asked.find((a) => a.message.startsWith('Stop when a delta')).validate('x'), /whole number/);

  const presets = { sourceBucket: 'bkt', repeat: true, repeatUntil: '200', repeatMax: '3' };
  const fromCli = fakePrompts([pick('migrate'), cliSelect('use'), ...typedCredentials, false, pick('azcopy'), '2000', '1TiB', '4', true]);
  assert.equal(await runWizard({ prompts: fromCli, env: {}, presets, commands: spyCommands(calls) }), 0);
  assert.equal(fromCli.remaining(), 0);
  assert.deepEqual([calls[1].opts.repeat, calls[1].opts.repeatUntil, calls[1].opts.repeatMax], [true, '200', '3']);
  assert.match(fromCli.shown.join('\n'), /When it ends +run deltas until one finds few objects[^]*Repeat until +≤ 200 objects[^]*Repeat +until ≤ 200 objects, at most 3 deltas/);
});

test('wizard: the continue list shows whether a migration is full or delta', async () => {
  const dir = fabricatedMigrations([MIGRATIONS[1], { name: '20261110T010000Z-delta-migration', startedAt: '2026-11-10T01:00:00.000Z', outcome: 'interrupted', includeAfter: '2026-11-08T04:50:00Z', chunks: ['pending', 'pending'] }]);
  let options;
  const prompts = fakePrompts([pick('continue'), ...typedCredentials, (o) => ((options = o.options), o.options[0].value), true]);
  assert.equal(await runWizard({ prompts, env: {}, baseOpts: { outputDir: dir }, commands: spyCommands([]) }), 0);
  assert.match(options[0].label, /^2026-11-10 01:00 {2}delta {2}copying {3}0\/2 chunks · interrupted/);
  assert.match(options[1].label, /^2026-11-05 02:00 {2}full {3}copying /);
});
