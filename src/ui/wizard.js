import path from 'node:path';
import process from 'node:process';
import * as baseCommands from '../commands.js';
import * as migrationCommands from '../migration.js';
import { parseCount, parseSize } from '../chunks.js';
import { parseLastCopyDate } from '../dates.js';
import { EXIT } from '../job.js';
import { buildSourceUrl, buildTargetBase, parseBucketInput, parseTargetSasUrl, normalizePrefix } from '../urls.js';
import { UsageError } from '../errors.js';
import { Secrets } from './secrets.js';
import { Dashboard } from './dashboard.js';
import { MigrationDashboard } from './migration-dashboard.js';
import { fit } from './style.js';

export { fit };

const defaultCommands = { ...baseCommands, ...migrationCommands };
const { MIGRATION_DEFAULTS } = migrationCommands;

const ENV_SAS = 'AZCOPY_COMMANDER_TARGET_SAS_URL';
const OTHER_DATE = '__enter-a-date__';

class Cancelled extends Error {}

const utcMinute = (iso) => (iso ? String(iso).slice(0, 16).replace('T', ' ') : '?');
const validation = (check) => (value) => {
  try {
    check(value ?? '');
  } catch (err) {
    if (err instanceof UsageError) return err.message;
    throw err;
  }
  return undefined;
};

/** Which earlier runs each action can work on (see the plan's table). */
const RUN_FILTERS = {
  delta: (r) => r.bucket && (r.outcome === 'success' || r.outcome === 'partial'),
  retry: (r) => r.failed > 0,
  resume: (r) => r.jobId && r.outcome !== 'success',
};

const MENU = [
  { value: 'copy', label: 'Full copy', hint: 'everything not already at the target' },
  { value: 'delta', label: 'Delta copy', hint: 'only objects modified since an earlier run or date' },
  { value: 'list', label: 'List', hint: 'show what would be copied, nothing is saved' },
  { value: 'retry', label: 'Retry failed files', hint: 'of an earlier run' },
  { value: 'resume', label: 'Resume a run', hint: 'continue an interrupted azcopy job' },
  { value: 'migrate', label: 'Large migration (chunked)', hint: 'inventory, chunks and several azcopy jobs at once' },
  { value: 'continue', label: 'Continue a migration', hint: 'an interrupted or unfinished chunked migration' },
  { value: 'quit', label: 'Quit' },
];

/**
 * The interactive flow. Returns the exit code: the one of the command that ran, 0 for Quit, 130 when
 * cancelled, 64 on a usage error.
 *
 *   prompts   the @clack/prompts module (a scripted fake in tests)
 *   env       where AWS_* and AZCOPY_COMMANDER_TARGET_SAS_URL are looked up (default process.env)
 *   out, err  where the commands print
 *   baseOpts  options shared with the CLI (outputDir, planDir, azcopyPath, azcopyArg, dryRun, ...)
 *   commands  { copyCommand, listCommand, retryCommand, resumeCommand, migrateCommand, listRuns, listMigrations, ... } (default: the real ones)
 *   columns   terminal width (default process.stdout.columns)
 */
