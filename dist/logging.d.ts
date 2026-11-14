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
 * Returns the path of the sync log, and creates nothing. A reader (doctor) uses this function.
 * A writer uses `getSyncLogPath`, which creates the log directory.
 */
export declare function syncLogPath(): string;
/** Returns the path of the hook error log, and creates nothing. A writer uses `getSyncErrorsLogPath`. */
export declare function syncErrorsLogPath(): string;
/**
 * Returns the path of the sync log, `episodic-memory.log`.
 *
 * Creates the log directory when the directory is missing.
 */
export declare function getSyncLogPath(): string;
/** Dedicated log for SessionStart hook failures (upstream #94). Creates the config directory. */
export declare function getSyncErrorsLogPath(): string;
/**
 * Dedicated log for `learn` runs.
 *
 * A learning run is long, detached from a terminal, and spends money.
 * So its progress goes to its own file, not into the sync log.
 * Progress in the sync log would interleave with every session start.
 */
export declare function getLearnLogPath(): string;
/**
 * Return the path of the lock file that the sync worker, the index commands and the backfill share.
 *
 * The file sits in the index folder, beside the embedding-migration lock. The name is an on-disk contract. An
 * installed sync of an older version must contend with the index commands of a newer version.
 */
export declare function getSyncLockPath(): string;
/**
 * Rotate the sync log when it exceeds `maxBytes` so it can't grow without bound.
 * The log had reached megabytes, with thousands of appended sync-start lines (F4).
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
