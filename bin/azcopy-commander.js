#!/usr/bin/env node
import process from 'node:process';
import { parseArgs } from 'node:util';
import { copyCommand, listCommand, retryCommand, resumeCommand, UsageError } from '../src/commands.js';
import { EXIT } from '../src/job.js';
import { migrateCommand } from '../src/migration.js';
import { runUi } from '../src/ui/index.js';

const HELP = `azcopy-commander - append-only S3 -> Azure Blob migration controller for AzCopy

Usage:
  azcopy-commander ui                                                interactive wizard (also: no command in a terminal)
  azcopy-commander copy   --source-bucket <bucket> --target-sas-url <url> [options]
  azcopy-commander list   --source-bucket <bucket> --target-sas-url <url> [--source-prefix <p>] [--source-region <r>] [--last-copy-date <d>]
                                                                    only list the files a copy would transfer (saves nothing)
  azcopy-commander retry  [--run <run dir>] --target-sas-url <url>   re-copy the files that failed in a run
  azcopy-commander resume [--run <run dir>] --target-sas-url <url>   continue an interrupted or failed azcopy job
  azcopy-commander migrate --source-bucket <bucket> --target-sas-url <url> [options]   large migration in chunks, see below
  azcopy-commander migrate [--migration <dir>] --target-sas-url <url>                  continue a migration

The ui command asks for the bucket (name or ARN), the AWS keys and the SAS URL (hidden input, or taken from the
environment), lets you pick an earlier run for delta / retry / resume, then runs the same commands. Secrets stay in
memory only. Needs "npm install" (it uses @clack/prompts); the other commands do not. Options: --output-dir,
--plan-dir, --azcopy-path, --azcopy-arg, --dry-run. Any other option given with it (--source-bucket, --source-region,
--parallel, --chunk-files, ...) is shown and offered to the wizard, which then does not ask for it again.

Credentials are read from the environment only:
  AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY [, AWS_SESSION_TOKEN]   S3 read access
  AZCOPY_COMMANDER_TARGET_SAS_URL                                  alternative to --target-sas-url

copy options:
  --source-bucket <name>      Source S3 bucket: a name or an ARN (arn:aws:s3:::bucket[/prefix]) (required)
  --source-prefix <path>      Only copy keys under this sub path (keys keep their layout in the container)
  --source-region <region>    Use the regional S3 endpoint (e.g. ap-southeast-2) instead of s3.amazonaws.com;
                              it must be the bucket's region. Retry reuses the original run's endpoint.
  --target-sas-url <url>      Container SAS URL with write permission (required)
  --last-copy-date <date>     Delta mode: only copy objects modified on/after this date. ISO 8601, e.g.
                              2026-01-31 or 2026-01-31T14:30:00Z (no zone = UTC). "auto" = the start of the
                              previous run recorded in <output-dir>/state.json, minus 10 minutes.
  --overwrite-modified        Also replace an existing blob when the S3 object is newer (azcopy
                              --overwrite=ifSourceNewer). Default is append-only: existing blobs are never
                              touched. Nothing is ever deleted. Not valid for resume; retry reuses the
                              setting of the original run.

migrate: saves an inventory of the source, analyses it, splits it into chunk files and copies the chunks with several
azcopy jobs at once. Everything is recorded in <output-dir>/<timestamp>-migration, so it can be stopped (Ctrl+C) and continued.
Takes the copy options above (--source-bucket, --source-prefix, --source-region, --last-copy-date, --overwrite-modified).
With --last-copy-date it is a delta migration (<timestamp>-delta-migration): only objects modified on/after the date are
listed; with "auto" after a migration, the files that migration did not copy are carried into the delta's first chunks.
  --inventory-source <s>      How the source is listed: azcopy (default, azcopy --dry-run) or s3 (ListObjectsV2 with the
                              AWS SDK; needs "npm install"; also finds archived objects)
  --chunk-files <n>           Most objects per chunk (default 1000000)
  --chunk-bytes <size>        Most bytes per chunk, e.g. 500GiB or 2TiB (default 1TiB)
  --parallel <n>              azcopy jobs at once (default 10); AZCOPY_CONCURRENCY_VALUE / AZCOPY_BUFFER_GB apply per job
  --max-attempts <n>          Copy attempts per chunk, retries of failed files included (default 5)
  --stop-after <phase>        inventory or chunk: stop there, to look at the analysis or the chunks first
  --migration <dir>           Continue this migration. Without it, and without --source-bucket, the latest one in
                              <output-dir> is shown and you are asked to confirm it (--yes skips the question).
                              --parallel and --max-attempts can be changed when continuing.
  --repeat                    After this migration, run delta migrations one after another (each based on the one
                              before it) until one finds few enough objects to stop the writers and cut over
  --repeat-until <n>          Stop repeating when a delta's inventory has at most n objects (default 10000)
  --repeat-max <n>            At most n delta migrations (default 10)

all commands:
  --output-dir <dir>          Where run directories and state.json go (default ./runs)
  --plan-dir <dir>            Where azcopy keeps its job plan files (default <run>/azcopy-plans);
                              use a disk with plenty of space for tens of millions of files
  --azcopy-path <path>        azcopy binary (default: "azcopy" on PATH)
  --azcopy-arg <flag>         Extra raw azcopy flag, repeatable, e.g. --azcopy-arg=--cap-mbps=2000
  --dry-run                   Print the azcopy command without running it
  --run <run dir>             retry / resume: the run to work on. Without it the latest run in <output-dir> is shown
                              and you are asked to confirm it.
  -y, --yes                   retry / resume: accept the latest run without asking
  -h, --help

Tuning: azcopy reads AZCOPY_CONCURRENCY_VALUE, AZCOPY_BUFFER_GB, ... from the environment.
Exit codes: 0 ok, 1 completed with failed files, 2 job failed, 64 usage error, 130 interrupted.
`;

