/**
 * The output of the command line: lines for scripts and logs, and on a terminal one status line redrawn in place.
 * PlainMigrationView (migration-view.js) builds on it; it implements the view methods a migration calls:
 *
 *   message(level, text)      a warning or error (already redacted)
 *   failure(...)              one more failed file (not printed: it is in the chunk's failed list)
 *   log(level, text)          a line that is only logged; already redacted
 *   close()                   release timers / the cursor; always called, also after an error
 */
export class PlainView {
  constructor(out) {
    this.out = out;
    this.statusShown = false;
  }

  print(text) {
    if (this.statusShown) this.out.write('\r\x1b[K');
    this.statusShown = false;
    this.out.write(`${text}\n`);
  }

  status(text) {
    if (!this.out.isTTY) return;
    const width = (this.out.columns ?? 160) - 1;
    this.out.write(`\r\x1b[K${text.slice(0, width)}`);
    this.statusShown = true;
  }

  message(level, text) {
    this.print(text);
  }

  failure() {}

  log() {} // the plain output stays as it is: these lines are in the logs

  close() {}
}
