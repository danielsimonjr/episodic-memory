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
 * A limiter that runs tasks in a fixed number of slots. `createSemaphore` builds one.
 */
export interface Semaphore {
  /** Run `fn` while holding one slot. */
  run<T>(fn: () => Promise<T>): Promise<T>;
  /** Slots currently held, waiting included. For tests and diagnostics. */
  active(): number;
}

interface Frame {
  /** The one nested run that currently shares this frame's slot, if the caller awaited that run. */
  borrowed: boolean;
}

/**
 * Creates a limiter with `limit` slots.
 *
 * A limit below 1, or a limit that is not a finite number, gives one slot. A fractional limit rounds down.
 * A nested `run` that the caller awaits reuses the slot of the outer run. So the nested run does not wait for a slot that its caller holds.
 *
 * @param limit The number of tasks that may run at once.
 */
export function createSemaphore(limit: number): Semaphore {
  const slots = Number.isFinite(limit) && limit >= 1 ? Math.floor(limit) : 1;
  const holding = new AsyncLocalStorage<Frame>();

  let active = 0;
  const waiters: Array<() => void> = [];

  const acquire = (): Promise<void> => {
    if (active < slots) {
      active += 1;
      return Promise.resolve();
    }
    return new Promise<void>(resolve => {
      waiters.push(() => {
        active += 1;
        resolve();
      });
    });
  };

  const release = (): void => {
    active -= 1;
    const next = waiters.shift();
    if (next) next();
  };

  const runWithSlot = <T>(fn: () => Promise<T>): Promise<T> => {
    const execute = async (): Promise<T> => {
      await acquire();
      try {
        return await holding.run({ borrowed: false }, fn);
      } finally {
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
  const runNested = <T>(parent: Frame, fn: () => Promise<T>): Promise<T> => {
    let consumed = false;
    const outcome = new Promise<T>((resolve, reject) => {
      queueMicrotask(() => {
        queueMicrotask(() => {
          const reuse = consumed && !parent.borrowed;
          if (!reuse) {
            runWithSlot(fn).then(resolve, reject);
            return;
          }
          parent.borrowed = true;
          const clear = (): void => {
            parent.borrowed = false;
          };
          try {
            const running = holding.run({ borrowed: false }, fn);
            Promise.resolve(running).then(
              value => {
                clear();
                resolve(value);
              },
              error => {
                clear();
                reject(error);
              }
            );
          } catch (error) {
            clear();
            reject(error);
          }
        });
      });
    });

    const thenable = {
      then<TResult1 = T, TResult2 = never>(
        onFulfilled?: ((value: T) => TResult1 | PromiseLike<TResult1>) | null,
        onRejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null
      ): Promise<TResult1 | TResult2> {
        consumed = true;
        return outcome.then(onFulfilled, onRejected);
      },
    };

    return thenable as Promise<T>;
  };

  return {
    run<T>(fn: () => Promise<T>): Promise<T> {
      const parent = holding.getStore();
      if (!parent) return runWithSlot(fn);
      return runNested(parent, fn);
    },
    active(): number {
      return active;
    },
  };
}

let globalSemaphore: Semaphore | null = null;
let globalSemaphoreSize = 0;

/**
 * The process-wide limiter, sized by `learnConfig().concurrency`.
 *
 * A size change takes effect only while nothing is in flight. Replacing the object under its holders would drop them from the count.
 * A second limiter would then admit a full new set of subprocesses.
 */
export function globalAgentSemaphore(): Semaphore {
  const size = learnConfig().concurrency;
  const idle = !globalSemaphore || globalSemaphore.active() === 0;
  if (!globalSemaphore || (idle && globalSemaphoreSize !== size)) {
    globalSemaphore = createSemaphore(size);
    globalSemaphoreSize = size;
  }
  return globalSemaphore;
}
