import { describe, expect, it, vi } from 'vitest';

// The session must get the model with uint8 MatMulInteger weights. With the int8 weights, an x86-64
// CPU without VNNI gives other vectors for long texts. The parity fixture can catch that only on a
// runner without VNNI, so this test checks the bytes that the session gets, on every CPU.
const create = vi.fn(async (..._args: unknown[]) => { throw new Error('stop after the create call'); });
vi.mock('onnxruntime-node', () => ({ default: { InferenceSession: { create } }, InferenceSession: { create } }));

import { initEmbeddings } from '../src/embeddings.js';
import { int8MatMulWeights } from '../src/model-u8.js';

describe('embedding session model', () => {
  it('creates the ONNX session from model bytes that have no int8 MatMulInteger weight', async () => {
    await expect(initEmbeddings()).rejects.toThrow();
    expect(create).toHaveBeenCalledTimes(1);
    const model = create.mock.calls[0][0];
    expect(model).toBeInstanceOf(Uint8Array);
    const weights = int8MatMulWeights(model as Uint8Array);
    expect(weights.int8).toEqual([]);
    expect(weights.uint8).toHaveLength(144);
  });
});
