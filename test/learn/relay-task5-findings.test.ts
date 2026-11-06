/**
 * Relay-challenger findings for PR #25 (Task 5: in-process tool server and
 * solver runner). These are deliberately failing tests: each one demonstrates a
 * way the global subprocess semaphore can hold more concurrent bodies than its
 * limit, which the PR's contract ("never exceeds its limit", spec §7 rule 10a)
 * forbids. No production code is changed by this file.
 *
 * Finding 1 — the AsyncLocalStorage re-entrancy fast path bypasses acquire for
 * any `run` call started inside a holder's async context, including one that is
 * NOT awaited. The store survives into the detached continuation, so the
 * detached body runs while every slot may already be held by others.
 *
 * Finding 2 — `globalAgentSemaphore()` re-creates the limiter whenever
 * `learnConfig().concurrency` changes. Holders on the old limiter are not
 * counted by the new one, so a concurrency change mid-run lets the total
 * in-flight body count exceed the configured limit.
 */

import { describe, it, expect } from 'vitest';
import { createSemaphore, globalAgentSemaphore } from '../../src/learn/semaphore.js';

function tick(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

describe('relay task 5 findings: semaphore concurrency contract', () => {
  it('FINDING 1 (RED): a non-awaited nested run inside a holder exceeds the limit', async () => {
    const sem = createSemaphore(2);
    let inFlight = 0;
    let peak = 0;
    const subprocess = async (): Promise<void> => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await tick(15);
      inFlight -= 1;
    };

    // Four holders; each fires a nested run without awaiting it. The nested
    // body sees the ALS store and skips acquire, so four subprocesses run at
    // once against a limit of 2.
    await Promise.all(
      Array.from({ length: 4 }, () =>
        sem.run(async () => {
          void sem.run(() => subprocess());
          await tick(10);
        })
      )
    );
    await tick(40);

    expect(peak).toBeLessThanOrEqual(2);
  });

  it('FINDING 2 (RED): a concurrency change mid-run abandons the old holders from the count', async () => {
    const saved = process.env.EPISODIC_MEMORY_LEARN_CONCURRENCY;
    process.env.EPISODIC_MEMORY_LEARN_CONCURRENCY = '2';
    const first = globalAgentSemaphore();

    let inFlight = 0;
    let peak = 0;
    const subprocess = async (): Promise<void> => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await tick(20);
      inFlight -= 1;
    };

    // Hold every slot of the first limiter.
    const holders = Promise.all([
      first.run(() => subprocess()),
      first.run(() => subprocess()),
    ]);

    // Mid-flight the configured size changes; the getter swaps limiters.
    await tick(5);
    process.env.EPISODIC_MEMORY_LEARN_CONCURRENCY = '4';
    const second = globalAgentSemaphore();

    await Promise.all([
      holders,
      Promise.all(Array.from({ length: 4 }, () => second.run(() => subprocess()))),
    ]);

    if (saved === undefined) delete process.env.EPISODIC_MEMORY_LEARN_CONCURRENCY;
    else process.env.EPISODIC_MEMORY_LEARN_CONCURRENCY = saved;

    // Two holders on the discarded limiter plus four on the new one: six
    // concurrent bodies against a configured limit of four.
    expect(peak).toBeLessThanOrEqual(4);
  });
});
