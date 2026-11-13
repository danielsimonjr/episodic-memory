/** Attempts for one operation. The waits between the attempts are 20, 40, 80 and 160 ms. */
export declare const RETRY_ATTEMPTS = 5;
/** The wait in milliseconds after the failed attempt `attempt` (0-based). */
export declare function retryDelayMs(attempt: number): number;
/** Block the thread for `ms` milliseconds without a busy loop. */
export declare function sleepSync(ms: number): void;
/** True for the error codes of a Windows sharing violation. */
export declare function isSharingViolation(error: unknown): boolean;
/**
 * Rename `from` to `to`. Retry a sharing violation up to `RETRY_ATTEMPTS` times.
 *
 * @throws the last `EPERM` or `EBUSY` error when every attempt fails
 * @throws any other error at once
 */
export declare function renameWithRetry(from: string, to: string): void;
