import { afterEach, describe, expect, it, vi } from 'vitest';
import { positiveIntegerOption, refuseUsage } from '../src/cli-usage.js';

/** Make process.exit throw, so the test can see the code and the stderr line. */
function trap() {
  const exit = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    throw new Error(`exit ${code}`);
  }) as never);
  const err = vi.spyOn(console, 'error').mockImplementation(() => {});
  return { exit, err };
}

describe('cli-usage', () => {
  afterEach(() => vi.restoreAllMocks());

  it('refuseUsage prints one line that names the command and its help, and exits 2', () => {
    const { err } = trap();
    expect(() => refuseUsage('stats', 'unknown option --zzz')).toThrow('exit 2');
    expect(err).toHaveBeenCalledTimes(1);
    expect(err.mock.calls[0][0]).toBe("episodic-memory stats: unknown option --zzz. Run 'episodic-memory stats --help'.");
  });

  it('positiveIntegerOption returns a whole positive integer', () => {
    expect(positiveIntegerOption('search', '--limit', '7')).toBe(7);
    expect(positiveIntegerOption('search', '--limit', '120')).toBe(120);
  });

  it('positiveIntegerOption refuses a missing value, zero, a negative, a fraction and trailing text', () => {
    trap();
    for (const value of [undefined, '0', '-3', '2.5', '5abc', 'abc', '']) {
      expect(() => positiveIntegerOption('search', '--limit', value), String(value)).toThrow('exit 2');
    }
  });
});