const options = {
  'source-bucket': { type: 'string' },
  'source-prefix': { type: 'string' },
  'source-region': { type: 'string' },
  'target-sas-url': { type: 'string' },
  'last-copy-date': { type: 'string' },
  'overwrite-modified': { type: 'boolean' },
  'output-dir': { type: 'string' },
  'plan-dir': { type: 'string' },
  'azcopy-path': { type: 'string' },
  'azcopy-arg': { type: 'string', multiple: true },
  'dry-run': { type: 'boolean' },
  run: { type: 'string' },
  'inventory-source': { type: 'string' },
  'chunk-files': { type: 'string' },
  'chunk-bytes': { type: 'string' },
  parallel: { type: 'string' },
  'max-attempts': { type: 'string' },
  'stop-after': { type: 'string' },
  repeat: { type: 'boolean' },
  'repeat-until': { type: 'string' },
  'repeat-max': { type: 'string' },
  migration: { type: 'string' },
  yes: { type: 'boolean', short: 'y' },
  help: { type: 'boolean', short: 'h' },
};

const COMMANDS = { copy: copyCommand, list: listCommand, retry: retryCommand, resume: resumeCommand, migrate: migrateCommand };
const camelCase = (s) => s.replace(/-([a-z])/g, (_, c) => c.toUpperCase());

async function main() {
  let parsed;
  try {
    parsed = parseArgs({ args: process.argv.slice(2), options, allowPositionals: true });
  } catch (err) {
    process.stderr.write(`${err.message}\n\n${HELP}`);
    return EXIT.USAGE;
  }
  const [name] = parsed.positionals;
  if (parsed.values.help) {
    process.stdout.write(HELP);
    return EXIT.OK;
  }
  const interactive = process.stdin.isTTY && process.stdout.isTTY;
  if (name === 'ui' || (!name && interactive)) {
    if (!interactive) {
      process.stderr.write('The ui command needs an interactive terminal (stdin and stdout must be a TTY).\n');
      return EXIT.USAGE;
    }
    const baseKeys = ['output-dir', 'plan-dir', 'azcopy-path', 'azcopy-arg', 'dry-run'];
    const baseOpts = Object.fromEntries(baseKeys.filter((k) => k in parsed.values).map((k) => [camelCase(k), parsed.values[k]]));
    // Everything else given on the command line is offered to the wizard instead of being asked for again.
    const presets = Object.fromEntries(Object.entries(parsed.values).filter(([k]) => !baseKeys.includes(k) && !['help', 'yes', 'run', 'migration'].includes(k)).map(([k, v]) => [camelCase(k), v]));
    try {
      return await runUi(baseOpts, presets);
    } catch (err) {
      process.stderr.write(`Unexpected error: ${err.stack ?? err}\n`);
      return EXIT.FAILED;
    }
  }
  if (!COMMANDS[name]) {
    process.stderr.write(`${name ? `Unknown command "${name}".` : 'Missing command.'}\n\n${HELP}`);
    return EXIT.USAGE;
  }

  const opts = Object.fromEntries(Object.entries(parsed.values).map(([k, v]) => [camelCase(k), v]));
  try {
    return await COMMANDS[name](opts);
  } catch (err) {
    if (err instanceof UsageError) {
      process.stderr.write(`Error: ${err.message}\n`);
      return EXIT.USAGE;
    }
    process.stderr.write(`Unexpected error: ${err.stack ?? err}\n`);
    return EXIT.FAILED;
  }
}

process.exitCode = await main();
