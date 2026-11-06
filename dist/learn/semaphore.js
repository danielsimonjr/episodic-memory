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
    return {
        async run(fn) {
            // Already inside a slot for this limiter: joining the queue again would
            // make the caller wait on a slot it is itself holding.
            if (holding.getStore() === true)
                return fn();
            await acquire();
            try {
                return await holding.run(true, fn);
            }
            finally {
                release();
            }
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
 * Re-created when the configured size changes so a test (or a run with a
 * different setting) is not stuck with a limiter built from an earlier env.
 */
export function globalAgentSemaphore() {
    const size = learnConfig().concurrency;
    if (!globalSemaphore || globalSemaphoreSize !== size) {
        globalSemaphore = createSemaphore(size);
        globalSemaphoreSize = size;
    }
    return globalSemaphore;
}
