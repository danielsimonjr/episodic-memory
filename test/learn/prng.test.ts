import { describe, it, expect } from 'vitest';
import { mulberry32 } from '../../src/learn/prng.js';

// The golden values come from the body that src/learn/tasks.ts and src/learn/validate.ts each held.
// A seeded task split and a seeded validation sample must not change between versions.
describe('mulberry32', () => {
  it('returns the same sequence for a seed on every platform', () => {
    const fromZero = mulberry32(0);
    expect([fromZero(), fromZero(), fromZero(), fromZero()]).toEqual([
      0.26642920868471265, 0.0003297457005828619, 0.2232720274478197, 0.1462021479383111,
    ]);
    const fromSeed = mulberry32(42);
    expect([fromSeed(), fromSeed(), fromSeed(), fromSeed()]).toEqual([
      0.6011037519201636, 0.44829055899754167, 0.8524657934904099, 0.6697340414393693,
    ]);
  });

  it('folds a seed outside 32 bits into 32 bits', () => {
    expect(mulberry32(-1)()).toBe(mulberry32(4294967295)());
    expect(mulberry32(4294967295)()).toBe(0.8964226141106337);
  });

  it('returns values in [0, 1)', () => {
    const next = mulberry32(7);
    for (let i = 0; i < 1000; i++) {
      const value = next();
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(1);
    }
  });
});

describe('the callers', () => {
  it('use the shared generator and keep no copy of their own', async () => {
    const { readFileSync } = await import('fs');
    for (const file of ['../../src/learn/tasks.ts', '../../src/learn/validate.ts']) {
      const source = readFileSync(new URL(file, import.meta.url), 'utf-8');
      expect(source, file).toContain("import { mulberry32 } from './prng.js'");
      expect(source, file).not.toMatch(/function mulberry32\b/);
    }
  });
});