export async function runWizard({ prompts, env = process.env, out = process.stdout, err = process.stderr, baseOpts = {}, commands = defaultCommands, columns } = {}) {
  const secrets = new Secrets(env);
  const width = () => Math.max(20, (columns ?? process.stdout.columns ?? 80) - 6);
  const shown = (text) => fit(text, width());

  const ask = async (promise) => {
    const value = await promise;
    if (prompts.isCancel(value)) throw new Cancelled();
    return value;
  };

  // ---- credentials

  async function askAws() {
    if (secrets.aws.source) return;
    if (env.AWS_ACCESS_KEY_ID && env.AWS_SECRET_ACCESS_KEY) {
      const choice = await ask(prompts.select({
        message: 'AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY found in the environment',
        options: [{ value: 'env', label: 'Use them' }, { value: 'typed', label: 'Enter other credentials' }],
      }));
      if (choice === 'env') return secrets.useEnvironmentAws();
    }
    const required = (what) => validation((v) => { if (!v.trim()) throw new UsageError(`${what} is required.`); });
    const accessKeyId = (await ask(prompts.password({ message: 'AWS access key ID (hidden)', validate: required('The access key ID') }))).trim();
    const secretAccessKey = (await ask(prompts.password({ message: 'AWS secret access key (hidden)', validate: required('The secret access key') }))).trim();
    const sessionToken = (await ask(prompts.password({ message: 'AWS session token (hidden, leave empty if none)' }))).trim();
    secrets.setAws({ accessKeyId, secretAccessKey, sessionToken });
  }

  async function askSas() {
    if (secrets.sas.source) return;
    const fromEnv = env[ENV_SAS];
    if (fromEnv) {
      let valid = true;
      try {
        parseTargetSasUrl(fromEnv);
      } catch (e) {
        if (!(e instanceof UsageError)) throw e;
        valid = false;
        prompts.log.warn(`${ENV_SAS} is set but not usable: ${e.message}`);
      }
      if (valid) {
        const choice = await ask(prompts.select({
          message: `${ENV_SAS} found in the environment`,
          options: [{ value: 'env', label: 'Use it' }, { value: 'typed', label: 'Enter another SAS URL' }],
        }));
        if (choice === 'env') {
          secrets.setSas(fromEnv, 'environment');
          parseTargetSasUrl(fromEnv).warnings.forEach((w) => prompts.log.warn(w));
          return;
        }
      }
    }
    const typed = (await ask(prompts.password({
      message: 'Target SAS URL (hidden)',
      validate: validation((v) => parseTargetSasUrl(v.trim())),
    }))).trim();
    secrets.setSas(typed, 'typed');
    parseTargetSasUrl(typed).warnings.forEach((w) => prompts.log.warn(w));
  }

  // ---- previous runs

  const runLabel = (r) => shown(`${utcMinute(r.startedAt)}  ${r.kind.padEnd(5)} ${r.outcome.padEnd(11)} ${r.copied} copied · ${r.failed} failed · ${r.bucket ?? '?'}${r.prefix ? `/${r.prefix}` : ''}`);

  async function pickRun(action, runs, extraOptions = []) {
    const verb = { delta: 'Delta since which run?', retry: 'Retry the failed files of which run?', resume: 'Resume which run?' }[action];
    return ask(prompts.select({
      message: `${verb} (times are UTC, newest first)`,
      options: [...runs.map((r) => ({ value: r, label: runLabel(r), hint: undefined })), ...extraOptions],
    }));
  }

  // ---- source

  async function askSource(run) {
    const bucketInput = (await ask(prompts.text({
      message: 'S3 bucket name or ARN',
      initialValue: run?.bucket ?? '',
      validate: validation((v) => parseBucketInput(v.trim())),
    }))).trim();
    const parsed = parseBucketInput(bucketInput);
    let prefix = normalizePrefix(await ask(prompts.text({
      message: 'Prefix (optional)',
      initialValue: run?.prefix ?? '',
      validate: validation((v) => normalizePrefix(v)),
    })));
    if (parsed.prefix && prefix && parsed.prefix !== prefix) {
      prefix = await ask(prompts.select({
        message: 'The ARN and the prefix prompt disagree. Which prefix?',
        options: [{ value: parsed.prefix, label: `From the ARN: ${shown(parsed.prefix)}` }, { value: prefix, label: `Typed: ${shown(prefix)}` }],
      }));
    } else {
      prefix = prefix || parsed.prefix;
    }
    const region = (await ask(prompts.text({
      message: 'AWS region of the bucket (optional, e.g. ap-southeast-2)',
      initialValue: run?.region ?? '',
      validate: validation((v) => { if (v.trim()) buildSourceUrl(parsed.bucket, '', v.trim()); }),
    }))).trim();
    return { bucket: parsed.bucket, prefix, region };
  }

  // ---- chunked migrations

  const migrationLabel = (m) => shown(`${utcMinute(m.startedAt)}  ${m.phase.padEnd(9)} ${m.chunksDone}/${m.chunksTotal} chunks · ${m.outcome.padEnd(11)} ${m.bucket ?? '?'}${m.prefix ? `/${m.prefix}` : ''}`);

  /** Runs migrateCommand with the migration dashboard on a terminal (the plain output otherwise). */
  async function runMigration(opts, target, bucket) {
    if (out.isTTY) {
      const container = new URL(target.base).pathname.replace(/^\/+/, '');
      opts.view = new MigrationDashboard({ out, columns, route: [bucket, container] });
    }
    secrets.apply();
    try {
      return await commands.migrateCommand(opts, out);
    } catch (e) {
      if (!(e instanceof UsageError)) throw e;
      prompts.log.error(secrets.redact(e.message));
      return EXIT.USAGE;
    } finally {
      secrets.restore();
    }
  }

  const summaryNote = (rows) => prompts.note(rows.map(([label, value]) => `${label.padEnd(10)}${fit(value, width() - 10)}`).join('\n'), 'Summary');

  async function migrateFlow() {
    await askAws();
    await askSas();
    const target = parseTargetSasUrl(secrets.sas.url);
    const source = await askSource();
    const overwriteModified = await ask(prompts.confirm({ message: 'Replace blobs that already exist when the S3 object is newer? (--overwrite-modified)', initialValue: false }));
    const inventorySource = await ask(prompts.select({
      message: 'How is the source listed (the inventory)?',
      options: [
        { value: 'azcopy', label: 'azcopy dry run', hint: 'no extra requirements' },
        { value: 's3', label: 'S3 API (AWS SDK)', hint: 'also finds archived objects; needs npm install' },
      ],
    }));
    const chunkFiles = (await ask(prompts.text({
      message: 'Most objects in a chunk',
      initialValue: String(MIGRATION_DEFAULTS.chunkFiles),
      validate: validation((v) => parseCount(v.trim(), 'the number of objects')),
    }))).trim();
    const chunkBytes = (await ask(prompts.text({
      message: 'Most data in a chunk (e.g. 500GiB, 2TiB)',
      initialValue: '1TiB',
      validate: validation((v) => parseSize(v.trim(), 'the chunk size')),
    }))).trim();
    const parallel = (await ask(prompts.text({
      message: 'azcopy jobs at once',
      initialValue: String(MIGRATION_DEFAULTS.parallel),
      validate: validation((v) => parseCount(v.trim(), 'the number of jobs')),
    }))).trim();

    summaryNote([
      ['Source', buildSourceUrl(source.bucket, source.prefix, source.region)],
      ['Target', buildTargetBase(target, source.prefix)],
      ['Inventory', inventorySource === 's3' ? 'S3 API (ListObjectsV2)' : 'azcopy dry run'],
      ['Chunks', `at most ${chunkFiles} objects or ${chunkBytes} each`],
      ['Copy', `${parallel} azcopy jobs at once`],
      ['Replace', overwriteModified ? 'blobs older than the S3 object' : 'never (append-only)'],
      ['Secrets', secrets.describe()],
    ]);
    if (!(await ask(prompts.confirm({ message: 'Start the migration?', initialValue: true })))) {
      prompts.log.info('Not started.');
      return undefined;
    }
    const opts = {
      ...baseOpts,
      targetSasUrl: secrets.sas.url,
      sourceBucket: source.bucket,
      sourcePrefix: source.prefix,
      sourceRegion: source.region || undefined,
      overwriteModified,
      inventorySource,
      chunkFiles,
      chunkBytes,
      parallel,
    };
    return runMigration(opts, target, source.bucket);
  }

  async function continueFlow() {
    const candidates = commands.listMigrations(baseOpts).filter((m) => m.outcome !== 'success');
    if (candidates.length === 0) {
      prompts.log.warn(`No unfinished migration in ${shown(path.resolve(baseOpts.outputDir ?? 'runs'))}.`);
      return undefined;
    }
    await askAws();
    await askSas();
    const target = parseTargetSasUrl(secrets.sas.url);
    const picked = await ask(prompts.select({
      message: 'Continue which migration? (times are UTC, newest first)',
      options: candidates.map((m) => ({ value: m, label: migrationLabel(m), hint: undefined })),
    }));
    if (picked.targetBase !== target.base) {
      prompts.log.error(`The SAS URL targets ${shown(target.base)}, but that migration copies to ${shown(picked.targetBase)}.`);
      secrets.forgetSas(); // ask for another one next time
      return undefined;
    }
    summaryNote([
      ['Migration', picked.dir],
      ['State', `${picked.phase}, ${picked.chunksDone}/${picked.chunksTotal} chunks done, ${picked.outcome}`],
      ['Target', picked.targetBase],
      ['Secrets', secrets.describe()],
    ]);
    if (!(await ask(prompts.confirm({ message: 'Continue the migration?', initialValue: true })))) {
      prompts.log.info('Not continued.');
      return undefined;
    }
    return runMigration({ ...baseOpts, targetSasUrl: secrets.sas.url, migration: picked.dir }, target, picked.bucket);
  }

  // ---- one pass through the menu

  /** Returns an exit code, or undefined to go back to the menu. */
  async function once() {
    const action = await ask(prompts.select({ message: 'What do you want to do?', options: MENU }));
    if (action === 'quit') return EXIT.OK;
    if (action === 'migrate') return migrateFlow();
    if (action === 'continue') return continueFlow();

    let candidates = [];
    if (RUN_FILTERS[action]) {
      candidates = commands.listRuns(baseOpts).filter(RUN_FILTERS[action]);
      if (candidates.length === 0 && action !== 'delta') {
        const what = action === 'retry' ? 'with failed files' : 'that can be resumed';
        prompts.log.warn(`No earlier run ${what} in ${shown(path.resolve(baseOpts.outputDir ?? 'runs'))}.`);
        return undefined;
      }
    }

    await askAws();
    await askSas();
    const target = parseTargetSasUrl(secrets.sas.url);

    const opts = { ...baseOpts, targetSasUrl: secrets.sas.url };
    let run = null;
    let lastCopyDate = null;
    let modeText;

    if (RUN_FILTERS[action]) {
      // A delta copy needs no earlier run when a date is typed, so with none to pick it goes straight to the date.
      const picked = action === 'delta' && candidates.length === 0 ? OTHER_DATE
        : await pickRun(action, candidates, action === 'delta' ? [{ value: OTHER_DATE, label: 'Enter a date instead' }] : []);
      if (picked === OTHER_DATE) {
        const date = (await ask(prompts.text({
          message: 'Copy objects modified on/after (ISO 8601, e.g. 2026-01-31 or 2026-01-31T14:30:00Z; no zone = UTC)',
          validate: validation((v) => parseLastCopyDate(v.trim())),
        }))).trim();
        lastCopyDate = parseLastCopyDate(date).toISOString();
        modeText = `delta, objects modified on/after ${lastCopyDate}`;
      } else {
        run = picked;
        if (action === 'delta') {
          lastCopyDate = commands.deltaDateFor(run).toISOString();
          modeText = `delta, objects modified on/after ${lastCopyDate}`;
        }
      }
    }
    // Retry and resume work on the run itself; the others need a source.
    let source;
    if (action === 'retry' || action === 'resume') {
      if (run.targetBase !== target.base) {
        prompts.log.error(`The SAS URL targets ${shown(target.base)}, but that run copied to ${shown(run.targetBase)}.`);
        secrets.forgetSas(); // ask for another one next time
        return undefined;
      }
      source = { bucket: run.bucket, prefix: run.prefix, region: run.region };
      modeText = action === 'retry' ? `retry the ${run.failed} failed file(s) of ${run.dir}` : `resume azcopy job ${run.jobId} of ${run.dir}`;
    } else {
      source = await askSource(run);
      opts.overwriteModified = await ask(prompts.confirm({
        message: 'Replace blobs that already exist when the S3 object is newer? (--overwrite-modified)',
        initialValue: run?.overwriteModified ?? false,
      }));
      modeText ??= action === 'list' ? 'list only, nothing is copied or saved' : 'full copy, everything not already at the target';
      if (action === 'delta' && run && run.targetBase !== target.base) {
        prompts.log.warn(`That run copied to ${shown(run.targetBase)}, but the SAS URL targets ${shown(target.base)}.`);
        if (!(await ask(prompts.confirm({ message: 'Run the delta copy against this target anyway?', initialValue: false })))) {
          secrets.forgetSas();
          return undefined;
        }
      }
    }

    const sourceUrl = buildSourceUrl(source.bucket, source.prefix, source.region);
    prompts.note(
      [
        `Source   ${fit(sourceUrl, width() - 9)}`,
        `Target   ${fit(buildTargetBase(target, source.prefix), width() - 9)}`,
        `Mode     ${fit(modeText, width() - 9)}`,
        ...(action === 'copy' || action === 'delta' ? [`Replace  ${opts.overwriteModified ? 'blobs older than the S3 object' : 'never (append-only)'}`] : []),
        `Secrets  ${fit(secrets.describe(), width() - 9)}`,
      ].join('\n'),
      'Summary',
    );
    const go = await ask(prompts.confirm({ message: { list: 'List the files?', retry: 'Start the retry?', resume: 'Resume the run?' }[action] ?? 'Start the copy?', initialValue: true }));
    if (!go) {
      prompts.log.info('Not started.');
      return undefined;
    }

    // ---- run the existing command
    if (action === 'copy' || action === 'delta' || action === 'list') {
      Object.assign(opts, { sourceBucket: source.bucket, sourcePrefix: source.prefix, sourceRegion: source.region || undefined });
      if (lastCopyDate) opts.lastCopyDate = lastCopyDate;
    } else {
      opts.run = run.dir;
    }
    const command = { copy: 'copyCommand', delta: 'copyCommand', list: 'listCommand', retry: 'retryCommand', resume: 'resumeCommand' }[action];
    // On a terminal the copy shows the live dashboard; without one (tests, pipes) the plain output is used.
    if (out.isTTY && command !== 'listCommand') {
      const title = { retry: 'Retrying failed files', resume: 'Resuming' }[action] ?? 'Copying';
      const container = new URL(target.base).pathname.replace(/^\/+/, '');
      opts.view = new Dashboard({ out, columns, title, route: [source.bucket, container] });
    }

    secrets.apply();
    try {
      return await (command === 'listCommand' ? commands[command](opts, out, err) : commands[command](opts, out));
    } catch (e) {
      if (!(e instanceof UsageError)) throw e;
      prompts.log.error(secrets.redact(e.message));
      return EXIT.USAGE;
    } finally {
      secrets.restore();
    }
  }

  prompts.intro('azcopy-commander · S3 → Azure Blob');
  try {
    for (;;) {
      const code = await once();
      if (code !== undefined) {
        prompts.outro(code === EXIT.OK ? 'Done.' : `Finished with exit code ${code}.`);
        return code;
      }
    }
  } catch (e) {
    if (!(e instanceof Cancelled)) throw e;
    prompts.cancel('Cancelled');
    return EXIT.INTERRUPTED;
  } finally {
    secrets.clear();
  }
}
