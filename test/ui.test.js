import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runWizard, fit } from '../src/ui/wizard.js';
import { migrateCommandLine, shellQuote } from '../src/ui/command-line.js';
import { Secrets } from '../src/ui/secrets.js';
import { colorEnabled, createStyle, unicodeSupported, visible } from '../src/ui/style.js';
import * as realCommands from '../src/commands.js';
import * as realMigration from '../src/migration.js';
import { MigrationDashboard, renderMigrationDashboard } from '../src/ui/migration-dashboard.js';
import { renderMigrationScreen } from '../src/ui/migration-screen.js';
import { DEFAULT_SIZE_CLASSES } from '../src/size-classes.js';
import { fakeContainer, fakeS3, PRESIGN_SECRET } from './fakes.js';

const SAS = 'https://acct.blob.core.windows.net/cont?sv=2022-11-02&sp=racwl&se=2099-01-01T00:00:00Z&sig=SECRETSIG123';
const OTHER_SAS = 'https://other.blob.core.windows.net/elsewhere?sv=2022-11-02&sp=racwl&se=2099-01-01T00:00:00Z&sig=OTHERSIG456';
const KEY = 'AKIATYPEDKEY12345';
const SECRET = 'typedAwsSecretValue0123456789';
const TOKEN = 'typedSessionTokenValue987';
const SECRET_TEXTS = [KEY, SECRET, TOKEN, 'SECRETSIG123', 'OTHERSIG456', PRESIGN_SECRET];
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

/** Commands that only record the options they were called with. */
function spyCommands(calls, code = 0) {
  const record = (name) => async (opts) => {
    calls.push({ name, opts: { ...opts } });
    return code;
  };
  return { deltaDateFor: realCommands.deltaDateFor, listCommand: record('list'), migrateCommand: record('migrate'), listMigrations: realMigration.listMigrations };
}

/** Sets the process environment variables `keys` to `values` (absent = unset) for `fn`, then restores them. */
async function withEnv(values, fn, keys = ['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN', 'AZCOPY_COMMANDER_TARGET_SAS_URL']) {
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  for (const k of keys) delete process.env[k];
  Object.assign(process.env, values);
  try {
    return await fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

const typedCredentials = [KEY, SECRET, TOKEN, SAS];
const sourceAnswers = ['bkt', 'data', 'ap-southeast-2', false]; // bucket, prefix, region, overwrite-modified
/** how to chunk, [chunk objects,] chunk size, chunks at once, [objects at once,] when it ends, confirm (by size class: no counts) */
const migrateAnswers = (over = {}) => {
  const uniform = (over.chunking ?? 'uniform') === 'uniform';
  return [
    pick(over.chunking ?? 'uniform'),
    ...(over.chunking === 'profile' ? [over.sizeProfile] : []),
    ...(uniform ? [over.chunkFiles ?? '2000'] : []),
    over.chunkBytes ?? '500GiB',
    over.parallel ?? '3',
    ...(uniform ? [over.concurrency ?? '16'] : []),
    pick(over.ends ?? 'stop'),
    true,
  ];
};
const migrateScript = () => [pick('migrate'), ...typedCredentials, ...sourceAnswers, ...migrateAnswers()];

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

// ------------------------------------------------------------- the wizard

test('large migration with typed secrets, end to end with the SDK fakes: copied, nothing leaked, environment restored', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'azc-ui-e2e-'));
  const s3 = fakeS3({ 'data/a.txt': { size: 10 }, 'data/b c.txt': { size: 20 }, 'data/d/e.bin': { size: 30 }, 'other/x': { size: 1 } }, { pageSize: 2 });
  const container = fakeContainer(s3);
  await withEnv({}, async () => {
    const prompts = fakePrompts([pick('migrate'), ...typedCredentials, ...sourceAnswers, ...migrateAnswers({ chunkFiles: '2' })]);
    const out = sink();
    const err = sink();
    const code = await runWizard({ prompts, env: process.env, out, err, baseOpts: { outputDir: dir, s3, container, yes: true } });
    assert.equal(code, 0, out.text());
    assert.equal(prompts.remaining(), 0);
    assert.equal(prompts.asked.filter((a) => a.kind === 'password').length, 4); // key, secret, token, SAS
    assert.deepEqual([...container.blobs.keys()].sort(), ['data/a.txt', 'data/b c.txt', 'data/d/e.bin']);

    // Nothing secret anywhere on screen or in the migration folder.
    const everything = [out.text(), err.text(), prompts.shown.join('\n'), JSON.stringify(prompts.asked.map((a) => a.message))].join('\n');
    for (const secret of SECRET_TEXTS) assert.ok(!everything.includes(secret), `${secret} on screen`);
    assert.match(prompts.shown.join('\n'), /Secrets +AWS key: typed \(memory only\)/);
    const files = fs.readdirSync(dir, { recursive: true, withFileTypes: true }).filter((e) => e.isFile());
    assert.ok(files.length > 0);
    for (const f of files) {
      const text = fs.readFileSync(path.join(f.parentPath, f.name), 'utf8');
      for (const secret of SECRET_TEXTS) assert.ok(!text.includes(secret), `${secret} in ${f.name}`);
    }
    for (const k of ['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN']) assert.equal(process.env[k], undefined, `${k} restored`);
  });
});

test('large migration: the questions, their defaults and the summary; typed AWS values are in the environment only while it runs', async () => {
  const env = {};
  const calls = [];
  const commands = spyCommands(calls);
  commands.migrateCommand = async (opts) => {
    calls.push({ name: 'migrate', opts: { ...opts }, awsKey: env.AWS_ACCESS_KEY_ID, awsSecret: env.AWS_SECRET_ACCESS_KEY, token: env.AWS_SESSION_TOKEN });
    return 0;
  };
  const prompts = fakePrompts(migrateScript());
  assert.equal(await runWizard({ prompts, env, baseOpts: { outputDir: 'unused' }, commands, columns: 200 }), 0);
  assert.equal(prompts.remaining(), 0);
  const { opts } = calls[0];
  assert.deepEqual([calls[0].awsKey, calls[0].awsSecret, calls[0].token], [KEY, SECRET, TOKEN]);
  assert.deepEqual(
    [opts.sourceBucket, opts.sourcePrefix, opts.sourceRegion, opts.targetSasUrl, opts.overwriteModified, opts.chunkFiles, opts.chunkBytes, opts.parallel, opts.concurrency, opts.lastCopyDate, opts.repeat],
    ['bkt', 'data', 'ap-southeast-2', SAS, false, '2000', '500GiB', '3', '16', undefined, undefined],
  );
  assert.equal(opts.makeView, undefined, 'no dashboard without a terminal');
  assert.deepEqual(env, {});
  const defaults = ['Most objects in a chunk', 'Most data in a chunk', 'Chunks copied at once', 'Objects copied at once'].map((m) => prompts.asked.find((a) => a.message.startsWith(m)).initialValue);
  assert.deepEqual(defaults, ['100000', '1TiB', '4', '32']);
  const summary = prompts.shown.find((s) => s.startsWith('note Summary'));
  assert.match(summary, /Mode +full, everything not already at the target/);
  assert.match(summary, /Chunks +at most 2000 objects or 500GiB each, closed after 15 min/);
  assert.match(summary, /Copy +as the chunks close: 3 chunk\(s\) at once, 16 object\(s\) at once in each/);
  assert.match(summary, /Replace +never \(append-only\)/);
  for (const secret of SECRET_TEXTS) assert.ok(!prompts.shown.join('\n').includes(secret));
});

