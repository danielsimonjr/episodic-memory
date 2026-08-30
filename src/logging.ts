import fs from 'fs';
import path from 'path';
import { getSuperpowersDir, getIndexDir } from './paths.js';

export type LogLevel = 'info' | 'warn' | 'error';

export function getLogDir(): string {
  const dir = path.join(getSuperpowersDir(), 'logs');
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
}

export function getSyncLogPath(): string {
  return path.join(getLogDir(), 'episodic-memory.log');
}

/** Dedicated log for SessionStart hook failures (upstream #94). */
export function getSyncErrorsLogPath(): string {
  return path.join(getSuperpowersDir(), 'sync-errors.log');
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

export function formatLogLine(level: LogLevel, message: string): string {
  return `${new Date().toISOString()} [${level}] ${message}\n`;
}

export function appendLogLine(level: LogLevel, message: string): void {
  fs.appendFileSync(getSyncLogPath(), formatLogLine(level, message), 'utf-8');
}
