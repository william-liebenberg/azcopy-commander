/** Bad user input / environment. The CLI prints the message and exits with code 64 (no stack trace). */
export class UsageError extends Error {}

export const EXIT = { OK: 0, PARTIAL: 1, FAILED: 2, USAGE: 64, INTERRUPTED: 130 };
