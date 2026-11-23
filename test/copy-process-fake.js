import { serveCopies } from '../src/copy-processes.js';

/*
 * A copy process for copy-processes.test.js, with a fake copy: the path of a record says what it does.
 *   fail   rejects with an Azure-like error      wait   ends when the copy is aborted
 *   exit   stops the process                      any other path is copied in 20 ms, by this process
 * The settings it is sent: `failStart` makes its start fail, `crash` makes it stop with an uncaught error.
 */

serveCopies(async ({ failStart, crash }) => {
  if (failStart) throw new Error('the SDK cannot be loaded');
  if (crash) return new Promise(() => setImmediate(() => { throw new TypeError('crashed while starting'); }));
  return async (record, { signal }) => {
    if (record.path === 'fail') throw Object.assign(new Error('The specified container does not exist.'), { statusCode: 404, details: { errorCode: 'ContainerNotFound' } });
    if (record.path === 'wait') return new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))));
    if (record.path === 'exit') process.exit(3);
    await new Promise((resolve) => setTimeout(resolve, 20));
    return { result: 'copied', bytes: record.size, pid: process.pid };
  };
});
