/**
 * Generic cross-process file lock with PID-liveness + age-based stale recovery.
 *
 * Extracted from the embedding-migration lock so both the embedding migration and
 * the background sync can serialize independently. Dependency-free (fs/path only)
 * so it can be imported from sync-cli's light-import prologue without dragging in
 * the heavy native stack.
 *
 * Stale recovery handles two failure modes:
 *  - the holder process died without releasing (PID no longer alive), and
 *  - the holder's PID was recycled by an unrelated process, which would otherwise
 *    make a dead lock look "alive" forever (F12) — covered by an mtime-age cap.
 */
import fs from 'fs';
import path from 'path';

export interface LockHandle {
  path: string;
  fd: number;
}

/** Default age after which a lock is stealable regardless of PID liveness. */
const DEFAULT_STALE_MS = 60 * 60 * 1000; // 1 hour

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: any) {
    // EPERM means the process exists but we can't signal it → alive.
    return err.code === 'EPERM';
  }
}

function tryCreate(lockPath: string): LockHandle | null {
  try {
    const fd = fs.openSync(lockPath, 'wx'); // O_EXCL: only one creator wins
    fs.writeSync(fd, String(process.pid));
    return { path: lockPath, fd };
  } catch (err: any) {
    if (err.code === 'EEXIST') return null;
    throw err;
  }
}

/**
 * Decide whether an existing lock can be stolen, re-reading current file state so
 * a fresh lock created by a racing process between our EEXIST and this check is not
 * stolen out from under it (F5).
 */
function isLockStealable(lockPath: string, staleMs: number): boolean {
  // Age-based staleness first — covers PID reuse.
  try {
    const ageMs = Date.now() - fs.statSync(lockPath).mtimeMs;
    if (ageMs > staleMs) return true;
  } catch {
    return true; // can't stat → treat as stealable
  }

  // PID-liveness staleness.
  let holderPid: number;
  try {
    holderPid = parseInt(fs.readFileSync(lockPath, 'utf-8').trim(), 10);
  } catch {
    return true;
  }
  if (!Number.isFinite(holderPid) || holderPid <= 0) return true;
  return !isProcessAlive(holderPid);
}

/**
 * Acquire an exclusive lock at `lockPath`. Returns a handle, or null if a live,
 * non-stale holder exists.
 */
export function acquireLock(lockPath: string, staleMs = DEFAULT_STALE_MS): LockHandle | null {
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });

  // Fast path: nobody holds it.
  const created = tryCreate(lockPath);
  if (created) return created;

  // Held — only proceed if it looks stale.
  if (!isLockStealable(lockPath, staleMs)) return null;

  // Steal atomically: remove then O_EXCL-create. Only one racer's create wins; we
  // read the PID back and confirm it's ours to settle the race definitively.
  try { fs.unlinkSync(lockPath); } catch {}
  const stolen = tryCreate(lockPath);
  if (!stolen) return null;
  try {
    const owner = parseInt(fs.readFileSync(lockPath, 'utf-8').trim(), 10);
    if (owner !== process.pid) {
      try { fs.closeSync(stolen.fd); } catch {}
      return null;
    }
  } catch {
    return null;
  }
  return stolen;
}

export function releaseLock(handle: LockHandle): void {
  try { fs.closeSync(handle.fd); } catch {}
  // Only remove the lock file if it still holds OUR pid. If our lock was stolen
  // while we ran (we exceeded the stale window, or a PID-liveness false negative),
  // a different process now legitimately owns the file — unlinking it here would
  // delete their live lock and break mutual exclusion.
  try {
    const owner = parseInt(fs.readFileSync(handle.path, 'utf-8').trim(), 10);
    if (owner === process.pid) fs.unlinkSync(handle.path);
  } catch {
    // File already gone or unreadable — nothing to release.
  }
}
