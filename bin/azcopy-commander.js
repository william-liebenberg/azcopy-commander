#!/usr/bin/env node
import process from 'node:process';
import { parseArgs } from 'node:util';
import { listCommand, UsageError } from '../src/commands.js';
import { EXIT } from '../src/errors.js';
import { migrateCommand } from '../src/migration.js';
import { runUi } from '../src/ui/index.js';

const HELP = `azcopy-commander - append-only S3 -> Azure Blob migration, server-side with the Azure SDK

Usage:
  azcopy-commander ui                                                interactive wizard (also: no command in a terminal)
  azcopy-commander migrate --source-bucket <bucket> --target-sas-url <url> [options]   start a migration
  azcopy-commander migrate [--migration <dir>] --target-sas-url <url>                  continue one
  azcopy-commander list    --source-bucket <bucket> [--source-prefix <p>] [--source-region <r>] [--last-copy-date <d>]
                                                                    print the objects of the source (saves nothing)

The ui command asks for the bucket (name or ARN), the AWS keys and the SAS URL (hidden input, or taken from the
environment), lets you pick an earlier migration for a delta or to continue it, then runs the same commands. Secrets
stay in memory only. Options: --output-dir, --dry-run. Any other option given with it (--source-bucket,
--source-region, --parallel, --chunk-files, ...) is shown and offered to the wizard, which then does not ask for it again.

Credentials are read from the environment only:
  AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY [, AWS_SESSION_TOKEN]   S3 read access (list, HEAD, presigned GET URLs)
  AZCOPY_COMMANDER_TARGET_SAS_URL                                  alternative to --target-sas-url

migrate lists the source with S3 ListObjectsV2 into chunk files and copies each chunk as soon as it is closed, while
the listing goes on: Azure reads every object from a presigned S3 URL (Put Blob From URL; Put Block From URL above
--block-size), so no data passes through this machine. Everything is recorded in <output-dir>/<timestamp>-migration,
so it can be stopped (Ctrl+C) and continued: the listing starts again after the last closed chunk.
  --source-bucket <name>      Source S3 bucket: a name or an ARN (arn:aws:s3:::bucket[/prefix]) (required)
  --source-prefix <path>      Only copy keys under this sub path (keys keep their layout in the container)
  --source-region <region>    The bucket's region (e.g. ap-southeast-2); without it, it is asked from S3 (HeadBucket)
  --target-sas-url <url>      Container SAS URL with write permission (a directory after the container is allowed)
  --last-copy-date <date>     Delta migration (<timestamp>-delta-migration): only objects modified on/after this date.
                              ISO 8601, e.g. 2026-01-31 or 2026-01-31T14:30:00Z (no zone = UTC). "auto" = the start of
                              the previous migration recorded in <output-dir>/state.json, minus 10 minutes; the files
                              that migration did not copy are carried into the delta's first chunks.
  --overwrite-modified        Also replace an existing blob when the S3 object is newer. Default is append-only:
                              existing blobs are never touched. Nothing is ever deleted.
  --chunk-files <n>           Most objects per chunk (default 100000)
  --chunk-bytes <size>        Most bytes per chunk, e.g. 500GiB or 2TiB (default 1TiB)
  --chunk-minutes <n>         Close a chunk that has objects after n minutes (default 15), so a delta copies early
  --parallel <n>              Chunks copied at once (default 4)
  --concurrency <n>           Objects copied at once in each chunk (default 32)
  --block-size <size>         Above this size an object is copied in blocks (default 256MiB)
  --max-attempts <n>          Copy attempts per chunk, retries of failed files included (default 5)
  --stop-after inventory      List into chunks and analyse, copy nothing (continue the migration to copy)
  --migration <dir>           Continue this migration. Without it, and without --source-bucket, the latest one in
                              <output-dir> is shown and you are asked to confirm it (--yes skips the question).
                              --parallel, --concurrency and --max-attempts can be changed when continuing.
  --repeat                    After this migration, run delta migrations one after another (each based on the one
                              before it) until one finds few enough objects to stop the writers and cut over
  --repeat-until <n>          Stop repeating when a delta lists at most n objects (default 10000)
  --repeat-max <n>            At most n delta migrations (default 10)

all commands:
  --output-dir <dir>          Where migration folders and state.json go (default ./runs)
  --dry-run                   Print what would be done without doing it
  -y, --yes                   Continue the latest migration without asking
  -h, --help

Exit codes: 0 ok, 1 completed with failed files, 2 failed, 64 usage error, 130 interrupted.
`;

const options = {
  'source-bucket': { type: 'string' },
  'source-prefix': { type: 'string' },
  'source-region': { type: 'string' },
  'target-sas-url': { type: 'string' },
  'last-copy-date': { type: 'string' },
  'overwrite-modified': { type: 'boolean' },
  'output-dir': { type: 'string' },
  'dry-run': { type: 'boolean' },
  'chunk-files': { type: 'string' },
  'chunk-bytes': { type: 'string' },
  'chunk-minutes': { type: 'string' },
  parallel: { type: 'string' },
  concurrency: { type: 'string' },
  'block-size': { type: 'string' },
  'max-attempts': { type: 'string' },
  'stop-after': { type: 'string' },
  repeat: { type: 'boolean' },
  'repeat-until': { type: 'string' },
  'repeat-max': { type: 'string' },
  migration: { type: 'string' },
  yes: { type: 'boolean', short: 'y' },
  help: { type: 'boolean', short: 'h' },
};

const COMMANDS = { list: listCommand, migrate: migrateCommand };
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
    const baseKeys = ['output-dir', 'dry-run'];
    const baseOpts = Object.fromEntries(baseKeys.filter((k) => k in parsed.values).map((k) => [camelCase(k), parsed.values[k]]));
    // Everything else given on the command line is offered to the wizard instead of being asked for again.
    const presets = Object.fromEntries(Object.entries(parsed.values).filter(([k]) => !baseKeys.includes(k) && !['help', 'yes', 'migration'].includes(k)).map(([k, v]) => [camelCase(k), v]));
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