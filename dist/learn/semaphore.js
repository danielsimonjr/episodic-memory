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
import { AsyncLocalStorage } from 'node:async_hooks';
import { learnConfig } from './learn-config.js';
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
     * A nested `run` returns a thenable, not a native Promise: `await` adopts a
     * native Promise without calling a replaced `.then`, so that would not tell
     * us whether the caller is sequencing on this body.
     *
     * The caller attaches `.then` from a microtask queued after this function
     * returns (async-function adoption). The decision is deferred one microtask
     * further, so an attached continuation shares the parent's slot and a
     * detached call — which attaches nothing — takes its own. Only one child
     * borrows at a time; a second overlapping body acquires.
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
 * A size change takes effect only while nothing is in flight. Swapping the
 * object out from under holders would drop them from the count and let a second
 * limiter admit a full new set of subprocesses.
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
