import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// TEMPORARY experiment: on a CPU without VNNI, does @huggingface/transformers 4.2.0 (the embedder of
// main) reproduce the fixture vectors? Remove this file before merge.
const flags = existsSync('/proc/cpuinfo') ? readFileSync('/proc/cpuinfo', 'utf-8') : '';
const avx2Only = /\bavx2\b/.test(flags) && !/vnni/.test(flags);

describe.runIf(avx2Only)('AVX2 transformers probe', () => {
  it('prints the max difference of transformers 4.2.0 against the fixture', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tfprobe-'));
    writeFileSync(join(dir, 'package.json'), '{"name":"p","version":"1.0.0","type":"module"}');
    execFileSync('npm', ['install', '--no-audit', '--no-fund', '@huggingface/transformers@4.2.0'], { cwd: dir, stdio: 'inherit' });
    const fixture = join(__dirname, 'fixtures', 'embedding-parity', 'vectors.json');
    writeFileSync(join(dir, 'run.mjs'), `
      import { readFileSync } from 'node:fs';
      import { pipeline } from '@huggingface/transformers';
      const fx = JSON.parse(readFileSync(${JSON.stringify(fixture)}, 'utf-8'));
      const p = await pipeline('feature-extraction', 'Xenova/bge-small-en-v1.5', { dtype: 'q8', progress_callback: () => {} });
      for (const c of fx.cases) {
        const out = await p(c.text.substring(0, 2000), { pooling: 'mean', normalize: true });
        const v = Array.from(out.data);
        let d = 0; for (let i = 0; i < v.length; i++) d = Math.max(d, Math.abs(v[i] - c.vector[i]));
        process.stderr.write('AVX2-TF ' + c.name + ' maxdiff ' + d + String.fromCharCode(10));
      }
    `);
    execFileSync(process.execPath, [join(dir, 'run.mjs')], { cwd: dir, stdio: 'inherit' });
    expect(true).toBe(true);
  }, 600000);
});
