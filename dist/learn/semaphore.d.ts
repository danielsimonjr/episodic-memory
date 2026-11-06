/**
 * The one subprocess semaphore (spec §7 rule 10a).
 *
 * This limiter serves every SDK subprocess that a learning run starts.
 * The subprocesses include the bootstrapper, child learner, solver and validation. No level has its own limiter.
 * Depth therefore never multiplies processes. A run that splits into projects
 * and then into leaf learners still holds at most `concurrency` subprocesses.
 *
 * An awaited nested `run` reuses the slot that the caller already holds.
 * A plain counting semaphore deadlocks when every slot holds a caller that waits for a nested `run`.
 * A nested `run` that nobody awaits is a second body. That body takes its own slot.
 * A fire-and-forget call therefore cannot slip past the limit on the caller's async context.
 */
/**
 * A limiter that runs tasks in a fixed number of slots. `createSemaphore` builds one.
 */
export interface Semaphore {
    /** Run `fn` while holding one slot. */
    run<T>(fn: () => Promise<T>): Promise<T>;
    /** Slots currently held, waiting included. For tests and diagnostics. */
    active(): number;
}
/**
 * Creates a limiter with `limit` slots.
 *
 * A limit below 1, or a limit that is not a finite number, gives one slot. A fractional limit rounds down.
 * A nested `run` that the caller awaits reuses the slot of the outer run. So the nested run does not wait for a slot that its caller holds.
 *
 * @param limit The number of tasks that may run at once.
 */
export declare function createSemaphore(limit: number): Semaphore;
/**
 * The process-wide limiter, sized by `learnConfig().concurrency`.
 *
 * A size change takes effect only while nothing is in flight. Replacing the object under its holders would drop them from the count.
 * A second limiter would then admit a full new set of subprocesses.
 */
export declare function globalAgentSemaphore(): Semaphore;
