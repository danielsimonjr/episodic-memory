/**
 * The one subprocess semaphore (spec §7 rule 10a).
 *
 * Every SDK subprocess a learning run starts — bootstrapper, child learner,
 * solver, validation — goes through this limiter, not through a per-level one.
 * Depth therefore never multiplies processes: a run that splits into projects
 * and then into leaf learners still holds at most `concurrency` subprocesses.
 *
 * An awaited nested `run` reuses the slot the caller already holds. A plain
 * counting semaphore would deadlock the moment a solver called something that
 * itself runs `run` while every slot is held by such a caller. A nested `run`
 * that is not awaited is a second body: it takes its own slot, so a
 * fire-and-forget call cannot slip past the limit on the caller's async context.
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
 * A size change takes effect only while nothing is in flight. Swapping the
 * object out from under holders would drop them from the count and let a second
 * limiter admit a full new set of subprocesses.
 */
export declare function globalAgentSemaphore(): Semaphore;
