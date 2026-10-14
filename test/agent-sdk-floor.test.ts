import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// The summarizer starts the `claude` binary bundled in @anthropic-ai/claude-agent-sdk.
// Version 2.1.141 of that binary (the one 0.2.x ships, and 0.2.141 is the last 0.2.x)
// deletes the session record of a live, elevated Claude Code session when it starts at
// Medium integrity. The binary of 2.1.299 does not. A `^0.2.x` range cannot leave
// 0.2.141, so the dependency range must keep a floor at or above the first
// verified-clean release.
const FLOOR: [number, number, number] = [0, 3, 299];

function lowerBound(range: string): [number, number, number] {
  const m = /^[\^~>=\s]*(\d+)\.(\d+)\.(\d+)/.exec(range);
  if (!m) throw new Error(`cannot read a lower bound from "${range}"`);
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

function atLeast(a: number[], b: number[]): boolean {
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] > b[i];
  }
  return true;
}

describe('claude-agent-sdk dependency floor', () => {
  const pkg = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf8'));
  const range: string = pkg.dependencies['@anthropic-ai/claude-agent-sdk'];

  it('keeps the lower bound at or above the first release whose bundled binary is clean', () => {
    expect(atLeast(lowerBound(range), FLOOR)).toBe(true);
  });

  it('the range helper rejects the known-bad 0.2 line', () => {
    expect(atLeast(lowerBound('^0.2.126'), FLOOR)).toBe(false);
    expect(atLeast(lowerBound('0.2.141'), FLOOR)).toBe(false);
    expect(atLeast(lowerBound('^0.3.299'), FLOOR)).toBe(true);
  });
});
