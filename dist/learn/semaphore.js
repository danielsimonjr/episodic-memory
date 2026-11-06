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
import { AsyncLocalStorage } from 'node:async_hooks';
import { learnConfig } from './learn-config.js';
/**
 * Creates a limiter with `limit` slots.
 *
 * A limit below 1, or a limit that is not a finite number, gives one slot. A fractional limit rounds down.
 * A nested `run` that the caller awaits reuses the slot of the outer run. So the nested run does not wait for a slot that its caller holds.
 *
 * @param limit The number of tasks that may run at once.
 */
export function createSemaphore(limit) {
    const slots = Number.isFinite(limit) && limit >= 1 ? Math.floor(limit) : 1;
    const holding = new AsyncLocalStorage();
    let active = 0;
    const waiters = [];
    const acquire = () => {
        if (active < slots) {
            active += 1;
            return Promise.resolve();
        }
        return new Promise(resolve => {
            waiters.push(() => {
                active += 1;
                resolve();
            });
        });
    };
    const release = () => {
        active -= 1;
        const next = waiters.shift();
        if (next)
            next();
    };
    const runWithSlot = (fn) => {
        const execute = async () => {
            await acquire();
            try {
                return await holding.run({ borrowed: false }, fn);
            }
            finally {
                release();
            }
        };
        return execute();
    };
    /**
     * A nested `run` returns a thenable, not a native Promise. `await` adopts a native Promise without calling a replaced `.then`.
     * Such an adoption would not show whether the caller sequences on this body.
     *
     * The caller attaches `.then` from a microtask queued after this function returns (async-function adoption).
     * The decision waits one microtask longer. An attached continuation shares the parent's slot.
     * A detached call, which attaches nothing, takes its own slot. Only one child borrows at a time. A second overlapping body acquires.
     */
    const runNested = (parent, fn) => {
        let consumed = false;
        const outcome = new Promise((resolve, reject) => {
            queueMicrotask(() => {
                queueMicrotask(() => {
                    const reuse = consumed && !parent.borrowed;
                    if (!reuse) {
                        runWithSlot(fn).then(resolve, reject);
                        return;
                    }
                    parent.borrowed = true;
                    const clear = () => {
                        parent.borrowed = false;
                    };
                    try {
                        const running = holding.run({ borrowed: false }, fn);
                        Promise.resolve(running).then(value => {
                            clear();
                            resolve(value);
                        }, error => {
                            clear();
                            reject(error);
                        });
                    }
                    catch (error) {
                        clear();
                        reject(error);
                    }
                });
            });
        });
        const thenable = {
            then(onFulfilled, onRejected) {
                consumed = true;
                return outcome.then(onFulfilled, onRejected);
            },
        };
        return thenable;
    };
    return {
        run(fn) {
            const parent = holding.getStore();
            if (!parent)
                return runWithSlot(fn);
            return runNested(parent, fn);
        },
        active() {
            return active;
        },
    };
}
let globalSemaphore = null;
let globalSemaphoreSize = 0;
/**
 * The process-wide limiter, sized by `learnConfig().concurrency`.
 *
 * A size change takes effect only while nothing is in flight. Replacing the object under its holders would drop them from the count.
 * A second limiter would then admit a full new set of subprocesses.
 */
export function globalAgentSemaphore() {
    const size = learnConfig().concurrency;
    const idle = !globalSemaphore || globalSemaphore.active() === 0;
    if (!globalSemaphore || (idle && globalSemaphoreSize !== size)) {
        globalSemaphore = createSemaphore(size);
        globalSemaphoreSize = size;
    }
    return globalSemaphore;
}
