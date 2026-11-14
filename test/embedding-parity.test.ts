import { existsSync, readFileSync } from 'node:fs';
import { cpus } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { cpuFlags, GENERATOR_COMMAND, parityClass } from '../scripts/cpu-class.mjs';
import { generateEmbedding, generateEmbeddings, initEmbeddings } from '../src/embeddings.js';

// Each fixture file holds the vectors that @huggingface/transformers 4.2.0 produced, one text per
// call, on one CPU class. Any embedding backend must reproduce the vectors of its class, or the
// index holds vectors of two pipelines. The q8 model gives long texts different vectors on an
// x86-64 CPU without VNNI, with the old backend too, so each class has its own file.
// scripts/cpu-class.mjs reads the class from the CPU flags; an unknown class fails.
interface ParityCase { name: string; text: string; vector: number[] }
const dir = join(__dirname, 'fixtures', 'embedding-parity');
const texts = (JSON.parse(readFileSync(join(dir, 'cases.json'), 'utf-8')) as { cases: { name: string; text: string }[] }).cases;
const flags = cpuFlags();
const cls = parityClass(flags);
const vectorFile = cls ? join(dir, `vectors.${cls}.json`) : '';
const classError = !cls
  ? `no parity fixture class for CPU flags ${JSON.stringify(flags)}; a new class needs its own reference vectors from "${GENERATOR_COMMAND}"`
  : !existsSync(vectorFile)
    ? `missing ${vectorFile}; run "${GENERATOR_COMMAND}" on a CPU of class ${cls}`
    : '';
const fixture: { cases: ParityCase[] } = {
  cases: classError
    ? []
    : (JSON.parse(readFileSync(vectorFile, 'utf-8')) as { cases: { name: string; vector: number[] }[] }).cases.map(v => {
        const t = texts.find(x => x.name === v.name);
        if (!t) throw new Error(`${vectorFile} names case ${v.name}, which cases.json does not hold`);
        return { name: v.name, text: t.text, vector: v.vector };
      }),
};

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
  return `${cpus()[0]?.model?.trim() ?? 'unknown'} [${(flags ?? ['flags unreadable']).join(',')}] class ${cls ?? 'unknown'}`;
}

describe('embedding parity with the reference vectors', () => {
  beforeAll(async () => {
    // process.stderr reaches the CI log for a passing run too; vitest keeps console output of a test.
    process.stderr.write(`embedding-parity: CPU ${cpuSummary()}`+String.fromCharCode(10));
    await initEmbeddings();
  }, 120000);

  it('has reference vectors for the CPU class of this machine', () => {
    expect(classError, classError).toBe('');
    expect(fixture.cases.map(c => c.name)).toEqual(texts.map(t => t.name));
  });

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
    const batchTexts = texts.map(t => t.text);
    const batch = await generateEmbeddings(batchTexts);
    expect(batch).toHaveLength(batchTexts.length);
    for (let i = 0; i < batchTexts.length; i++) {
      const alone = await generateEmbedding(batchTexts[i]);
      const { maxDiff } = compare(batch[i], alone);
      expect(maxDiff, `max |difference| of batch item ${texts[i].name}`).toBeLessThan(1e-6);
    }
  });
});
