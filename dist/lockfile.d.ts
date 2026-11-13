/**
 * A lock that this process holds. The handle has the lock file path and the open file descriptor.
 */
export interface LockHandle {
    path: string;
    fd: number;
    /** The refresh timer that `keepLockFresh` started. `releaseLock` stops the timer before the close. */
    heartbeat?: NodeJS.Timeout;
}
/**
 * Return true when a process with the given PID exists.
 *
 * The check sends signal 0. Signal 0 tests whether the process exists and delivers nothing. A process that exists but cannot be signaled counts as alive. The PID must be greater than zero.
 */
export declare function isProcessAlive(pid: number): boolean;
/**
 * Return true when a live, non-stale holder has the lock at `lockPath`.
 *
 * The function uses the rule that `acquireLock` uses to steal a lock.
 * A missing file, a dead holder and a lock older than `staleMs` all give false.
 * A file with no PID gives true for 10 seconds, because its holder can still be writing the PID.
 */
export declare function isLockHeld(lockPath: string, staleMs?: number): boolean;
/**
 * Acquire an exclusive lock at `lockPath`.
 * Returns a handle, or null if a live, non-stale holder exists.
 * A lock file with no PID that is younger than 10 seconds also gives null.
 */
export declare function acquireLock(lockPath: string, staleMs?: number): LockHandle | null;
/**
 * Refresh the lock file of a held lock at a fixed interval.
 *
 * A refreshed lock never looks stale while the holder runs. `acquireLock` treats a lock file older than the stale
 * window as stale, also when its PID is alive. A holder that runs longer than the window must therefore refresh the
 * file. The refresh sets the times of the open descriptor. The refresh therefore never touches a lock file that
 * another process created after a takeover. The timer does not keep the process alive. `releaseLock` stops the
 * timer. A second call replaces the timer of the first call.
 *
 * @param handle a lock that `acquireLock` returned
 * @param intervalMs the time between two refreshes; the default is a quarter of the default stale window
 */
export declare function keepLockFresh(handle: LockHandle, intervalMs?: number): void;
/**
 * Acquire a lock, with a refresh of its file until the release.
 *
 * Use the function for a lock whose holder can run longer than the stale window. The sync worker, the index
 * commands, the backfill and the learn run are such holders. The function returns null when `acquireLock` returns
 * null.
 *
 * @param lockPath the lock file path
 * @param staleMs the stale window; the refresh runs four times in each window
 */
export declare function acquireRefreshedLock(lockPath: string, staleMs?: number): LockHandle | null;
/**
 * Release a lock that `acquireLock` returned.
 *
 * The function closes the file descriptor. The function then deletes the lock file only when
 * the file still holds the PID of this process. A lock that another process took over stays on
 * disk. Errors are ignored.
 */
export declare function releaseLock(handle: LockHandle): void;
