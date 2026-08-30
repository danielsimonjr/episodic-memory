import { describe, it, expect } from 'vitest';
import {
  SUMMARIZER_CONTEXT_MARKER,
  MAX_INDEXED_MESSAGE_BYTES,
  truncateForIndex,
  truncationNoticeFor,
} from '../src/constants.js';

describe('truncateForIndex', () => {
  it('leaves short messages and empty strings unchanged', () => {
    expect(truncateForIndex('hello')).toBe('hello');
    expect(truncateForIndex('')).toBe('');
  });

  it('caps long messages and is idempotent', () => {
    const long = 'z'.repeat(MAX_INDEXED_MESSAGE_BYTES + 10);
    const once = truncateForIndex(long);
    expect(once.length).toBeGreaterThan(MAX_INDEXED_MESSAGE_BYTES);
    expect(once).toContain('[truncated by episodic-memory:');
    expect(truncateForIndex(once)).toBe(once);
    expect(truncationNoticeFor(long.length)).toContain(String(long.length));
  });

  it('exports the summarizer exclusion marker', () => {
    expect(SUMMARIZER_CONTEXT_MARKER).toMatch(/This summary will be shown/);
  });
});
