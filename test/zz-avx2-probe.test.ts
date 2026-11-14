// TEMPORARY diagnostic for PR #106. Remove before merge.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'vitest';
import { modelDir } from '../src/embedding-model.js';

const flags = existsSync('/proc/cpuinfo') ? (readFileSync('/proc/cpuinfo', 'utf-8').split(String.fromCharCode(10)).find(l => l.startsWith('flags')) ?? '') : '';
const noVnni = flags.includes(' avx2') && !flags.includes('avx512_vnni') && !flags.includes('avx_vnni');

describe.skipIf(!noVnni)('AVX2 probe', () => {
  it('logs the graph transformers with the precision option', async () => {
    const ort = (await import('onnxruntime-node')) as any;
    const o = ort.default ?? ort;
    const s = await o.InferenceSession.create(join(modelDir(), 'onnx', 'model_quantized.onnx'), {
      extra: { session: { x64quantprecision: '1' } }, logSeverityLevel: 0, logVerbosityLevel: 0,
    });
    process.stderr.write(`AVX2-PROBE created ${s.inputNames.join(',')}` + String.fromCharCode(10));
  }, 120000);
});
