import { fork } from 'node:child_process';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { codeOf } from './blob-copy.js';

/*
 * The copy of objects in child processes, so that small objects use more than one CPU core: the SDK work of each
 * object (the S3 HEAD, the presigned URL, the Put Blob From URL, TLS) costs about 2 ms of CPU, so one process tops out
 * at a few hundred objects per second however many copies run at once. Worker threads were measured too: in one
 * process, 4 of them needed about twice the CPU per object, and copied much less.
 *
 *   const copiers = await startCopyProcesses({ processes: 3, data, onFatal })
 *   await copiers.copy(record, { signal })   createCopier's copy, run in the process with the fewest copies in flight
 *   await copiers.close()
 *
 * Each process (copy-process.js) gets `data` ({ s3, target, copier }: the settings of createS3, the target of
 * containerFor and the other settings of createCopier) in its first message, so the SAS is never on a command line or
 * in an environment; the AWS credentials come from the environment it inherits. It makes its own S3 client and
 * ContainerClient and answers with serveCopies. The main process keeps the listing, migration.json, the files of each
 * attempt (copyChunk) and the view. A copy that fails rejects with an Error that has the message and the code (see
 * codeOf) of the process's error: what copyChunk records of it. A process that stops is fatal: `onFatal(error)` is
 * called, then its copies reject. Ctrl+C reaches the processes too: they leave it to the main process, which aborts the
 * copies; a process ends when the main process closes it or goes away.
 */

const PROCESS = fileURLToPath(new URL('./copy-process.js', import.meta.url));

/** The copy processes by default: one per chunk copied at once, at most the CPU cores but one (0: in the main process). */
export const defaultCopyProcesses = (parallel, cores = os.availableParallelism()) => Math.max(0, Math.min(parallel, cores - 1));

const abortError = () => Object.assign(new Error('The operation was aborted.'), { name: 'AbortError' });

/** What a process sends back of an error: what copyChunk records of it. */
const errorData = (err) => ({ message: err?.message ?? String(err), code: codeOf(err) });

/**
 * The side of a copy process: waits for `{ start: data }`, makes the copy with `makeCopy(data)` and sends
 * `{ ready: true }` (or `{ failed: message }`, then exits); copies each `{ id, record }` and answers `{ id, value }` or
 * `{ id, error }`; `{ abort: id }` aborts a copy in flight.
 */
export function serveCopies(makeCopy) {
  process.on('SIGINT', () => {}); // Ctrl+C: the main process aborts the copies, then closes this one
  process.on('disconnect', () => process.exit(0)); // closed, or the main process went away
  const running = new Map(); // id -> AbortController
  let copy = null;
  process.on('message', async ({ start, id, record, abort }) => {
    if (start) {
      try {
        copy = await makeCopy(start);
        process.send({ ready: true });
      } catch (err) {
        process.send({ failed: err?.message ?? String(err) }, () => process.exit(1));
      }
    } else if (abort !== undefined) {
      running.get(abort)?.abort();
    } else {
      const controller = new AbortController();
      running.set(id, controller);
      try {
        process.send({ id, value: await copy(record, { signal: controller.signal }) });
      } catch (err) {
        process.send({ id, error: errorData(err) });
      } finally {
        running.delete(id);
      }
    }
  });
}

/** Starts `processes` copy processes (see above) and resolves once each is ready; `file` is the module they run. */
export async function startCopyProcesses({ processes, data, onFatal, file = PROCESS }) {
  const pending = new Map(); // id -> { copier, resolve, reject }
  let nextId = 1;
  let closing = false;

  /** The copy `id` ended: `end(p)` resolves or rejects it. */
  const settle = (id, end) => {
    const p = pending.get(id);
    if (!p) return;
    pending.delete(id);
    p.copier.busy--;
    end(p);
  };

  const all = Array.from({ length: processes }, () => {
    // No inherited --inspect and the like; stderr is kept to explain a process that stops.
    const child = fork(file, [], { execArgv: [], stdio: ['ignore', 'ignore', 'pipe', 'ipc'], windowsHide: true });
    const copier = { child, busy: 0, live: false, stopped: false, stderr: '' };
    child.stderr.setEncoding('utf8').on('data', (text) => (copier.stderr = (copier.stderr + text).slice(-2000)));
    copier.ready = new Promise((resolve, reject) => {
      const stopped = (err) => {
        if (copier.stopped) return; // 'error' can be followed by 'exit'
        copier.stopped = true;
        if (!copier.live) reject(err); // while it starts: startCopyProcesses rejects
        else if (!closing) onFatal?.(err); // first, so that the copies below end as interrupted
        copier.live = false;
        for (const [id, p] of pending) if (p.copier === copier) settle(id, () => p.reject(err));
      };
      child.on('message', (msg) => {
        if (msg.ready) {
          copier.live = true;
          resolve();
        } else if (msg.failed) {
          stopped(new Error(msg.failed));
        } else if (msg.error) {
          settle(msg.id, (p) => p.reject(Object.assign(new Error(msg.error.message), msg.error)));
        } else {
          settle(msg.id, (p) => p.resolve(msg.value));
        }
      });
      child.on('error', stopped);
      child.on('exit', (code, signal) => {
        const error = copier.stderr.split('\n').find((l) => /^[A-Za-z]*Error\b/.test(l.trim()))?.trim(); // of an uncaught error
        stopped(new Error(`A copy process stopped (${signal ?? `exit code ${code}`})${error ? `: ${error}` : ''}.`));
      });
    });
    child.send({ start: data });
    return copier;
  });

  const close = async () => {
    closing = true;
    await Promise.all(
      all.map((c) => {
        if (c.child.exitCode !== null || c.child.signalCode !== null) return undefined;
        const exited = new Promise((resolve) => c.child.once('exit', resolve));
        if (c.child.connected) c.child.disconnect(); // the process exits (see serveCopies)
        else c.child.kill();
        return exited;
      }),
    );
  };
  try {
    await Promise.all(all.map((c) => c.ready));
  } catch (err) {
    await close();
    throw err;
  }

  return {
    close,
    copy(record, { signal } = {}) {
      if (signal?.aborted) return Promise.reject(abortError());
      const copier = all.reduce((best, c) => (c.live && c.child.connected && (!best || c.busy < best.busy) ? c : best), null);
      if (!copier) return Promise.reject(new Error('No copy process is running.'));
      const id = nextId++;
      return new Promise((resolve, reject) => {
        const onAbort = () => copier.child.connected && copier.child.send({ abort: id });
        signal?.addEventListener('abort', onAbort, { once: true });
        const ended = (end) => (value) => {
          signal?.removeEventListener('abort', onAbort);
          end(value);
        };
        pending.set(id, { copier, resolve: ended(resolve), reject: ended(reject) });
        copier.busy++;
        copier.child.send({ id, record });
      });
    },
  };
}
