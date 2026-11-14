import fs from 'fs';
import path from 'path';
import { getSuperpowersDir, getIndexDir, superpowersDirPath } from './paths.js';

/**
 * The severity label that a log line records.
 */
export type LogLevel = 'info' | 'warn' | 'error';

/**
 * Returns the `logs` directory under the directory from `getSuperpowersDir`.
 *
 * Creates the directory when the directory is missing.
 */
export function getLogDir(): string {
  const dir = path.join(getSuperpowersDir(), 'logs');
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
}

/**
 * Returns the path of the sync log, and creates nothing. A reader (doctor) uses this function.
 * A writer uses `getSyncLogPath`, which creates the log directory.
 */
export function syncLogPath(): string {
  return path.join(superpowersDirPath(), 'logs', 'episodic-memory.log');
}

/** Returns the path of the hook error log, and creates nothing. A writer uses `getSyncErrorsLogPath`. */
export function syncErrorsLogPath(): string {
  return path.join(superpowersDirPath(), 'sync-errors.log');
}

/**
 * Returns the path of the sync log, `episodic-memory.log`.
 *
 * Creates the log directory when the directory is missing.
 */
export function getSyncLogPath(): string {
  getLogDir();
  return syncLogPath();
}

/** Dedicated log for SessionStart hook failures (upstream #94). Creates the config directory. */
export function getSyncErrorsLogPath(): string {
  getSuperpowersDir();
  return syncErrorsLogPath();
}

/**
 * Dedicated log for `learn` runs.
 *
 * A learning run is long, detached from a terminal, and spends money.
 * So its progress goes to its own file, not into the sync log.
 * Progress in the sync log would interleave with every session start.
 */
export function getLearnLogPath(): string {
  return path.join(getLogDir(), 'learn.log');
}

/**
 * Return the path of the lock file that the sync worker, the index commands and the backfill share.
 *
 * The file sits in the index folder, beside the embedding-migration lock. The name is an on-disk contract. An
 * installed sync of an older version must contend with the index commands of a newer version.
 */
export function getSyncLockPath(): string {
  return path.join(getIndexDir(), '.sync.lock');
}

/**
 * Rotate the sync log when it exceeds `maxBytes` so it can't grow without bound.
 * The log had reached megabytes, with thousands of appended sync-start lines (F4).
 * Keeps a single `.1` backup. Best-effort: any failure leaves the log as-is.
 */
export function rotateSyncLogIfNeeded(maxBytes = 5 * 1024 * 1024): void {
  const logPath = getSyncLogPath();
  try {
    if (fs.statSync(logPath).size <= maxBytes) return;
    const rotated = logPath + '.1';
    try { fs.rmSync(rotated, { force: true }); } catch {}
    fs.renameSync(logPath, rotated);
  } catch {
    // No log yet, or stat/rename failed — nothing to rotate.
  }
}

/**
 * Formats one log line. The line contains a UTC timestamp, the level in brackets, the message, and a newline.
 *
 * The function does not escape the message. A newline in the message starts a new line in the file.
 */
export function formatLogLine(level: LogLevel, message: string): string {
  return `${new Date().toISOString()} [${level}] ${message}\n`;
}

/**
 * Appends one line to the sync log, using the path from `getSyncLogPath`.
 *
 * The write is synchronous. The call throws when the write fails.
 */
export function appendLogLine(level: LogLevel, message: string): void {
  fs.appendFileSync(getSyncLogPath(), formatLogLine(level, message), 'utf-8');
}
