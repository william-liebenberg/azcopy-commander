import { UsageError } from './errors.js';

/**
 * Loads an SDK package (`@aws-sdk/client-s3`, `@azure/storage-blob`, ...). A package that is not installed is a usage
 * error that says what to do, not a stack trace.
 */
export async function loadSdk(name) {
  try {
    return await import(name);
  } catch (err) {
    if (err?.code !== 'ERR_MODULE_NOT_FOUND') throw err;
    throw new UsageError(`${name} is not installed: run \`npm install\` in the azcopy-commander folder first.`);
  }
}
