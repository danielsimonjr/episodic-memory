import { readFileSync } from 'node:fs';
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

describe('embedding parity with the reference vectors', () => {
  beforeAll(async () => { await initEmbeddings(); }, 120000);

  for (const c of fixture.cases) {
    it(`reproduces the reference vector of the ${c.name} case`, async () => {
      const vector = await generateEmbedding(c.text);
      expect(vector).toHaveLength(384);
      const { maxDiff, cosine } = compare(vector, c.vector);
      expect(maxDiff, `max |difference| of ${c.name}`).toBeLessThan(MAX_ABS_DIFF);
      expect(cosine, `cosine of ${c.name}`).toBeGreaterThan(MIN_COSINE);
    });
  }

  // A passage that the sync embeds in a batch must get the vector that it gets alone, because the
  // search embeds each query alone. A padded batch changes the vectors of the q8 model.
  it('gives each text of a batch the vector of the same text alone', async () => {
    const texts = fixture.cases.map(c => c.text);
    const batch = await generateEmbeddings(texts);
    expect(batch).toHaveLength(texts.length);
    for (let i = 0; i < texts.length; i++) {
      const { maxDiff, cosine } = compare(batch[i], fixture.cases[i].vector);
      expect(maxDiff, `max |difference| of batch item ${fixture.cases[i].name}`).toBeLessThan(MAX_ABS_DIFF);
      expect(cosine, `cosine of batch item ${fixture.cases[i].name}`).toBeGreaterThan(MIN_COSINE);
    }
  });
});
