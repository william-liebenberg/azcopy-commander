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
  return { listRuns: realCommands.listRuns, deltaDateFor: realCommands.deltaDateFor, copyCommand: record('copy'), listCommand: record('list'), retryCommand: record('retry'), resumeCommand: record('resume') };
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
