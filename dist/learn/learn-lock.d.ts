/**
 * One learning run at a time, and the PIDs it owns.
 *
 * `.learn.lock` lives in the index directory and goes through `lockfile.ts`, so
 * a crashed run's lock is recovered by the same PID-liveness and age rules the
 * sync and the embedding migration use. When it is held, `acquireLock` returns
 * `null` and does not say by whom, which is why this module reads the holder's
 * PID back out of the file and puts it in the error: "another run holds it" is
 * not actionable, "pid 4212 holds it" is.
 *
 * Beside it, `.learn.pids` lists the subprocesses the run currently owns — one
 * PID per line, rewritten on every add and remove, deleted on release. The
 * SessionStart orphan reaper reads that file and never touches a live run's
 * processes (spec §7 rule 11). The registry the solver writes to lives here and
 * not in `agent-runner.ts` because the CLI is what owns a run's lifetime.
 *
 * This module is imported statically by `cli/sync-hook.js`, so it stays light:
 * `fs`, `path`, `../lockfile.js`, `../paths.js` and nothing else.
 */
export declare const LEARN_LOCK_NAME = ".learn.lock";
export declare const LEARN_PIDS_NAME = ".learn.pids";
/**
 * A stale lock is stealable after two hours. A real run is bounded by
 * `EPISODIC_MEMORY_LEARN_MAX_MINUTES` (60 by default), so two hours only ever
 * reclaims a lock whose holder is gone.
 */
export declare const LEARN_LOCK_STALE_MS: number;
/** Where a run records the subprocesses it owns. */
export interface PidRegistry {
    add(pid: number): void;
    remove(pid: number): void;
}
/** The lock is held by another live run. */
export declare class LearnLockHeld extends Error {
    readonly holderPid: number | null;
    readonly lockPath: string;
    constructor(holderPid: number | null, lockPath: string);
}
export declare function getLearnLockPath(indexDir: string): string;
export declare function getLearnPidsPath(indexDir: string): string;
/**
 * The PIDs listed in `.learn.pids`, or an empty set when the file is absent or
 * unreadable. Used by the orphan reaper on its fast path, so it never throws.
 */
export declare function readLearnPids(indexDir: string): Set<number>;
/**
 * Hold the learning lock for the duration of `fn`.
 *
 * The lock is released on every exit path, and `.learn.pids` is deleted with it,
 * because a PID file that outlives its run would make the reaper refuse to reap
 * the next run's genuinely orphaned children.
 */
export declare function withLearnLock<T>(fn: (pids: PidRegistry) => Promise<T>): Promise<T>;
