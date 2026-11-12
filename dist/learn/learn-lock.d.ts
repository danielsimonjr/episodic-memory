/**
 * One learning run at a time, and the PIDs that the run owns.
 *
 * `.learn.lock` lives in the index directory and goes through `lockfile.ts`.
 * `lockfile.ts` recovers a crashed run's lock with the same PID-liveness and age rules that sync and the embedding migration use.
 * When another run holds the lock, `acquireLock` returns `null`. The return value does not name the holder.
 * This module therefore reads the holder's PID from the file and puts that PID in the error.
 * A message such as "another run holds it" is not actionable. A message such as "pid 4212 holds it" is.
 *
 * The `.learn.pids` file lists the subprocesses that the run currently owns. The file holds one PID per line.
 * The run rewrites the file on every add and remove, and deletes the file on release.
 * The SessionStart orphan reaper reads that file and never touches a live run's processes (spec §7 rule 11).
 * The solver writes its registry here. The CLI owns the lifetime of a run, so the registry lives here, not in `agent-runner.ts`.
 *
 * This module is imported statically by `cli/sync-hook.js`, so it stays light:
 * `fs`, `path`, `../lockfile.js`, `../paths.js` and nothing else.
 */
/** The file name of the learning lock. The lock file lives in the index directory. */
export declare const LEARN_LOCK_NAME = ".learn.lock";
/** The file name of the PID list that a learning run keeps while the run is live. */
export declare const LEARN_PIDS_NAME = ".learn.pids";
/**
 * The code steals a stale lock after two hours.
 * `EPISODIC_MEMORY_LEARN_MAX_MINUTES` bounds a real run (60 by default). So two hours only ever reclaims a lock whose holder is gone.
 */
export declare const LEARN_LOCK_STALE_MS: number;
/** Where a run records the subprocesses that the run owns. */
export interface PidRegistry {
    add(pid: number): void;
    remove(pid: number): void;
}
/** Another live run holds the lock. */
export declare class LearnLockHeld extends Error {
    readonly holderPid: number | null;
    readonly lockPath: string;
    constructor(holderPid: number | null, lockPath: string);
}
/**
 * Returns the path of the learning lock file in `indexDir`.
 *
 * @param indexDir The index directory that holds the lock.
 */
export declare function getLearnLockPath(indexDir: string): string;
/**
 * Returns the path of the PID list file in `indexDir`.
 *
 * @param indexDir The index directory that holds the PID list.
 */
export declare function getLearnPidsPath(indexDir: string): string;
/**
 * Read the PIDs listed in `.learn.pids`.
 *
 * The function returns an empty set when the file is absent or unreadable.
 * The function also returns an empty set when the process named in `.learn.lock` is not alive.
 * A killed run leaves its file behind, and a dead run's PIDs must protect nothing.
 * The age of the lock does not count here. A live step can outlast the steal age, and its children
 * must stay protected.
 * The orphan reaper calls this function at reap time, so the function never throws.
 */
export declare function readLearnPids(indexDir: string): Set<number>;
/**
 * Hold the learning lock for the duration of `fn`.
 *
 * The function releases the lock on every exit path. The function also deletes `.learn.pids` with the lock.
 * A PID file that outlives its run would make the reaper refuse to reap the next run's genuinely orphaned children.
 * A killed run skips that cleanup, so the function also deletes a left-over file when it takes the lock.
 */
export declare function withLearnLock<T>(fn: (pids: PidRegistry) => Promise<T>): Promise<T>;
