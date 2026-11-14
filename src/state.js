import fs from 'node:fs';
import path from 'node:path';
import { writeFileAtomic } from './files.js';

/*
 * state.json remembers when the last copy of each source->target pair started, so a later
 * delta run can use `--last-copy-date auto`. Shape: { "<sourceBase> -> <destBase>": { startedAt, runDir } }
 */

export const stateKey = (sourceBase, destBase) => `${sourceBase} -> ${destBase}`;

export function readState(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return {};
    throw new Error(`Cannot read state file ${file}: ${err.message}`);
  }
}

export function saveState(file, key, entry) {
  const state = { ...readState(file), [key]: entry };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  writeFileAtomic(file, `${JSON.stringify(state, null, 2)}\n`); // write + rename so a crash never leaves a half-written state file
}
