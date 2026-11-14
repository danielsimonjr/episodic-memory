// The CPU class of the embedding parity fixtures. The q8 model gives different vectors for long
// texts on an x86-64 CPU without VNNI, so each class has its own reference vectors. The test and
// the generator (scripts/parity-vectors.mjs) both use this module, so a fixture file always
// carries the class that the test selects.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';

/** The flags that decide the class. */
export const CLASS_FLAGS = ['avx2', 'avx512f', 'avx512_vnni', 'avx_vnni'];

/**
 * Read the CPU flags of CLASS_FLAGS. Linux reads /proc/cpuinfo. Windows reads CPUID leaf 7
 * through .NET in pwsh: leaf 7.0 EBX bit 5 (avx2) and bit 16 (avx512f), ECX bit 11
 * (avx512_vnni), and leaf 7.1 EAX bit 4 (avx_vnni). Returns null when no reader works.
 * @returns {string[] | null}
 */
export function cpuFlags() {
  if (existsSync('/proc/cpuinfo')) {
    const line = readFileSync('/proc/cpuinfo', 'utf-8').split('\n').find(l => l.startsWith('flags')) ?? '';
    const have = new Set(line.split(/\s+/));
    return line ? CLASS_FLAGS.filter(f => have.has(f)) : null;
  }
  if (process.platform === 'win32') {
    const script =
      '$b=[System.Runtime.Intrinsics.X86.X86Base]; if (-not $b::IsSupported) { exit 3 }; ' +
      '$a=$b::CpuId(7,0); $c=$b::CpuId(7,1); ' +
      '"{0} {1} {2} {3}" -f (($a.Item2 -shr 5) -band 1), (($a.Item2 -shr 16) -band 1), (($a.Item3 -shr 11) -band 1), (($c.Item1 -shr 4) -band 1)';
    try {
      const bits = execFileSync('pwsh', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf-8', timeout: 30000 })
        .trim().split(' ');
      if (bits.length !== 4 || bits.some(b => b !== '0' && b !== '1')) return null;
      return CLASS_FLAGS.filter((_, i) => bits[i] === '1');
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * The fixture class of a flag list. `avx512-vnni`: AVX-512 VNNI present. `avx2`: AVX2 without
 * any VNNI. Every other set returns null: it has no measured reference vectors.
 * @param {string[] | null} flags
 * @returns {'avx512-vnni' | 'avx2' | null}
 */
export function parityClass(flags) {
  if (!flags) return null;
  if (flags.includes('avx512_vnni')) return 'avx512-vnni';
  if (flags.includes('avx2') && !flags.includes('avx_vnni')) return 'avx2';
  return null;
}

/** The command that writes the fixture of the current CPU class. */
export const GENERATOR_COMMAND = 'node scripts/parity-vectors.mjs';
