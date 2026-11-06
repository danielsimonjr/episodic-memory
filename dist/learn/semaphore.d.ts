/**
 * The one subprocess semaphore (spec §7 rule 10a).
 *
 * Every SDK subprocess a learning run starts — bootstrapper, child learner,
 * solver, validation — goes through this limiter, not through a per-level one.
 * Depth therefore never multiplies processes: a run that splits into projects
 * and then into leaf learners still holds at most `concurrency` subprocesses.
 *
 * Nested `run` calls reuse the slot the caller already holds. A plain counting
 * semaphore would deadlock the moment a solver called something that itself
 * runs `run` while every slot is held by such a caller; `AsyncLocalStorage`
 * lets a body know it is already inside a slot for this limiter.
 */
export interface Semaphore {
    /** Run `fn` while holding one slot. */
    run<T>(fn: () => Promise<T>): Promise<T>;
    /** Slots currently held, waiting included. For tests and diagnostics. */
    active(): number;
}
export declare function createSemaphore(limit: number): Semaphore;
/**
 * The process-wide limiter, sized by `learnConfig().concurrency`.
 *
 * Re-created when the configured size changes so a test (or a run with a
 * different setting) is not stuck with a limiter built from an earlier env.
 */
export declare function globalAgentSemaphore(): Semaphore;
