export type LogLevel = 'info' | 'warn' | 'error';
export declare function getLogDir(): string;
export declare function getSyncLogPath(): string;
/** Dedicated log for SessionStart hook failures (upstream #94). */
export declare function getSyncErrorsLogPath(): string;
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
