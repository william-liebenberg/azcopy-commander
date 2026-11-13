import fs from 'node:fs';

/*
 * On Windows, a rename fails with EPERM, EACCES or EBUSY while another process holds the file open without sharing
 * its deletion: an antivirus or the search indexer that reads a file just written, a backup or sync tool. The hold is
 * short, so the rename is tried again for a while (as graceful-fs does) before the error is thrown.
 */
const TRANSIENT = new Set(['EPERM', 'EACCES', 'EBUSY']);
export const RENAME_RETRY = { totalMs: 10_000, maxDelayMs: 100 };

const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/** fs.renameSync, tried again while the error is one of a file held open for a moment (on Windows). */
export function renameSync(from, to, { totalMs = RENAME_RETRY.totalMs, maxDelayMs = RENAME_RETRY.maxDelayMs } = {}) {
  const start = Date.now();
  for (let delay = 0; ; delay = Math.min(delay + 10, maxDelayMs)) {
    try {
      fs.renameSync(from, to);
      return;
    } catch (err) {
      if (!TRANSIENT.has(err.code) || Date.now() - start + delay > totalMs) throw err;
    }
    sleepSync(delay);
  }
}

/** Writes `<file>.tmp` and renames it to `file`, so a crash never leaves a half-written file. */
export function writeFileAtomic(file, content) {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, content);
  renameSync(tmp, file);
}
