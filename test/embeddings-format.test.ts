import { describe, it, expect } from 'vitest';
import {
  BGE_QUERY_PREFIX,
  withQueryPrefix,
  formatExchangeEmbeddingText,
  generateEmbeddings,
} from '../src/embeddings.js';
import { MAX_INDEXED_MESSAGE_BYTES } from '../src/constants.js';

describe('embedding text helpers', () => {
  it('prefixes queries idempotently', () => {
    const once = withQueryPrefix('hello');
    expect(once.startsWith(BGE_QUERY_PREFIX)).toBe(true);
    expect(withQueryPrefix(once)).toBe(once);
  });

  it('includes tool names in the passage text', () => {
    const text = formatExchangeEmbeddingText('u', 'a', ['Read', 'Edit']);
    expect(text).toContain('User: u');
    expect(text).toContain('Assistant: a');
    expect(text).toContain('Tools: Read, Edit');
  });

  it('truncates oversized messages before concatenating', () => {
    const huge = 'x'.repeat(MAX_INDEXED_MESSAGE_BYTES + 5000);
    const text = formatExchangeEmbeddingText(huge, 'ok');
    expect(text.length).toBeLessThan(huge.length);
    expect(text).toContain('[truncated by episodic-memory:');
    expect(text).not.toContain('x'.repeat(MAX_INDEXED_MESSAGE_BYTES + 1));
  });

  it('returns an empty list without loading the model', async () => {
    expect(await generateEmbeddings([])).toEqual([]);
  });
});
