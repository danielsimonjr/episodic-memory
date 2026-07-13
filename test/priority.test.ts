import { describe, it, expect } from 'vitest';
import os from 'os';
import {
  BACKGROUND_WORKER_ENV,
  isBackgroundWorker,
  lowerPriorityIfBackgroundWorker,
} from '../src/priority.js';

describe('background sync priority', () => {
  it('detects the background-worker env flag', () => {
    expect(isBackgroundWorker({ [BACKGROUND_WORKER_ENV]: '1' })).toBe(true);
    expect(isBackgroundWorker({})).toBe(false);
    expect(isBackgroundWorker({ [BACKGROUND_WORKER_ENV]: '0' })).toBe(false);
  });

  it('leaves a foreground sync at normal priority', () => {
    const calls: Array<[number, number]> = [];
    const changed = lowerPriorityIfBackgroundWorker({}, (pid, prio) => {
      calls.push([pid, prio]);
    });
    expect(changed).toBe(false);
    expect(calls).toEqual([]);
  });

  it('drops the background worker to below-normal priority (pid 0 = self)', () => {
    const calls: Array<[number, number]> = [];
    const changed = lowerPriorityIfBackgroundWorker(
      { [BACKGROUND_WORKER_ENV]: '1' },
      (pid, prio) => {
        calls.push([pid, prio]);
      },
    );
    expect(changed).toBe(true);
    expect(calls).toEqual([[0, os.constants.priority.PRIORITY_BELOW_NORMAL]]);
  });

  it('never throws when the OS refuses the priority change', () => {
    // Lowering priority is an optimization, not a correctness requirement. If the
    // platform denies it, the sync must still run rather than crash the hook.
    let changed: boolean | undefined;
    expect(() => {
      changed = lowerPriorityIfBackgroundWorker({ [BACKGROUND_WORKER_ENV]: '1' }, () => {
        throw new Error('EPERM');
      });
    }).not.toThrow();
    expect(changed).toBe(false);
  });
});
