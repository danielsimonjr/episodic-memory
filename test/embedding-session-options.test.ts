import { describe, expect, it, vi } from 'vitest';

// The session option below keeps the vectors of an x86-64 CPU without VNNI equal to the vectors of
// a VNNI CPU. The parity fixture can catch its loss only on a runner without VNNI, so this test pins
// the option on every CPU.
const create = vi.fn(async () => { throw new Error('stop after the create call'); });
vi.mock('onnxruntime-node', () => ({ default: { InferenceSession: { create } }, InferenceSession: { create } }));

import { initEmbeddings } from '../src/embeddings.js';

describe('embedding session options', () => {
  it('sets session.x64quantprecision to "1" when the ONNX session is created', async () => {
    await expect(initEmbeddings()).rejects.toThrow();
    expect(create).toHaveBeenCalledTimes(1);
    const options = create.mock.calls[0][1] as { extra?: { session?: Record<string, unknown> } } | undefined;
    expect(options?.extra?.session?.x64quantprecision).toBe('1');
  });
});
