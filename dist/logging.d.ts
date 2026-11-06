/**
 * The severity label that a log line records.
 */
export type LogLevel = 'info' | 'warn' | 'error';
/**
 * Returns the `logs` directory under the directory from `getSuperpowersDir`.
 *
 * Creates the directory when the directory is missing.
 */
export declare function getLogDir(): string;
/**
 * Returns the path of the sync log, `episodic-memory.log`.
 *
 * Creates the log directory when the directory is missing.
 */
export declare function getSyncLogPath(): string;
/** Dedicated log for SessionStart hook failures (upstream #94). */
export declare function getSyncErrorsLogPath(): string;
/**
 * Dedicated log for `learn` runs.
 *
 * A learning run is long, detached from a terminal and spends money, so its
 * progress goes to its own file rather than into the sync log where it would
 * interleave with every session start.
 */
export declare function getLearnLogPath(): string;
/** Lock file serializing background syncs; lives beside the embedding-migration lock. */
export declare function getSyncLockPath(): string;
/**
 * Rotate the sync log when it exceeds `maxBytes` so it can't grow without bound
 * (F4 — it had reached megabytes with thousands of appended sync-start lines).
 * Keeps a single `.1` backup. Best-effort: any failure leaves the log as-is.
 */
export declare function rotateSyncLogIfNeeded(maxBytes?: number): void;
/**
 * Formats one log line. The line contains a UTC timestamp, the level in brackets, the message, and a newline.
 *
 * The function does not escape the message. A newline in the message starts a new line in the file.
 */
export declare function formatLogLine(level: LogLevel, message: string): string;
/**
 * Appends one line to the sync log, using the path from `getSyncLogPath`.
 *
 * The write is synchronous. The call throws when the write fails.
 */
export declare function appendLogLine(level: LogLevel, message: string): void;
