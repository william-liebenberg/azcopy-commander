import path from 'node:path';
import process from 'node:process';

/*
 * The command line that runs a migration started from the wizard again, without the wizard: the options it passes
 * to migrateCommand, as `azcopy-commander migrate --...`. The secrets are never in it: the AWS keys and the SAS URL
 * come from the environment (AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_SESSION_TOKEN,
 * AZCOPY_COMMANDER_TARGET_SAS_URL).
 */

const CLI = 'azcopy-commander';

/** The options of migrateCommand that are on the command line, in the order of `migrate --help`. */
const OPTIONS = [
  ['migration', 'string'],
  ['sourceBucket', 'string'],
  ['sourcePrefix', 'string'],
  ['sourceRegion', 'string'],
  ['lastCopyDate', 'string'],
  ['overwriteModified', 'boolean'],
  ['chunkFiles', 'string'],
  ['chunkBytes', 'string'],
  ['chunkMinutes', 'string'],
  ['parallel', 'string'],
  ['concurrency', 'string'],
  ['blockSize', 'string'],
  ['maxAttempts', 'string'],
  ['stopAfter', 'string'],
  ['repeat', 'boolean'],
  ['repeatUntil', 'string'],
  ['repeatMax', 'string'],
  ['outputDir', 'string'],
  ['dryRun', 'boolean'],
];

const kebab = (s) => s.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);

/**
 * Quotes a value for the shell when it needs it: PowerShell on Windows ('...' with '' for a quote), a POSIX shell
 * elsewhere ('...' with '\'' for a quote).
 */
export function shellQuote(value, platform = process.platform) {
  const text = String(value);
  const windows = platform === 'win32';
  if (text && (windows ? /^[\w@%+=:,./\\-]+$/ : /^[\w@%+=:,./-]+$/).test(text)) return text;
  return windows ? `'${text.replace(/'/g, "''")}'` : `'${text.replace(/'/g, "'\\''")}'`;
}

/**
 * `azcopy-commander migrate ...` for the options `opts` of migrateCommand. The folders are made absolute, so the
 * command works from any directory; the target SAS URL, the views and the other internal options are left out.
 */
export function migrateCommandLine(opts, { platform = process.platform } = {}) {
  const values = { ...opts, outputDir: path.resolve(opts.outputDir ?? 'runs') };
  if (values.migration) values.migration = path.resolve(values.migration);
  const args = [CLI, 'migrate'];
  for (const [key, type] of OPTIONS) {
    const value = values[key];
    if (type === 'boolean') {
      if (value === true) args.push(`--${kebab(key)}`);
    } else if (value !== undefined && value !== null && String(value) !== '') {
      args.push(`--${kebab(key)}`, shellQuote(value, platform));
    }
  }
  return args.join(' ');
}
