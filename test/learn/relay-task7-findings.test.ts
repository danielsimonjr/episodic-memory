import { describe, it, expect } from 'vitest';
import { bootstrapGain } from '../../src/learn/bootstrap.js';

const rate = (passed: number, total: number, meanTurns: number, usd: number) => ({
  passed,
  total,
  meanTurns,
  usd,
  byKindTier: {},
});

/**
 * Relay challenge, Task 7 (probe 6): the gain rule must compare like with like.
 *
 * `passRate` counts only `graded` attempts, so a side whose subprocess died or
 * aborted on a task contributes fewer rows than the other side. `bootstrapGain`
 * only rejects a side whose total is zero; it never requires the two sides to
 * have measured the same task set. A partial after-side that happens to cover
 * only the easy tasks then looks like an equal-or-better pass rate at a large
 * turn saving, and the run activates a candidate on evidence it never gathered.
 *
 * This test is RED on `08bd332`: the verdict below is `keep: true`
 * (`reason: 'saving'`) even though the after side measured half the baseline's
 * task set.
 */
describe('relay task 7 findings', () => {
  it('does not keep a candidate whose after side measured fewer tasks than the baseline', () => {
    // Baseline: 2 signal tasks, 1 passed (50% pass rate, 10 mean turns).
    // After: the second solve died on one task, so only 1 of 2 was graded —
    // the easy one — passed, at 5 mean turns (a 50 percent turn saving).
    const verdict = bootstrapGain(rate(1, 2, 10, 0.4), rate(1, 1, 5, 0.2), 10);
    expect(verdict.keep).toBe(false);
  });
});
