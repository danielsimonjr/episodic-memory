import { describe, it, expect, afterEach } from 'vitest';
import { createSemaphore, globalAgentSemaphore } from '../../src/learn/semaphore.js';

function tick(ms = 5): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

describe('createSemaphore', () => {
  const saved = process.env.EPISODIC_MEMORY_LEARN_CONCURRENCY;

  afterEach(() => {
    if (saved === undefined) delete process.env.EPISODIC_MEMORY_LEARN_CONCURRENCY;
    else process.env.EPISODIC_MEMORY_LEARN_CONCURRENCY = saved;
  });

  it('runs work and reports the slots it holds', async () => {
    const sem = createSemaphore(2);
    expect(sem.active()).toBe(0);
    const value = await sem.run(async () => 'done');
    expect(value).toBe('done');
    expect(sem.active()).toBe(0);
  });

  it('never runs more than its limit of outer bodies at once', async () => {
    const sem = createSemaphore(2);
    let running = 0;
    let peak = 0;
    await Promise.all(
      Array.from({ length: 6 }, () =>
        sem.run(async () => {
          running += 1;
          peak = Math.max(peak, running);
          await tick();
          running -= 1;
        })
      )
    );
    expect(peak).toBe(2);
    expect(sem.active()).toBe(0);
  });

  it('never exceeds its limit across nested run calls and does not deadlock', async () => {
    const sem = createSemaphore(2);
    let outerRunning = 0;
    let outerPeak = 0;
    const innerDone: number[] = [];

    await Promise.all(
      Array.from({ length: 4 }, (_, index) =>
        sem.run(async () => {
          outerRunning += 1;
          outerPeak = Math.max(outerPeak, outerRunning);
          // A nested run reuses the slot the outer call already holds: with a
          // plain counting semaphore this would deadlock at limit 1 or 2.
          await sem.run(async () => {
            await tick(2);
            innerDone.push(index);
          });
          outerRunning -= 1;
        })
      )
    );

    expect(outerPeak).toBeLessThanOrEqual(2);
    expect(innerDone.sort()).toEqual([0, 1, 2, 3]);
    expect(sem.active()).toBe(0);
  });

  it('releases its slot when the work throws', async () => {
    const sem = createSemaphore(1);
    await expect(sem.run(async () => Promise.reject(new Error('boom')))).rejects.toThrow('boom');
    expect(sem.active()).toBe(0);
    // Still usable afterwards.
    expect(await sem.run(async () => 1)).toBe(1);
  });

  it('works at a limit of one across nested run calls', async () => {
    const sem = createSemaphore(1);
    const result = await sem.run(async () => sem.run(async () => 'inner'));
    expect(result).toBe('inner');
    expect(sem.active()).toBe(0);
  });
});

describe('globalAgentSemaphore', () => {
  const saved = process.env.EPISODIC_MEMORY_LEARN_CONCURRENCY;

  afterEach(() => {
    if (saved === undefined) delete process.env.EPISODIC_MEMORY_LEARN_CONCURRENCY;
    else process.env.EPISODIC_MEMORY_LEARN_CONCURRENCY = saved;
  });

  it('is one semaphore per process for one concurrency setting', () => {
    process.env.EPISODIC_MEMORY_LEARN_CONCURRENCY = '3';
    expect(globalAgentSemaphore()).toBe(globalAgentSemaphore());
  });

  it('is sized by learnConfig().concurrency', async () => {
    process.env.EPISODIC_MEMORY_LEARN_CONCURRENCY = '1';
    const sem = globalAgentSemaphore();
    let running = 0;
    let peak = 0;
    await Promise.all(
      Array.from({ length: 4 }, () =>
        sem.run(async () => {
          running += 1;
          peak = Math.max(peak, running);
          await tick(2);
          running -= 1;
        })
      )
    );
    expect(peak).toBe(1);
  });
});
