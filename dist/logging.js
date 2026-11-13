import fs from 'fs';
import path from 'path';
import { getSuperpowersDir, getIndexDir } from './paths.js';
/**
 * Returns the `logs` directory under the directory from `getSuperpowersDir`.
 *
 * Creates the directory when the directory is missing.
 */
export function getLogDir() {
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
 * A learning run is long, detached from a terminal, and spends money.
 * So its progress goes to its own file, not into the sync log.
 * Progress in the sync log would interleave with every session start.
 */
export function getLearnLogPath() {
    return path.join(getLogDir(), 'learn.log');
}
/**
 * Return the path of the lock file that the sync worker, the index commands and the backfill share.
 *
 * The file sits in the index folder, beside the embedding-migration lock. The name is an on-disk contract. An
 * installed sync of an older version must contend with the index commands of a newer version.
 */
export function getSyncLockPath() {
    return path.join(getIndexDir(), '.sync.lock');
}
/**
 * Rotate the sync log when it exceeds `maxBytes` so it can't grow without bound.
 * The log had reached megabytes, with thousands of appended sync-start lines (F4).
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
/**
 * Formats one log line. The line contains a UTC timestamp, the level in brackets, the message, and a newline.
 *
 * The function does not escape the message. A newline in the message starts a new line in the file.
 */
export function formatLogLine(level, message) {
    return `${new Date().toISOString()} [${level}] ${message}\n`;
}
/**
 * Appends one line to the sync log, using the path from `getSyncLogPath`.
 *
 * The write is synchronous. The call throws when the write fails.
 */
export function appendLogLine(level, message) {
    fs.appendFileSync(getSyncLogPath(), formatLogLine(level, message), 'utf-8');
}