test('large migration by size class: the chunking question, the class table, no counts asked; a profile file is on the command line', async () => {
  const calls = [];
  const out = sink();
  const prompts = fakePrompts([pick('migrate'), ...typedCredentials, ...sourceAnswers, ...migrateAnswers({ chunking: 'classes' })]);
  assert.equal(await runWizard({ prompts, env: {}, out, baseOpts: { outputDir: 'unused' }, commands: spyCommands(calls), columns: 200 }), 0);
  assert.equal(prompts.remaining(), 0);
  const question = prompts.asked.find((a) => a.message === 'How should the listing be cut into chunks?');
  assert.equal(question.initialValue, 'classes');
  assert.deepEqual(question.options.map((o) => o.label), ['By size class (defaults)', 'By size class, from a profile file', 'Uniform chunks']);
  assert.ok(!prompts.asked.some((a) => a.message.startsWith('Most objects in a chunk') || a.message.startsWith('Objects copied at once')));
  assert.match(prompts.shown.find((s) => s.startsWith('note Size classes')), /very-small +< 1 MiB +100,000 files per chunk, 128 at once\n[^]*very-large +≥ 100 GiB +50 files per chunk, 2 at once/);
  const summary = prompts.shown.find((s) => s.startsWith('note Summary'));
  assert.match(summary, /Chunks +by size class \(defaults\), each at most its files per chunk or 500GiB, closed after 15 min/);
  assert.match(summary, /Copy +as the chunks close: 3 chunk\(s\) at once, the objects at once of its size class in each/);
  assert.deepEqual([calls[0].opts.chunkFiles, calls[0].opts.concurrency, calls[0].opts.sizeProfile], [undefined, undefined, undefined]);
  assert.match(out.text(), /azcopy-commander migrate --source-bucket bkt --source-prefix data --source-region ap-southeast-2 --chunk-bytes 500GiB --parallel 3 /);

  // from a profile file: it is checked when typed, and its absolute path is on the command line
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'azc-ui-profile-')), 'profile.json');
  fs.writeFileSync(file, JSON.stringify({ classes: [{ name: 'small', below: '1MiB', chunkFiles: 10, concurrency: 64 }, { name: 'big', chunkFiles: 2, concurrency: 2 }] }));
  const out2 = sink();
  const withFile = fakePrompts([pick('migrate'), ...typedCredentials, ...sourceAnswers, ...migrateAnswers({ chunking: 'profile', sizeProfile: file })]);
  assert.equal(await runWizard({ prompts: withFile, env: {}, out: out2, baseOpts: { outputDir: 'unused' }, commands: spyCommands(calls), columns: 200 }), 0);
  assert.equal(withFile.remaining(), 0);
  assert.match(withFile.asked.find((a) => a.message.startsWith('Size profile file')).validate(path.join(path.dirname(file), 'none.json')), /Cannot read the size profile/);
  assert.match(withFile.shown.find((s) => s.startsWith('note Size classes')), /small +< 1 MiB +10 files per chunk, 64 at once\nbig +≥ 1 MiB +2 files per chunk, 2 at once/);
  assert.equal(calls[1].opts.sizeProfile, file);
  assert.ok(out2.text().includes(`--size-profile ${shellQuote(file)}`));
});

test('the menu has no azcopy action left', async () => {
  let options;
  const prompts = fakePrompts([(o) => ((options = o.options), 'quit')]);
  assert.equal(await runWizard({ prompts, env: {}, commands: spyCommands([]) }), 0);
  assert.deepEqual(options.map((o) => o.value), ['migrate', 'delta-migrate', 'continue', 'list', 'quit']);
  assert.ok(!JSON.stringify(options).toLowerCase().includes('azcopy'));
});

test('list asks for the AWS credentials and the source, not for a SAS URL', async () => {
  const env = {};
  const calls = [];
  const commands = spyCommands(calls);
  commands.listCommand = async (opts) => {
    calls.push({ name: 'list', opts: { ...opts }, awsKey: env.AWS_ACCESS_KEY_ID });
    return 0;
  };
  const prompts = fakePrompts([pick('list'), KEY, SECRET, '', 'bkt', 'data', 'ap-southeast-2', true]);
  assert.equal(await runWizard({ prompts, env, commands }), 0);
  assert.equal(prompts.remaining(), 0);
  assert.ok(!prompts.asked.some((a) => a.message.includes('SAS')));
  assert.deepEqual([calls[0].opts.sourceBucket, calls[0].opts.sourcePrefix, calls[0].opts.sourceRegion, calls[0].opts.targetSasUrl, calls[0].awsKey], ['bkt', 'data', 'ap-southeast-2', undefined, KEY]);
  assert.match(prompts.shown.find((s) => s.startsWith('note Summary')), /Mode +list only, nothing is copied or saved[^]*SAS: none/);
  assert.deepEqual(env, {});
});

test('secrets from the environment: "Use them" does not ask for typed values; an ARN prefix is used when none is typed', async () => {
  const env = { AWS_ACCESS_KEY_ID: KEY, AWS_SECRET_ACCESS_KEY: SECRET, AZCOPY_COMMANDER_TARGET_SAS_URL: SAS };
  const calls = [];
  const prompts = fakePrompts([pick('migrate'), pick('env'), pick('env'), 'arn:aws:s3:::bkt/data/x', '', '', false, ...migrateAnswers()]);
  assert.equal(await runWizard({ prompts, env, commands: spyCommands(calls), columns: 200 }), 0);
  assert.equal(prompts.asked.filter((a) => a.kind === 'password').length, 0);
  assert.deepEqual(calls.map((c) => c.name), ['migrate']);
  assert.equal(calls[0].opts.sourceBucket, 'bkt');
  assert.equal(calls[0].opts.sourcePrefix, 'data/x');
  assert.equal(calls[0].opts.targetSasUrl, SAS);
  assert.match(prompts.shown.join('\n'), /AWS key: environment · AWS secret: environment · SAS: environment/);
  assert.deepEqual(env, { AWS_ACCESS_KEY_ID: KEY, AWS_SECRET_ACCESS_KEY: SECRET, AZCOPY_COMMANDER_TARGET_SAS_URL: SAS });
});

test('an ARN prefix and a different typed prefix: the user chooses', async () => {
  const calls = [];
  const prompts = fakePrompts([pick('migrate'), ...typedCredentials, 'arn:aws:s3:::bkt/from-arn', 'typed', (o) => o.options[0].value, '', false, ...migrateAnswers()]);
  await runWizard({ prompts, env: {}, commands: spyCommands(calls) });
  assert.equal(calls[0].opts.sourcePrefix, 'from-arn');
});

test('prompt validators reject bad input without leaking it', async () => {
  const prompts = fakePrompts([pick('migrate'), KEY, SECRET, '', SAS, 'bkt', '', '', false, pick('uniform'), '10', '2TiB', '3', '8', pick('stop'), false, pick('quit')]);
  const calls = [];
  assert.equal(await runWizard({ prompts, env: {}, commands: spyCommands(calls) }), 0);
  assert.deepEqual(calls, [], 'declining runs nothing');
  const byMessage = (m) => prompts.asked.find((a) => a.message.includes(m));
  assert.match(byMessage('Target SAS URL').validate('https://acct.blob.core.windows.net/cont'), /SAS/);
  assert.match(byMessage('Target SAS URL').validate(SAS.replace('racwl', 'rl')), /write/);
  assert.equal(byMessage('Target SAS URL').validate(''), 'Target SAS URL is not a valid URL.');
  assert.match(byMessage('bucket name or ARN').validate('Bad_Bucket'), /Invalid S3 bucket/);
  assert.match(byMessage('bucket name or ARN').validate('arn:aws:s3:us-east-1:123:accesspoint/x'), /access point/);
  assert.match(byMessage('region').validate('nowhere'), /Invalid AWS region/);
  assert.equal(byMessage('region').validate(''), undefined);
  assert.match(byMessage('access key ID').validate(' '), /required/);
  assert.match(byMessage('Most objects').validate('0'), /whole number/);
  assert.match(byMessage('Most objects').validate('many'), /whole number/);
  assert.equal(byMessage('Most objects').validate('500000'), undefined);
  assert.match(byMessage('Most data').validate('lots'), /Invalid the chunk size/);
  assert.equal(byMessage('Most data').validate('750 GiB'), undefined);
  assert.match(byMessage('Chunks copied at once').validate('-1'), /whole number/);
  assert.match(byMessage('Objects copied at once').validate('x'), /whole number/);
  for (const a of prompts.asked.filter((x) => x.kind === 'password' && x.validate)) {
    const message = a.validate(`${SECRET}?sig=SECRETSIG123`);
    assert.ok(!String(message ?? '').includes(SECRET) && !String(message ?? '').includes('SECRETSIG123'), `"${a.message}" repeats the input`);
  }
});

test('Ctrl+C at every step ends with exit code 130 and runs nothing', async () => {
  const script = migrateScript();
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
  const prompts = fakePrompts([...migrateScript().slice(0, -1), false, pick('quit')]);
  assert.equal(await runWizard({ prompts, env: {}, commands: spyCommands(calls) }), 0);
  assert.deepEqual(calls, []);
  assert.ok(prompts.shown.includes('info: Not started.'));
});

