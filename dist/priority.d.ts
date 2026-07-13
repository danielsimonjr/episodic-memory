export declare const BACKGROUND_WORKER_ENV = "EPISODIC_MEMORY_BACKGROUND_WORKER";
/** True when this process is the detached worker spawned by `sync --background`. */
export declare function isBackgroundWorker(env?: NodeJS.ProcessEnv): boolean;
/**
 * Drop this process to below-normal priority if it is the background sync
 * worker. Call BEFORE the heavy imports (transformers / better-sqlite3) so the
 * expensive work never runs at normal priority.
 *
 * Returns whether the priority was actually lowered. Never throws: priority is
 * an optimization, and a platform that refuses it must not break the sync.
 *
 * @param setPriority injectable for tests (defaults to os.setPriority)
 */
export declare function lowerPriorityIfBackgroundWorker(env?: NodeJS.ProcessEnv, setPriority?: (pid: number, priority: number) => void): boolean;
