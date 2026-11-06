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

export interface Semaphore {
  /** Run `fn` while holding one slot. */
  run<T>(fn: () => Promise<T>): Promise<T>;
  /** Slots currently held, waiting included. For tests and diagnostics. */
  active(): number;
}

interface Frame {
  /** The one nested run currently sharing this frame's slot, if the caller awaited it. */
  borrowed: boolean;
}

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
 * A size change takes effect only while nothing is in flight. Swapping the
 * object out from under holders would drop them from the count and let a second
 * limiter admit a full new set of subprocesses.
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