test('a usage error from the command is shown without secrets and gives exit code 64', async () => {
  const commands = spyCommands([]);
  commands.migrateCommand = async () => {
    throw new realCommands.UsageError(`bad thing with ${SECRET}`);
  };
  const prompts = fakePrompts(migrateScript());
  assert.equal(await runWizard({ prompts, env: {}, commands }), 64);
  assert.ok(prompts.shown.some((s) => s === 'error: bad thing with ***'));
});

test('long values are ellipsised to the terminal width', async () => {
  const calls = [];
  const longPrefix = 'a-very-long-prefix/'.repeat(8);
  const prompts = fakePrompts([pick('migrate'), ...typedCredentials, 'bkt', longPrefix, '', false, ...migrateAnswers()]);
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

// ------------------------------------------------------------- chunked migrations in the wizard

/** Fabricated migration folders (format 2 unless `format` says otherwise). */
function fabricatedMigrations(list) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'azc-ui-mig-'));
  for (const x of list) {
    fs.mkdirSync(path.join(dir, x.name));
    if (x.manifest === false) continue;
    const format = x.format ?? 2;
    fs.writeFileSync(path.join(dir, x.name, 'migration.json'), JSON.stringify({
      kind: 'migration', format, startedAt: x.startedAt, outcome: x.outcome, bucket: x.bucket ?? 'bkt', prefix: x.prefix ?? '', region: x.region ?? '',
      overwriteModified: Boolean(x.overwriteModified), includeAfter: x.includeAfter ?? null,
      sourceBase: 'https://s3.amazonaws.com/bkt', targetBase: x.targetBase ?? 'https://acct.blob.core.windows.net/cont',
      inventory: { status: x.inventory ?? 'done' }, ...(format === 1 ? { chunking: { status: 'done' } } : {}),
      chunks: (x.chunks ?? []).map((status, i) => ({ id: i + 1, status, bytes: 1, list: `chunks/${String(i + 1).padStart(5, '0')}.jsonl` })),
    }));
  }
  return dir;
}

const MIGRATIONS = [
  { name: '20261101T010000Z-migration', startedAt: '2026-11-01T01:00:00.000Z', outcome: 'success', chunks: ['success', 'success'] },
  { name: '20261105T020000Z-migration', startedAt: '2026-11-05T02:00:00.000Z', outcome: 'interrupted', prefix: 'data', chunks: ['success', 'exhausted', 'pending', 'interrupted'] },
  { name: '20261106T030000Z-migration', startedAt: '2026-11-06T03:00:00.000Z', outcome: 'stopped', inventory: 'running' },
  { name: '20261107T040000Z-migration', manifest: false },
];
const AZCOPY_MIGRATION = { name: '20261104T010000Z-migration', startedAt: '2026-11-04T01:00:00.000Z', outcome: 'interrupted', format: 1, chunks: ['success', 'pending'] };

test('wizard: continue a migration lists the unfinished ones, newest first, and passes the chosen folder', async () => {
  const dir = fabricatedMigrations([...MIGRATIONS, AZCOPY_MIGRATION]);
  const calls = [];
  let options;
  const prompts = fakePrompts([pick('continue'), ...typedCredentials, (o) => ((options = o.options), o.options[1].value), true]);
  assert.equal(await runWizard({ prompts, env: {}, baseOpts: { outputDir: dir }, commands: spyCommands(calls) }), 0);
  assert.equal(options.length, 2, 'the finished migration, the one made with azcopy and the folder without migration.json are not offered');
  assert.match(options[0].label, /^2026-11-06 03:00 {2}full {3}inventory 0\/0 chunks · stopped/);
  assert.match(options[1].label, /^2026-11-05 02:00 {2}full {3}copying {3}2\/4 chunks · interrupted +bkt\/data/);
  assert.equal(calls[0].name, 'migrate');
  assert.equal(calls[0].opts.migration, path.join(dir, '20261105T020000Z-migration'));
  assert.equal(calls[0].opts.targetSasUrl, SAS);
  assert.equal(calls[0].opts.sourceBucket, undefined);
  assert.match(prompts.shown.find((s) => s.startsWith('note Summary')), /State +copying, 2\/4 chunks done, interrupted/);
});

test('wizard: continue refuses a SAS for another target and asks for a new one; says so when nothing can be continued', async () => {
  const dir = fabricatedMigrations(MIGRATIONS);
  const calls = [];
  const prompts = fakePrompts([pick('continue'), ...typedCredentials.slice(0, 3), OTHER_SAS, pickRun(0), pick('continue'), SAS, pickRun(0), true]);
  assert.equal(await runWizard({ prompts, env: {}, baseOpts: { outputDir: dir }, commands: spyCommands(calls) }), 0);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].opts.targetSasUrl, SAS);
  assert.ok(prompts.shown.some((s) => s.startsWith('error: The SAS URL targets')));

  const done = fabricatedMigrations([MIGRATIONS[0], AZCOPY_MIGRATION]);
  const none = fakePrompts([pick('continue'), pick('quit')]);
  assert.equal(await runWizard({ prompts: none, env: {}, baseOpts: { outputDir: done }, commands: spyCommands([]) }), 0);
  assert.ok(none.shown.some((s) => s.startsWith('warn: No unfinished migration') && s.includes('(1 made with azcopy cannot be continued)')));
  assert.equal(none.asked.filter((a) => a.kind === 'password').length, 0);
});

test('wizard: a migration on a terminal gets the migration dashboard as its view', async () => {
  const calls = [];
  const run = async (out) => runWizard({ prompts: fakePrompts(migrateScript()), env: {}, out, baseOpts: {}, commands: spyCommands(calls) });
  await run(fakeTerminal());
  await run(sink());
  assert.equal(calls[0].opts.view, undefined, 'a view per round instead of one');
  const view = calls[0].opts.makeView({ delta: false, round: 0 });
  assert.ok(view instanceof MigrationDashboard);
  assert.ok(view.title.startsWith('Migrating') && view.title.includes('bkt') && view.title.includes('cont') && !view.title.includes('round'));
  const deltaView = calls[0].opts.makeView({ delta: true, round: 2 });
  assert.match(deltaView.title, /^Delta migration {2}bkt \S+ cont · round 2$/);
  assert.equal(calls[1].opts.makeView, undefined);
});

// ---- options given on the command line

const cliSelect = (value) => (o) => o.options.find((x) => x.value === value)?.value ?? assert.fail(`no option ${value}`);

test('command line options: migrate takes them over without asking again', async () => {
  const env = { AWS_ACCESS_KEY_ID: KEY, AWS_SECRET_ACCESS_KEY: SECRET };
  const calls = [];
  const presets = { sourceBucket: 'bkt', sourceRegion: 'ap-southeast-2', chunkFiles: '2000', chunkBytes: '500GiB', parallel: '4', concurrency: '64', maxAttempts: '3', blockSize: '64MiB', targetSasUrl: SAS };
  const prompts = fakePrompts([pick('migrate'), cliSelect('use'), pick('env'), false, pick('stop'), true]);
  assert.equal(await runWizard({ prompts, env, presets, commands: spyCommands(calls) }), 0);
  assert.equal(prompts.remaining(), 0);
  assert.deepEqual(prompts.asked.map((a) => a.kind), ['select', 'select', 'select', 'confirm', 'select', 'confirm']);
  const { opts } = calls[0];
  assert.deepEqual(
    [opts.sourceBucket, opts.sourcePrefix, opts.sourceRegion, opts.targetSasUrl, opts.overwriteModified, opts.chunkFiles, opts.chunkBytes, opts.parallel, opts.concurrency, opts.maxAttempts, opts.blockSize],
    ['bkt', '', 'ap-southeast-2', SAS, false, '2000', '500GiB', '4', '64', '3', '64MiB'],
  );
  const shownText = prompts.shown.join('\n');
  assert.match(shownText, /From the command line:[^]*Bucket +bkt[^]*Prefix +\(whole bucket\)[^]*Chunks at once +4[^]*Objects at once +64/);
  assert.match(shownText, /SAS: command line/);
  assert.ok(!shownText.includes('SECRETSIG123'));
});

