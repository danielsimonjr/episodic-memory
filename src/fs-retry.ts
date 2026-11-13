/**
 * Retry of the file operations that a Windows sharing violation stops for a moment.
 *
 * Another process (a reader, the search indexer, a virus scanner) can hold a file open.
 * A rename over that file then fails with `EPERM` or `EBUSY` until the process closes the file.
 * The callers are synchronous. The wait between attempts blocks the thread.
 */
import fs from 'fs';

/** Attempts for one operation. The waits between the attempts are 20, 40, 80 and 160 ms. */
export const RETRY_ATTEMPTS = 5;

/** The wait in milliseconds after the failed attempt `attempt` (0-based). */
export function retryDelayMs(attempt: number): number {
  return 20 * 2 ** attempt;
}

/** Block the thread for `ms` milliseconds without a busy loop. */
export function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** True for the error codes of a Windows sharing violation. */
export function isSharingViolation(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return code === 'EPERM' || code === 'EBUSY';
}

/**
 * Rename `from` to `to`. Retry a sharing violation up to `RETRY_ATTEMPTS` times.
 *
 * @throws the last `EPERM` or `EBUSY` error when every attempt fails
 * @throws any other error at once
 */
export function renameWithRetry(from: string, to: string): void {
  for (let attempt = 0; ; attempt += 1) {
    try {
      fs.renameSync(from, to);
      return;
    } catch (error) {
      if (!isSharingViolation(error) || attempt + 1 >= RETRY_ATTEMPTS) throw error;
      sleepSync(retryDelayMs(attempt));
    }
  }
}
