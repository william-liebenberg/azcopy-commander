import process from 'node:process';
import { EXIT } from '../job.js';
import { withCoalescedOutput } from './output.js';
import { runWizard } from './wizard.js';

/**
 * Starts the interactive wizard. @clack/prompts is only loaded here, so the other commands
 * keep working without `npm install`. `baseOpts` carries the shared CLI options (--output-dir, ...), `presets` the
 * others given on the command line (--source-bucket, --parallel, ...).
 */
export async function runUi(baseOpts = {}, presets = {}) {
  let prompts;
  try {
    prompts = await import('@clack/prompts');
  } catch (err) {
    if (err?.code !== 'ERR_MODULE_NOT_FOUND') throw err;
    process.stderr.write('The terminal UI needs its dependencies: run `npm install` in the azcopy-commander folder first.\n');
    return EXIT.USAGE;
  }
  // One write per redraw instead of several: removes the flicker on keypresses (see output.js).
  prompts = withCoalescedOutput(prompts, process.stdout);
  return runWizard({ prompts, env: process.env, out: process.stdout, err: process.stderr, baseOpts, presets });
}