test('command line options: "go through the questions" prefills them; options not given are asked', async () => {
  const calls = [];
  const presets = { sourceBucket: 'bkt', parallel: '4', overwriteModified: true };
  const prompts = fakePrompts([pick('migrate'), cliSelect('review'), ...typedCredentials, (o) => o.initialValue, '', '', true, pick('uniform'), '2000', '1TiB', (o) => o.initialValue, '16', pick('stop'), true]);
  assert.equal(await runWizard({ prompts, env: {}, presets, commands: spyCommands(calls) }), 0);
  assert.equal(prompts.remaining(), 0);
  const initial = (m) => prompts.asked.find((a) => a.message.includes(m)).initialValue;
  assert.equal(initial('bucket name or ARN'), 'bkt');
  assert.equal(initial('Chunks copied at once'), '4');
  assert.equal(initial('Replace blobs'), true);
  assert.equal(calls[0].opts.parallel, '4');
  assert.equal(calls[0].opts.chunkFiles, '2000');
});

test('command line options: an unusable one is reported and asked for as usual', async () => {
  const calls = [];
  const prompts = fakePrompts([pick('migrate'), cliSelect('use'), ...typedCredentials, '', 'ap-southeast-2', false, pick('uniform'), '2000', '1TiB', '4', '32', pick('stop'), true]);
  await runWizard({ prompts, env: {}, presets: { sourceBucket: 'bkt', sourceRegion: 'nowhere', parallel: '0' }, commands: spyCommands(calls) });
  assert.match(prompts.shown.join('\n'), /warn: --source-region from the command line is not usable[^]*warn: --parallel from the command line is not usable/);
  assert.ok(prompts.asked.some((a) => a.message.includes('AWS region')), 'the region is asked for');
  assert.ok(prompts.asked.some((a) => a.message.includes('Chunks copied at once')), 'the chunk count is asked for');
  assert.equal(calls[0].opts.parallel, '4');
});

test('command line options: list takes the date; a full migration ignores it', async () => {
  const presets = { sourceBucket: 'bkt', sourcePrefix: 'data', lastCopyDate: '2026-01-31' };
  const calls = [];
  const list = fakePrompts([pick('list'), cliSelect('use'), KEY, SECRET, '', true]);
  assert.equal(await runWizard({ prompts: list, env: {}, presets, commands: spyCommands(calls) }), 0);
  assert.equal(list.remaining(), 0);
  assert.deepEqual([calls[0].opts.sourceBucket, calls[0].opts.sourcePrefix, calls[0].opts.lastCopyDate], ['bkt', 'data', '2026-01-31T00:00:00.000Z']);

  const full = fakePrompts([pick('migrate'), cliSelect('use'), ...typedCredentials, false, ...migrateAnswers()]);
  await runWizard({ prompts: full, env: {}, presets, commands: spyCommands(calls) });
  assert.equal(calls[1].name, 'migrate');
  assert.equal(calls[1].opts.lastCopyDate, undefined);
  assert.ok(!full.shown.join('\n').includes('Modified since'));
});

test('command line options: continue applies --parallel, --concurrency and --max-attempts', async () => {
  const calls = [];
  const dir = fabricatedMigrations([MIGRATIONS[1]]);
  const prompts = fakePrompts([pick('continue'), KEY, SECRET, '', SAS, pickRun(0), true]);
  await runWizard({ prompts, env: {}, presets: { parallel: '2', concurrency: '8', maxAttempts: '9' }, baseOpts: { outputDir: dir }, commands: spyCommands(calls) });
  assert.equal(prompts.remaining(), 0);
  assert.deepEqual([calls[0].opts.parallel, calls[0].opts.concurrency, calls[0].opts.maxAttempts], ['2', '8', '9']);
  assert.match(prompts.shown.join('\n'), /Changes +--parallel 2 --concurrency 8 --max-attempts 9/);
});

// ---- delta migrations

const FINISHED = { name: '20261108T050000Z-migration', startedAt: '2026-11-08T05:00:00.000Z', outcome: 'partial', prefix: 'data', region: 'ap-southeast-2', overwriteModified: true, chunks: ['success', 'success'] };
const sameAsInitial = (o) => o.initialValue;

test('wizard: delta migration lists the finished migrations, passes its date and folder, and prefills the source', async () => {
  const dir = fabricatedMigrations([MIGRATIONS[0], MIGRATIONS[1], FINISHED]);
  const calls = [];
  let options;
  const prompts = fakePrompts([pick('delta-migrate'), ...typedCredentials, (o) => ((options = o.options), o.options[0].value), sameAsInitial, sameAsInitial, sameAsInitial, sameAsInitial, ...migrateAnswers()]);
  assert.equal(await runWizard({ prompts, env: {}, baseOpts: { outputDir: dir }, commands: spyCommands(calls), columns: 400 }), 0);
  assert.equal(prompts.remaining(), 0);
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
});

test('wizard: "Keep running deltas" passes --repeat and its limit; command line options answer the question', async () => {
  const calls = [];
  const prompts = fakePrompts([pick('migrate'), ...typedCredentials, ...sourceAnswers, pick('uniform'), '2000', '1TiB', '4', '32', pick('repeat'), (o) => (assert.equal(o.initialValue, '10000'), '5000'), true]);
  assert.equal(await runWizard({ prompts, env: {}, commands: spyCommands(calls) }), 0);
  assert.equal(prompts.remaining(), 0);
  assert.deepEqual([calls[0].opts.repeat, calls[0].opts.repeatUntil, calls[0].opts.repeatMax], [true, '5000', undefined]);
  assert.match(prompts.shown.find((s) => s.startsWith('note Summary')), /Repeat +until ≤ 5,000 objects, at most 10 deltas/);
  assert.match(prompts.asked.find((a) => a.message.startsWith('Stop when a delta')).validate('x'), /whole number/);

  const presets = { sourceBucket: 'bkt', repeat: true, repeatUntil: '200', repeatMax: '3' };
  const fromCli = fakePrompts([pick('migrate'), cliSelect('use'), ...typedCredentials, false, pick('uniform'), '2000', '1TiB', '4', '32', true]);
  assert.equal(await runWizard({ prompts: fromCli, env: {}, presets, commands: spyCommands(calls) }), 0);
  assert.equal(fromCli.remaining(), 0);
  assert.deepEqual([calls[1].opts.repeat, calls[1].opts.repeatUntil, calls[1].opts.repeatMax], [true, '200', '3']);
  assert.match(fromCli.shown.join('\n'), /When it ends +run deltas until one finds few objects[^]*Repeat until +≤ 200 objects[^]*Repeat +until ≤ 200 objects, at most 3 deltas/);
});

test('wizard: --stop-after inventory needs no "when it ends" question and is shown in the summary', async () => {
  const calls = [];
  const prompts = fakePrompts([pick('migrate'), cliSelect('use'), ...typedCredentials, false, pick('uniform'), '2000', '1TiB', '4', '32', true]);
  assert.equal(await runWizard({ prompts, env: {}, presets: { sourceBucket: 'bkt', stopAfter: 'inventory', repeat: true }, commands: spyCommands(calls) }), 0);
  assert.equal(prompts.remaining(), 0);
  assert.equal(calls[0].opts.stopAfter, 'inventory');
  assert.equal(calls[0].opts.repeat, undefined);
  assert.ok(prompts.shown.includes('warn: --repeat is not used with --stop-after.'));
  assert.match(prompts.shown.find((s) => s.startsWith('note Summary')), /Stops +after the listing and the analysis: nothing is copied/);
});

test('wizard: the continue list shows whether a migration is full or delta', async () => {
  const dir = fabricatedMigrations([MIGRATIONS[1], { name: '20261110T010000Z-delta-migration', startedAt: '2026-11-10T01:00:00.000Z', outcome: 'interrupted', includeAfter: '2026-11-08T04:50:00Z', chunks: ['pending', 'pending'] }]);
  let options;
  const prompts = fakePrompts([pick('continue'), ...typedCredentials, (o) => ((options = o.options), o.options[0].value), true]);
  assert.equal(await runWizard({ prompts, env: {}, baseOpts: { outputDir: dir }, commands: spyCommands([]) }), 0);
  assert.match(options[0].label, /^2026-11-10 01:00 {2}delta {2}copying {3}0\/2 chunks · interrupted/);
  assert.match(options[1].label, /^2026-11-05 02:00 {2}full {3}copying /);
});

// ------------------------------------------------------------- the migration dashboard

