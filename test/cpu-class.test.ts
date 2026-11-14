import { describe, expect, it } from 'vitest';
import { cpuFlags, parityClass } from '../scripts/cpu-class.mjs';

describe('parityClass', () => {
  it('puts a CPU with AVX-512 VNNI in class avx512-vnni', () => {
    expect(parityClass(['avx2', 'avx512f', 'avx512_vnni'])).toBe('avx512-vnni');
    expect(parityClass(['avx2', 'avx512f', 'avx512_vnni', 'avx_vnni'])).toBe('avx512-vnni');
  });

  it('puts a CPU with AVX2 and no VNNI in class avx2', () => {
    expect(parityClass(['avx2'])).toBe('avx2');
  });

  it('gives no class to a set without measured reference vectors', () => {
    // AVX-VNNI without AVX-512 VNNI (some Intel consumer CPUs) was never measured.
    expect(parityClass(['avx2', 'avx_vnni'])).toBeNull();
    expect(parityClass([])).toBeNull();
    expect(parityClass(null)).toBeNull();
  });
});

describe('cpuFlags', () => {
  it('returns only known flag names', () => {
    const flags = cpuFlags();
    if (flags) for (const f of flags) expect(['avx2', 'avx512f', 'avx512_vnni', 'avx_vnni']).toContain(f);
  });
});
