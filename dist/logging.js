import fs from 'fs';
import path from 'path';
import { getSuperpowersDir, getIndexDir } from './paths.js';
export function getLogDir() {
    const dir = path.join(getSuperpowersDir(), 'logs');
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
    return dir;
}
export function getSyncLogPath() {
    return path.join(getLogDir(), 'episodic-memory.log');
}
/** Dedicated log for SessionStart hook failures (upstream #94). */
export function getSyncErrorsLogPath() {
    return path.join(getSuperpowersDir(), 'sync-errors.log');
}
/**
 * Dedicated log for `learn` runs.
 *
 * A learning run is long, detached from a terminal and spends money, so its
 * progress goes to its own file rather than into the sync log where it would
 * interleave with every session start.
 */
export function getLearnLogPath() {
    return path.join(getLogDir(), 'learn.log');
}
/** Lock file serializing background syncs; lives beside the embedding-migration lock. */
export function getSyncLockPath() {
    return path.join(getIndexDir(), '.sync.lock');
}
/**
 * Rotate the sync log when it exceeds `maxBytes` so it can't grow without bound
 * (F4 — it had reached megabytes with thousands of appended sync-start lines).
 * Keeps a single `.1` backup. Best-effort: any failure leaves the log as-is.
 */
export function rotateSyncLogIfNeeded(maxBytes = 5 * 1024 * 1024) {
    const logPath = getSyncLogPath();
    try {
        if (fs.statSync(logPath).size <= maxBytes)
            return;
        const rotated = logPath + '.1';
        try {
            fs.rmSync(rotated, { force: true });
        }
        catch { }
        fs.renameSync(logPath, rotated);
    }
    catch {
        // No log yet, or stat/rename failed — nothing to rotate.
    }
}
export function formatLogLine(level, message) {
    return `${new Date().toISOString()} [${level}] ${message}\n`;
}
export function appendLogLine(level, message) {
    fs.appendFileSync(getSyncLogPath(), formatLogLine(level, message), 'utf-8');
}
