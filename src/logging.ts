import fs from 'fs';
import path from 'path';
import { getSuperpowersDir, getIndexDir } from './paths.js';

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
 * Returns the path of the sync log, `episodic-memory.log`.
 *
 * Creates the log directory when the directory is missing.
 */
export function getSyncLogPath(): string {
  return path.join(getLogDir(), 'episodic-memory.log');
}

/** Dedicated log for SessionStart hook failures (upstream #94). */
export function getSyncErrorsLogPath(): string {
  return path.join(getSuperpowersDir(), 'sync-errors.log');
}

/**
 * Dedicated log for `learn` runs.
 *
 * A learning run is long, detached from a terminal and spends money, so its
 * progress goes to its own file rather than into the sync log where it would
 * interleave with every session start.
 */
export function getLearnLogPath(): string {
  return path.join(getLogDir(), 'learn.log');
}

/** Lock file serializing background syncs; lives beside the embedding-migration lock. */
export function getSyncLockPath(): string {
  return path.join(getIndexDir(), '.sync.lock');
}

/**
 * Rotate the sync log when it exceeds `maxBytes` so it can't grow without bound
 * (F4 — it had reached megabytes with thousands of appended sync-start lines).
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
