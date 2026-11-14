import { existsSync, readFileSync } from 'node:fs';
import { cpus } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { generateEmbedding, generateEmbeddings, initEmbeddings } from '../src/embeddings.js';

// The fixture holds the vectors that @huggingface/transformers 4.2.0 produced, one text per call.
// Any embedding backend must reproduce those vectors, or the index holds vectors of two pipelines.
// The q8 kernels differ a little between CPUs, so the check uses a tolerance and not an exact match.
interface ParityCase { name: string; text: string; vector: number[] }
const fixture = JSON.parse(
  readFileSync(join(__dirname, 'fixtures', 'embedding-parity', 'vectors.json'), 'utf-8')
) as { cases: ParityCase[] };

const MAX_ABS_DIFF = 1e-4;
const MIN_COSINE = 0.9999;

function compare(actual: number[], expected: number[]): { maxDiff: number; cosine: number } {
  let maxDiff = 0;
  let dot = 0;
  for (let i = 0; i < expected.length; i++) {
    maxDiff = Math.max(maxDiff, Math.abs(actual[i] - expected[i]));
    dot += actual[i] * expected[i];
  }
  return { maxDiff, cosine: dot };
}

// The q8 model uses integer matrix kernels that the runtime selects by CPU feature. Different
// kernels can give different vectors for the same text, so every run prints the CPU it used.
function cpuSummary(): string {
  const model = cpus()[0]?.model ?? 'unknown';
  let flags = '';
  if (existsSync('/proc/cpuinfo')) {
    const line = readFileSync('/proc/cpuinfo', 'utf-8').split('\n').find(l => l.startsWith('flags')) ?? '';
    flags = ['avx2', 'avx512f', 'avx512_vnni', 'avx_vnni', 'amx_int8'].filter(f => new RegExp(`\\b${f}\\b`).test(line)).join(',');
  }
  return `${model}${flags ? ` [${flags}]` : ''}`;
}

describe('embedding parity with the reference vectors', () => {
  beforeAll(async () => {
    // process.stderr reaches the CI log for a passing run too; vitest keeps console output of a test.
    process.stderr.write(`embedding-parity: CPU ${cpuSummary()}`+String.fromCharCode(10));
    await initEmbeddings();
  }, 120000);

  for (const c of fixture.cases) {
    it(`reproduces the reference vector of the ${c.name} case`, async () => {
      const vector = await generateEmbedding(c.text);
      expect(vector).toHaveLength(384);
      const { maxDiff, cosine } = compare(vector, c.vector);
      expect(maxDiff, `max |difference| of ${c.name} (cosine ${cosine}, CPU ${cpuSummary()})`).toBeLessThan(MAX_ABS_DIFF);
      expect(cosine, `cosine of ${c.name}`).toBeGreaterThan(MIN_COSINE);
    });
  }

  // A passage that the sync embeds in a batch must get the vector that it gets alone, because the
  // search embeds each query alone. A padded batch changes the vectors of the q8 model.
  // The check compares the two paths on this CPU, so the result does not depend on the CPU.
  it('gives each text of a batch the vector of the same text alone', async () => {
    const texts = fixture.cases.map(c => c.text);
    const batch = await generateEmbeddings(texts);
    expect(batch).toHaveLength(texts.length);
    for (let i = 0; i < texts.length; i++) {
      const alone = await generateEmbedding(texts[i]);
      const { maxDiff } = compare(batch[i], alone);
      expect(maxDiff, `max |difference| of batch item ${fixture.cases[i].name}`).toBeLessThan(1e-6);
    }
  });
});
