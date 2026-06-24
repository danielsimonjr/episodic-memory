export interface LockHandle {
    path: string;
    fd: number;
}
export declare function isProcessAlive(pid: number): boolean;
/**
 * Acquire an exclusive lock at `lockPath`. Returns a handle, or null if a live,
 * non-stale holder exists.
 */
export declare function acquireLock(lockPath: string, staleMs?: number): LockHandle | null;
export declare function releaseLock(handle: LockHandle): void;
