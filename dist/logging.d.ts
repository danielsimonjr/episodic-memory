export type LogLevel = 'info' | 'warn' | 'error';
export declare function getLogDir(): string;
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
export declare function formatLogLine(level: LogLevel, message: string): string;
export declare function appendLogLine(level: LogLevel, message: string): void;