/** A terminal stand-in that records each write. */
function fakeTerminal(columns = 100, rows = 30) {
  const writes = [];
  const listeners = {};
  return {
    isTTY: true,
    columns,
    rows,
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
const plain = (lines) => lines.join('\n');
const ENTER = '\x1b[?1049h\x1b[?25l';
const LEAVE = '\x1b[?1049l\x1b[?25h';
/** The rows of the last frame in a write, without colour. */
const frameRows = (write) => visible(write.slice(write.lastIndexOf('\x1b[H') + 3).replace(/\x1b\[K\x1b\[J$/, '')).split('\r\n');

const TiB = 2 ** 40;
const AGGREGATE = {
  chunksTotal: 190, chunksDone: 42, chunksRunning: 4, chunksPending: 144, chunksExhausted: 1,
  running: [{ id: 13, percent: 71 }, { id: 14, percent: 18 }, { id: 15, percent: 52 }, { id: 16, percent: 2 }],
  classes: [],
  copied: 3012554, ignored: 0, missing: 0, failed: 3, bytesDone: 44.1 * TiB, bytesTotal: 184.2 * TiB, percent: 23.9, throughput: 1.62 * 2 ** 30,
  averageThroughput: 1.4 * 2 ** 30, etaSeconds: 90720, elapsedSeconds: 600,
};
const LISTING = { ...AGGREGATE, listing: true, listed: 3_100_000, etaSeconds: NaN };
const MIG_STATE = {
  title: 'Migrating  my-bucket → files3', phase: 'copying', frame: 2, elapsedSeconds: 134, snapshot: AGGREGATE, parallel: 10,
  speeds: [1, 2, 3, 4, 5, 6, 5, 6], logFile: 'runs\\m\\migration.log',
};
const MIG_RESULT = {
  outcome: 'partial', dir: 'runs\\m', maxAttempts: 5, chunksTotal: 190, chunksSuccess: 188, chunksExhausted: 2, chunksOpen: 0, copied: 12480000, ignored: 5, missing: 0, failed: 113,
  bytesCopied: 184 * TiB, elapsedSeconds: 90000, skipped: 3, archived: 1, skippedFile: 'runs\\m\\chunks\\skipped.jsonl', files: { log: 'runs\\m\\migration.log', migration: 'runs\\m\\migration.json' },
};

test('renderMigrationDashboard: the compact lines of the copy, the listing, the inventory and the analysis', () => {
  const text = plain(renderMigrationDashboard(MIG_STATE, { columns: 50 }));
  for (const part of ['Migrating', '2m 14s', '23.9%', '1.62 GiB/s · ETA 1d 1h 12m', '✔ 42/190 ▶ 4 ✖ 3']) assert.ok(text.includes(part), `missing "${part}" in\n${text}`);
  assert.equal(renderMigrationDashboard(MIG_STATE, { columns: 50 }).length, 4);

  const listing = plain(renderMigrationDashboard({ ...MIG_STATE, snapshot: LISTING }, { columns: 50 }));
  assert.ok(listing.includes('listing 3,100,000 · 190 chunks') && listing.includes('184.20 TiB+') && listing.includes('ETA after listing'), listing);
  assert.ok(!listing.includes('23.9%'), 'no percentage of a total still growing');
  assert.deepEqual(renderMigrationDashboard({ ...MIG_STATE, snapshot: LISTING }, { columns: 30 }), ['+3,100,000 1.62GiB/s']);
  assert.deepEqual(renderMigrationDashboard(MIG_STATE, { columns: 30 }), ['23.9% 1.62GiB/s 1d1h']);

  const inventory = { title: 'Migrating', phase: 'inventory', frame: 0, elapsedSeconds: 5, inventory: { files: 1234567, bytes: 3 * TiB } };
  const inv = plain(renderMigrationDashboard(inventory, { columns: 50 }));
  assert.ok(inv.includes('Inventory') && inv.includes('1,234,567 objects · 3.00 TiB'), inv);
  assert.notEqual(inv, plain(renderMigrationDashboard({ ...inventory, frame: 4 }, { columns: 50 })), 'the bar moves');
  assert.ok(plain(renderMigrationDashboard({ ...inventory, phase: 'analysis' }, { columns: 50 })).includes('Analysis'));
});

test('renderMigrationDashboard: no line is wider than the terminal at any width, in any phase', () => {
  const states = [
    MIG_STATE,
    { ...MIG_STATE, snapshot: LISTING },
    { ...MIG_STATE, snapshot: null },
    { ...MIG_STATE, phase: 'inventory', inventory: { files: 12, bytes: 99 } },
    { ...MIG_STATE, phase: 'analysis', analysis: ['x'.repeat(200)] },
    { result: MIG_RESULT, errorCodes: [['AuthorizationFailure', 100], ['CannotVerifyCopySource', 13]] },
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
});

test('renderMigrationDashboard: the result panel per outcome', () => {
  const partial = plain(renderMigrationDashboard({ result: MIG_RESULT, errorCodes: [['AuthorizationFailure', 100], ['CannotVerifyCopySource', 13]] }, { columns: 110 }));
  for (const part of [
    'Migration completed with failed files', 'chunks 188/190 copied · 2 with failed files · 0 not finished', 'copied 12,480,000 · ignored 5 · failed 113',
    'not copied   3 key(s) (1 archived, 2 with a line break)', 'errors       AuthorizationFailure (100) · CannotVerifyCopySource (13)',
    'choose "Continue a migration" in the menu', 'folder       runs\\m', 'migration.log',
  ]) assert.ok(partial.includes(part), `missing "${part}" in\n${partial}`);
  assert.ok(!partial.includes('missing'), 'no missing counter when nothing is missing');
  assert.ok(plain(renderMigrationDashboard({ result: { ...MIG_RESULT, missing: 4 } }, { columns: 110 })).includes('ignored 5 · missing 4 · failed 113'));
  const ok = { ...MIG_RESULT, outcome: 'success', chunksSuccess: 190, chunksExhausted: 0, failed: 0, skipped: 0 };
  const okText = plain(renderMigrationDashboard({ result: ok }, { columns: 110, color: true }));
  assert.ok(okText.includes('Migration completed') && okText.includes('\x1b[32m') && !okText.includes('Continue a migration') && !okText.includes('not copied'));
  assert.ok(plain(renderMigrationDashboard({ result: { ...MIG_RESULT, outcome: 'failed' } }, { columns: 110, color: true })).includes('\x1b[31m'));
  assert.ok(plain(renderMigrationDashboard({ result: { ...MIG_RESULT, outcome: 'interrupted', chunksOpen: 5 } }, { columns: 110 })).includes('Migration interrupted'));
  assert.deepEqual(renderMigrationDashboard({ result: MIG_RESULT }, { columns: 30 }), ['188/190 chunks · 113 failed']);
});

// ---- the full screen

const SLOT = { state: 'running', attempt: 1 };
const SCREEN_SNAPSHOT = {
  ...LISTING,
  running: [
    { id: 13, sizeClass: 'very-small', percent: 71, filesDone: 71012, filesTotal: 100000, bytesDone: 612 * 2 ** 20, bytesTotal: 860 * 2 ** 20 },
    { id: 14, sizeClass: 'small', percent: 18, filesDone: 9100, filesTotal: 50000, bytesDone: 410 * 2 ** 30, bytesTotal: TiB },
    { id: 15, sizeClass: 'large', percent: 52, filesDone: 520, filesTotal: 1000, bytesDone: 1.4 * TiB, bytesTotal: 2.7 * TiB },
  ],
  chunksRunning: 3,
  classes: [
    { name: 'very-small', chunks: 120, done: 40, running: 1, pending: 79, exhausted: 0, files: 11_800_000, bytes: 3.1 * TiB, bytesDone: 0.97 * TiB },
    { name: 'small', chunks: 50, done: 2, running: 1, pending: 47, exhausted: 0, files: 2_400_000, bytes: 48 * TiB, bytesDone: 2.4 * TiB },
  ],
};
const SCREEN_STATE = {
  ...MIG_STATE,
  elapsedSeconds: 8040,
  snapshot: SCREEN_SNAPSHOT,
  parallel: 4,
  errorCodes: [['AuthorizationFailure', 3]],
  sizeClasses: DEFAULT_SIZE_CLASSES,
  slots: [
    { ...SLOT, ...SCREEN_SNAPSHOT.running[0], speed: 12.3 * 2 ** 20 },
    { ...SLOT, ...SCREEN_SNAPSHOT.running[1], speed: 310 * 2 ** 20 },
    { ...SLOT, ...SCREEN_SNAPSHOT.running[2], speed: 1.1 * 2 ** 30, attempt: 2 },
    { id: 12, sizeClass: 'medium', state: 'ended', outcome: 'success', percent: 100, agoSeconds: 4, copied: 10000, failed: 0 },
  ],
  log: [
    { time: 0, level: 'INFO', text: 'chunk 00041 (small) listed: 50,000 objects, 1.02 TiB' },
    { time: 0, level: 'FAIL', text: 'chunk 00015  AuthorizationFailure  data/2024/big file.bin' },
    { time: 0, level: 'WARN', text: 'chunk 00014: S3 SlowDown, retrying' },
  ],
};

test('renderMigrationScreen: at 120 x 40 the header, the overall panel, the slots, the size classes and the log', () => {
  const lines = renderMigrationScreen(SCREEN_STATE, { columns: 120, rows: 40 });
  assert.equal(lines.length, 40);
  const text = plain(lines);
  for (const part of [
    'Migrating  my-bucket → files3', 'elapsed 2h 14m',
    'overall', '23.9%', '44.10 TiB / 184.20 TiB+', 'speed     1.62 GiB/s', 'average 1.40 GiB/s', 'ETA after listing',
    'listing   3,100,000 objects listed · 190 chunks so far', 'copied 3,012,554 · ignored 0 · missing 0 · failed 3', 'errors AuthorizationFailure 3',
    'chunks    ✔ 42 done · ▶ 3 running · 144 pending · ✖ 1 out of attempts',
    '── Chunks being copied (4 workers) ──', '── Size classes ──', '── Log  runs\\m\\migration.log ──',
    'done 4s ago · copied 10,000 · failed 0', '✖ chunk 00015  AuthorizationFailure  data/2024/big file.bin', 'WARN chunk 00014: S3 SlowDown, retrying',
  ]) assert.ok(text.includes(part), `missing "${part}" in\n${text}`);
  assert.match(text, /^ 1 ▶ 00013 very-small █+░+ +71% +71,012 \/ 100,000 obj +612\.00 MiB \/ 860\.00 MiB +12\.30 MiB\/s +try 1$/m);
  assert.match(text, /^ 3 ▶ 00015 large {6}█+░+ +52% .* try 2$/m);
  assert.match(text, /^ 4 ✔ 00012 medium {5}█{15} 100% {3}done/m);
  assert.match(text, /^ class +size +at once +chunks +✔ done +▶ run +pending +objects +data +copied$/m);
  assert.match(text, /^ very-small +< 1 MiB +128 +120 +40 +1 +79 +11,800,000 +3\.10 TiB +31%$/m);
  assert.match(text, /^ very-large +≥ 100 GiB +2 +0 +0 +0 +0 +0 +0 B +—$/m, 'a class without chunks');
  const log = lines.findIndex((l) => l.startsWith('── Log'));
  assert.match(lines[log + 1], /^ \d\d:\d\d:\d\d {2}chunk 00041 \(small\) listed/);
  assert.match(lines[log + 3], /WARN chunk 00014/, 'the newest line last');
  assert.ok(!text.includes('\x1b'));
});

test('renderMigrationScreen: exactly the rows of the terminal and never wider, at any size, in any phase', () => {
  const many = { ...SCREEN_STATE, slots: Array.from({ length: 32 }, (_, i) => SCREEN_STATE.slots[i % 4]) };
  const long = { ...SCREEN_STATE, log: Array.from({ length: 50 }, (_, i) => ({ time: 0, level: 'ERROR', text: `line ${i} ${'x'.repeat(200)}` })) };
  const states = [
    SCREEN_STATE, many, long,
    { ...SCREEN_STATE, snapshot: AGGREGATE, sizeClasses: null },
    { ...SCREEN_STATE, phase: 'inventory', snapshot: null, inventory: { files: 12, bytes: 99 }, slots: [null, null] },
    { ...SCREEN_STATE, phase: 'analysis', snapshot: null, slots: [] },
    { title: 'Migrating', phase: 'inventory' },
  ];
  for (const [columns, rows] of [[120, 40], [80, 24], [60, 16], [59, 30], [40, 10], [200, 15], [30, 5]]) {
    for (const state of states) {
      for (const color of [false, true]) {
        for (const unicode of [true, false]) {
          const lines = renderMigrationScreen(state, { columns, rows, color, unicode });
          assert.equal(lines.length, rows, `${columns} x ${rows}`);
          for (const l of lines) assert.ok(visible(l).length <= columns - 1, `${columns} x ${rows}: "${visible(l)}" is too wide`);
        }
      }
    }
  }
  const ascii = plain(renderMigrationScreen(SCREEN_STATE, { columns: 120, rows: 40, unicode: false }));
  assert.ok(ascii.includes('> 00013') && ascii.includes('* 00012') && !/[✔✖▶█░│─⏸]/.test(ascii), ascii);
});

test('renderMigrationScreen: many workers end with "+N more running"; the log keeps 3 rows; classes on one line when rows are short', () => {
  const slot = (i) => ({ ...SLOT, id: i + 1, sizeClass: 'very-small', percent: i, filesDone: i, filesTotal: 100, bytesDone: i, bytesTotal: 100, speed: 0 });
  const many = { ...SCREEN_STATE, slots: Array.from({ length: 32 }, (_, i) => slot(i)) };
  const lines = renderMigrationScreen(many, { columns: 80, rows: 24 });
  const text = plain(lines);
  assert.match(text, /^ \+\d+ more running$/m);
  assert.match(text, /^ classes {3}very-small 120 \(40 ✔\) · small 50 \(2 ✔\)/m);
  const log = lines.findIndex((l) => l.startsWith('── Log'));
  assert.ok(lines.length - log - 1 >= 3, 'at least 3 rows of log');

  // At 80 columns the slots drop their columns from the right: the bar and the percent stay.
  assert.match(text, /^ {2}1 ▶ 00001 very-small [█░]+ +0%/m);
  assert.ok(!text.includes('try 1'));

  const uniform = plain(renderMigrationScreen({ ...SCREEN_STATE, sizeClasses: null, snapshot: AGGREGATE }, { columns: 120, rows: 40 }));
  assert.ok(!uniform.includes('Size classes') && !uniform.includes('classes '), 'uniform chunks: no class table');
});

test('renderMigrationScreen: the inventory phase, empty slots and the small-screen fallback', () => {
  const inventory = { ...SCREEN_STATE, phase: 'inventory', provider: 'S3 ListObjectsV2', snapshot: null, inventory: { files: 1234567, bytes: 3 * TiB }, slots: [null, null] };
  const text = plain(renderMigrationScreen(inventory, { columns: 100, rows: 30 }));
  assert.ok(text.includes('1,234,567 objects · 3.00 TiB so far') && text.includes('S3 ListObjectsV2 · 1,234,567 objects listed'), text);
  assert.match(text, /^ 1 {3}waiting for the first chunk$/m);
  assert.match(plain(renderMigrationScreen({ ...SCREEN_STATE, slots: [null] }, { columns: 100, rows: 30 })), /^ 1 {3}waiting for the listing$/m);
  assert.match(plain(renderMigrationScreen({ ...SCREEN_STATE, snapshot: AGGREGATE, slots: [null] }, { columns: 100, rows: 30 })), /^ 1 {3}idle$/m);

  // too few rows or columns: the compact lines, then the log under them
  for (const [columns, rows] of [[120, 12], [50, 30]]) {
    const lines = renderMigrationScreen(SCREEN_STATE, { columns, rows });
    assert.match(lines[0], /^⠹ Migrating +2h 14m$/);
    assert.ok(!plain(lines).includes('overall'));
    const log = lines.findIndex((l) => l.startsWith('── Log'));
    assert.ok(log > 0 && lines[log + 3].includes('WARN chunk 00014'), plain(lines));
  }
});

/** A MigrationDashboard on a fake terminal, started, in the copy phase with AGGREGATE drawn. */
async function copyingDashboard(options = {}) {
  const term = fakeTerminal(options.columns ?? 100, options.rows ?? 30);
  const dash = new MigrationDashboard({ out: term, color: false, unicode: true, tickMs: 1e6, ...options, columns: undefined, rows: undefined });
  dash.start({ logFile: 'l.log' });
  dash.copyStarted({ chunks: 2, parallel: options.parallel ?? 2, concurrency: 32 });
  dash.progress(AGGREGATE);
  await flush();
  return { term, dash };
}

test('MigrationDashboard: start enters the alternate screen; every update is one write of the whole screen from the top left', async () => {
  const { term, dash } = await copyingDashboard();
  assert.equal(term.writes.length, 1, 'start, copyStarted and progress in one tick are one write');
  const first = unsync(term.writes[0]);
  assert.ok(first.startsWith(`${ENTER}\x1b[H`), 'alternate screen and hidden cursor before the first frame');
  assert.equal(first.split('\x1b[H').length, 2, 'one frame');
  assert.equal(frameRows(first).length, 30, 'one row per terminal row');
  assert.ok(first.endsWith('\x1b[K\x1b[J') && !first.endsWith('\n'), 'no newline after the last row: the screen does not scroll');

  dash.progress({ ...AGGREGATE, percent: 60 });
  dash.progress({ ...AGGREGATE, percent: 61 });
  await flush();
  assert.equal(term.writes.length, 2);
  const second = unsync(term.writes[1]);
  assert.ok(second.startsWith('\x1b[H') && second.split('\x1b[H').length === 2, 'the last frame of the tick, alone');
  assert.ok(second.includes('61.0%') && !second.includes('60.0%'));
  dash.close();
});

test('MigrationDashboard: the inventory phase lasts until the first chunk is closed, or starts with ready chunks', async () => {
  const term = fakeTerminal();
  const dash = new MigrationDashboard({ out: term, color: false, unicode: true, tickMs: 1e6 });
  dash.start({ logFile: 'l.log' });
  dash.copyStarted({ chunks: 0, parallel: 2 });
  dash.inventoryStarted({ provider: 'S3 ListObjectsV2', source: 's3://bkt/data' });
  dash.inventoryProgress({ files: 1000, bytes: 2048 });
  await flush();
  assert.equal(dash.phase, 'inventory');
  assert.ok(frameRows(unsync(term.writes.at(-1))).some((r) => r.includes('waiting for the first chunk')));
  dash.chunkClosed({ id: 1, files: 10, bytes: 2048 });
  assert.equal(dash.phase, 'copying');
  await flush();
  assert.ok(frameRows(unsync(term.writes.at(-1))).some((r) => r.includes('chunk 00001 listed: 10 objects, 2.00 KiB')));
  dash.close();

  const resumed = new MigrationDashboard({ out: fakeTerminal(), color: false, unicode: true, tickMs: 1e6 });
  resumed.start({ logFile: 'l.log' });
  resumed.copyStarted({ chunks: 3, parallel: 2 });
  resumed.inventoryStarted({ provider: 'S3 ListObjectsV2' });
  assert.equal(resumed.phase, 'copying', 'chunks ready when continuing: the copy is shown at once');
  resumed.close();

  const stopAfter = new MigrationDashboard({ out: fakeTerminal(), color: false, unicode: true, tickMs: 1e6 });
  stopAfter.start({ logFile: 'l.log' });
  stopAfter.inventoryStarted({ provider: 'S3 ListObjectsV2' });
  stopAfter.chunkClosed({ id: 1 });
  assert.equal(stopAfter.phase, 'inventory', 'without a copy a closed chunk changes nothing');
  stopAfter.analysis({}, ['12 objects']);
  assert.equal(stopAfter.phase, 'analysis');
  stopAfter.close();
});

test('MigrationDashboard: slots never move; an ended chunk shows its outcome until the next chunk takes its slot', async () => {
  let now = 0;
  const { term, dash } = await copyingDashboard({ parallel: 3, now: () => now });
  const ids = () => dash.migrationState().slots.map((s) => s?.id ?? null);
  const chunk = (id) => ({ id, sizeClass: 'small', files: 100, bytes: 1000, attempts: 1, status: 'running', copied: 0, failed: 0 });
  const [c1, c2, c3, c4] = [1, 2, 3, 4].map(chunk);
  assert.deepEqual(ids(), [null, null, null]);
  dash.chunkStarted(1, c1);
  dash.chunkStarted(2, c2);
  dash.chunkStarted(3, c3);
  assert.deepEqual(ids(), [1, 2, 3]);

  Object.assign(c2, { status: 'success', copied: 100, failed: 0, bytesCopied: 1000 });
  now = 4000;
  dash.chunkEnded(c2);
  assert.deepEqual(ids(), [1, 2, 3], 'an ended chunk stays in its slot');
  await flush();
  let rows = frameRows(unsync(term.writes.at(-1)));
  assert.ok(rows.some((r) => /^ 2 ✔ 00002 small █+ 100% {3}done 0s ago · copied 100 · failed 0$/.test(r)), rows.join('\n'));
  assert.ok(rows.some((r) => r.includes('chunk 00002 (small) success')), 'the end is in the log');

  dash.chunkStarted(4, c4);
  assert.deepEqual(ids(), [1, 4, 3], 'chunk 4 takes the free slot 2; slots 1 and 3 do not move');
  dash.chunkStarted(1, c1);
  assert.deepEqual(ids(), [1, 4, 3], 'a chunk that starts again keeps its slot');

  // the speed of a chunk is over its last seconds; its attempt is shown
  c3.attempts = 2;
  const running = (bytes) => ({ ...AGGREGATE, running: [{ id: 3, sizeClass: 'small', percent: bytes / 10, filesDone: 5, filesTotal: 100, bytesDone: bytes, bytesTotal: 1000 }] });
  dash.progress(running(0));
  now = 6000;
  dash.progress(running(800));
  await flush();
  rows = frameRows(unsync(term.writes.at(-1)));
  assert.ok(rows.some((r) => /^ 3 ▶ 00003 small +█+░+ +80% +5 \/ 100 obj +800 B \/ 1000 B +400 B\/s +try 2$/.test(r)), rows.join('\n'));
  dash.close();
});

test('MigrationDashboard: warnings, errors and failed files go to the log panel; the log keeps the last 500 lines', async () => {
  const { term, dash } = await copyingDashboard({ columns: 120 });
  dash.message('WARN', 'S3: slow down');
  await flush();
  const rows = frameRows(unsync(term.writes.at(-1)));
  const log = rows.findIndex((r) => r.startsWith('── Log  l.log'));
  assert.ok(log > 0 && rows.slice(log).some((r) => /^ \d\d:\d\d:\d\d {2}WARN S3: slow down$/.test(r)), rows.join('\n'));

  const before = term.writes.length;
  dash.failure(3, 'a/b.txt', 'AuthorizationFailure');
  dash.failure(3, 'c.txt', 'AuthorizationFailure');
  dash.failure(4, 'd.txt');
  await flush();
  assert.equal(term.writes.length, before, 'recording alone draws nothing');
  dash.progress(AGGREGATE);
  await flush();
  const text = frameRows(unsync(term.writes.at(-1))).join('\n');
  assert.ok(text.includes('✖ chunk 00003  AuthorizationFailure  a/b.txt') && text.includes('✖ chunk 00004  unknown  d.txt'), text);
  assert.ok(text.includes('errors AuthorizationFailure 2 · unknown 1'), text);
  assert.ok(text.indexOf('S3: slow down') < text.indexOf('d.txt'), 'the newest line last');

  for (let i = 0; i < 600; i++) dash.message('INFO', `line ${i}\nwith a line break`);
  assert.equal(dash.logLines.length, 500);
  assert.equal(dash.logLines.at(-1).text, 'line 599 with a line break');
  dash.close();
});

test('MigrationDashboard: summary leaves the full screen and prints the result panel; close() alone also leaves it', async () => {
  const { term, dash } = await copyingDashboard();
  dash.failure(3, 'a/b.txt', 'AuthorizationFailure');
  dash.failure(3, 'c.txt', 'AuthorizationFailure');
  dash.failure(4, 'd.txt');
  dash.summary(MIG_RESULT);
  await flush();
  const end = unsync(term.writes.at(-1));
  assert.ok(end.startsWith(LEAVE), 'the normal screen and the cursor come back first');
  assert.ok(end.includes('Migration completed with failed files') && end.includes('errors       AuthorizationFailure (2) · unknown (1)'), end);
  assert.ok(!end.includes('\x1b[H'), 'the panel is printed, not drawn at the top');
  const count = term.writes.length;
  dash.close();
  dash.summary(MIG_RESULT);
  dash.progress(AGGREGATE);
  await flush();
  assert.equal(term.writes.length, count, 'nothing more is drawn after the end');
  dash.message('WARN', 'after the end');
  await flush();
  assert.equal(unsync(term.writes.at(-1)), 'after the end\n', 'a message after the end is printed as it is');

  const other = await copyingDashboard();
  other.dash.close();
  await flush();
  assert.ok(unsync(other.term.writes.at(-1)).includes(LEAVE), 'close() without a summary leaves the full screen');
  other.dash.close();
  await flush();
  assert.equal(other.term.writes.filter((w) => w.includes(LEAVE)).length, 1, 'only once');
});

test('MigrationDashboard: the timer animates the clock, resize clears and redraws, and close() clears both', async () => {
  const term = fakeTerminal(100, 30);
  let now = 0;
  const dash = new MigrationDashboard({ out: term, color: false, unicode: true, tickMs: 5, now: () => now });
  dash.start({ logFile: 'l.log' });
  dash.copyStarted({ chunks: 1, parallel: 1 });
  dash.progress(AGGREGATE);
  await flush();
  now = 61_000;
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.ok(term.writes.length > 1, 'the timer redraws');
  assert.ok(unsync(term.writes.at(-1)).includes('elapsed 1m 1s'));

  assert.equal(term.listeners.resize.length, 1);
  term.columns = 50;
  term.rows = 12;
  const before = term.writes.length;
  term.listeners.resize[0]();
  await flush();
  const small = unsync(term.writes.slice(before).find((w) => w.includes('\x1b[2J')) ?? '');
  assert.ok(small.startsWith('\x1b[2J\x1b[H'), 'the screen is cleared before the frame at the new size');
  assert.equal(frameRows(small).length, 12);
  assert.ok(!small.includes('overall'), 'the compact lines on a small screen');

  dash.close();
  assert.equal(term.listeners.resize.length, 0, 'resize listener removed');
  await flush();
  const count = term.writes.length;
  assert.ok(term.writes.at(-1).includes(LEAVE), 'the normal screen and the cursor are back');
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(term.writes.length, count, 'the timer stopped');
});

test('MigrationDashboard: a whole migrate run with the SDK fakes on the full screen, copies while listing, and ends with the result panel; nothing leaks', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'azc-ui-mig-e2e-'));
  const objects = Object.fromEntries(Array.from({ length: 6 }, (_, i) => [`data/f${i + 1}.bin`, { size: 10 }]));
  const s3 = fakeS3(objects, { pageSize: 2 });
  const container = fakeContainer(s3);
  // Page 2 waits until chunk 1 is copied, and long enough for the timer to draw the listing line.
  s3.beforePage = async (n) => {
    if (n !== 2) return;
    const end = Date.now() + 5000;
    while (container.blobs.size < 2 && Date.now() < end) await new Promise((resolve) => setTimeout(resolve, 5));
    await new Promise((resolve) => setTimeout(resolve, 60));
  };
  await withEnv({ AWS_ACCESS_KEY_ID: KEY, AWS_SECRET_ACCESS_KEY: SECRET }, async () => {
    const term = fakeTerminal(100, 40);
    const view = new MigrationDashboard({ out: term, color: true, unicode: true, tickMs: 5 });
    const code = await realMigration.migrateCommand({
      outputDir: dir, targetSasUrl: SAS, sourceBucket: 'bkt', sourcePrefix: 'data', sourceRegion: 'ap-southeast-2', s3, container, yes: true,
      chunkFiles: '2', parallel: '2', view,
    }, term);
    await flush();
    assert.equal(code, 0);
    assert.equal(container.blobs.size, 6);
    const all = term.writes.join('').replaceAll('\x1b[?2026h', '').replaceAll('\x1b[?2026l', '');
    const screen = visible(all);
    assert.ok(all.startsWith(ENTER), 'the alternate screen first');
    assert.ok(screen.includes('S3 ListObjectsV2 · '), 'the inventory phase was drawn');
    assert.ok(screen.includes('objects listed ·'), 'the copy was drawn while the listing ran');
    assert.ok(screen.includes('── Chunks being copied (2 workers)') && screen.includes('chunk 00001 started') && screen.includes('chunk 00001 success'), 'the slots and the log');
    const end = all.slice(all.lastIndexOf(LEAVE));
    assert.ok(visible(end).includes('Migration completed') && visible(end).includes('chunks 3/3 copied'), 'the result panel on the normal screen');
    assert.ok(!end.includes('\x1b[H') && end.split(LEAVE).length === 2, 'nothing drawn on the full screen after the result panel');
    assert.ok(!screen.includes('Migration summary') && !screen.includes('Migration: '), 'no plain output with a view');
    for (const secret of SECRET_TEXTS) assert.ok(!term.writes.join('').includes(secret), `${secret} on screen`);
    assert.equal(term.listeners.resize?.length ?? 0, 0, 'resize listener removed');
  });
});

// ---- the command line shown before a migration starts

test('migrateCommandLine: the options of the migration, quoted for the shell, without the SAS URL or internal options', () => {
  const opts = {
    targetSasUrl: SAS, makeView: () => {}, baselineDir: '/runs/old', s3: {}, yes: true,
    sourceBucket: 'bkt', sourcePrefix: "my data/it's", sourceRegion: 'ap-southeast-2', lastCopyDate: '2026-01-31T00:00:00.000Z',
    overwriteModified: false, chunkFiles: '2000', chunkBytes: '500GiB', parallel: '3', concurrency: '16', repeat: true, repeatUntil: '100',
    outputDir: path.resolve('runs'), dryRun: true,
  };
  const out = path.resolve('runs');
  assert.equal(
    migrateCommandLine(opts, { platform: 'win32' }),
    `azcopy-commander migrate --source-bucket bkt --source-prefix 'my data/it''s' --source-region ap-southeast-2 --last-copy-date 2026-01-31T00:00:00.000Z --chunk-files 2000 --chunk-bytes 500GiB --parallel 3 --concurrency 16 --repeat --repeat-until 100 --output-dir ${shellQuote(out, 'win32')} --dry-run`,
  );
  assert.match(migrateCommandLine(opts, { platform: 'linux' }), / --source-prefix 'my data\/it'\\''s' /);
  assert.equal(shellQuote('C:\\Users\\me\\runs', 'win32'), 'C:\\Users\\me\\runs');
  assert.equal(shellQuote('C:\\Users\\me\\runs', 'linux'), "'C:\\Users\\me\\runs'");
  assert.equal(shellQuote('', 'linux'), "''");
  assert.ok(!migrateCommandLine(opts).includes('SECRETSIG123'));
  const continued = migrateCommandLine({ migration: path.join('runs', 'x-migration'), parallel: '2', targetSasUrl: SAS }, { platform: 'linux' });
  assert.equal(continued, `azcopy-commander migrate --migration ${shellQuote(path.resolve('runs', 'x-migration'), 'linux')} --parallel 2 --output-dir ${shellQuote(path.resolve('runs'), 'linux')}`);
});

test('wizard: the command line of the migration is shown on a line of its own just before it starts, without secrets', async () => {
  const out = sink();
  let shownBefore;
  const commands = spyCommands([]);
  commands.migrateCommand = async () => {
    shownBefore = out.text();
    return 0;
  };
  const prompts = fakePrompts(migrateScript());
  assert.equal(await runWizard({ prompts, env: {}, out, baseOpts: { outputDir: 'runs' }, commands }), 0);
  const line = shownBefore.split('\n').find((l) => l.startsWith('azcopy-commander migrate '));
  assert.ok(line, 'the command line is written before migrateCommand runs');
  assert.equal(line, migrateCommandLine({ sourceBucket: 'bkt', sourcePrefix: 'data', sourceRegion: 'ap-southeast-2', chunkFiles: '2000', chunkBytes: '500GiB', parallel: '3', concurrency: '16', outputDir: 'runs' }));
  assert.ok(prompts.shown.some((s) => s.startsWith('info: To run this migration again without the wizard') && s.includes('AZCOPY_COMMANDER_TARGET_SAS_URL')));
  for (const secret of SECRET_TEXTS) assert.ok(!out.text().includes(secret) && !prompts.shown.join('\n').includes(secret));

  // Continuing a migration shows its command line too.
  const dir = fabricatedMigrations(MIGRATIONS);
  const cont = sink();
  await runWizard({ prompts: fakePrompts([pick('continue'), ...typedCredentials, pickRun(0), true]), env: {}, out: cont, baseOpts: { outputDir: dir }, commands: spyCommands([]) });
  assert.match(cont.text(), /^azcopy-commander migrate --migration \S+ --output-dir \S+$/m);
});
