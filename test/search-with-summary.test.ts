import { describe, it, expect, afterEach } from 'vitest';
import {
  includeSearchSummaries,
  maxSummaryDisplayChars,
  formatSummaryForDisplay,
  formatResults,
  formatMultiConceptResults,
  l2DistanceToCosineSimilarity,
} from '../src/search.js';
import type { ConversationExchange, MultiConceptResult, SearchResult } from '../src/types.js';

const exchange: ConversationExchange = {
  id: 'ex-1',
  project: 'demo',
  timestamp: '2026-08-30T12:00:00.000Z',
  userMessage: 'how does auth work',
  assistantMessage: 'use the session cookie',
  archivePath: '/tmp/missing.jsonl',
  lineStart: 1,
  lineEnd: 4,
};

function result(overrides: Partial<SearchResult> = {}): SearchResult {
  return {
    exchange,
    similarity: 0.8,
    snippet: 'how does auth work',
    summary: 'Discussed session cookies.',
    ...overrides,
  };
}

describe('search summary visibility', () => {
  const prevInclude = process.env.EPISODIC_MEMORY_INCLUDE_SUMMARY;
  const prevCap = process.env.EPISODIC_MEMORY_MAX_SUMMARY_DISPLAY_CHARS;

  afterEach(() => {
    if (prevInclude === undefined) delete process.env.EPISODIC_MEMORY_INCLUDE_SUMMARY;
    else process.env.EPISODIC_MEMORY_INCLUDE_SUMMARY = prevInclude;
    if (prevCap === undefined) delete process.env.EPISODIC_MEMORY_MAX_SUMMARY_DISPLAY_CHARS;
    else process.env.EPISODIC_MEMORY_MAX_SUMMARY_DISPLAY_CHARS = prevCap;
  });

  it('defaults to including summaries and honors the off flag', () => {
    delete process.env.EPISODIC_MEMORY_INCLUDE_SUMMARY;
    expect(includeSearchSummaries()).toBe(true);
    process.env.EPISODIC_MEMORY_INCLUDE_SUMMARY = '0';
    expect(includeSearchSummaries()).toBe(false);
    process.env.EPISODIC_MEMORY_INCLUDE_SUMMARY = 'false';
    expect(includeSearchSummaries()).toBe(false);
  });

  it('truncates long summaries at the display cap', () => {
    delete process.env.EPISODIC_MEMORY_MAX_SUMMARY_DISPLAY_CHARS;
    expect(maxSummaryDisplayChars()).toBe(2000);
    process.env.EPISODIC_MEMORY_MAX_SUMMARY_DISPLAY_CHARS = '8';
    expect(formatSummaryForDisplay('abcdefghijklmnop')).toBe('abcdefgh…');
    expect(formatSummaryForDisplay('short')).toBe('short');
  });

  it('includes summaries in markdown results when enabled', async () => {
    delete process.env.EPISODIC_MEMORY_INCLUDE_SUMMARY;
    const withTools = result({
      exchange: {
        ...exchange,
        toolCalls: [
          { id: 't1', exchangeId: 'ex-1', toolName: 'Read', isError: false, timestamp: 't' },
          { id: 't2', exchangeId: 'ex-1', toolName: 'Read', isError: false, timestamp: 't' },
        ],
      },
    });
    const text = await formatResults([withTools]);
    expect(text).toContain('Discussed session cookies.');
    expect(text).toContain('demo');
    expect(text).toContain('80% match');
    expect(text).toContain('Tools: Read(2)');

    process.env.EPISODIC_MEMORY_INCLUDE_SUMMARY = '0';
    const hidden = await formatResults([result()]);
    expect(hidden).not.toContain('Discussed session cookies.');
  });

  it('returns the empty-results message and handles text-only hits', async () => {
    expect(await formatResults([])).toBe('No results found.');
    const text = await formatResults([result({ similarity: undefined as unknown as number, summary: undefined })]);
    expect(text).not.toMatch(/% match/);
  });

  it('includes summaries on multi-concept formatting', async () => {
    const multi: MultiConceptResult[] = [{
      exchange,
      snippet: 'how does auth work',
      conceptSimilarities: [0.9, 0.7],
      averageSimilarity: 0.8,
      summary: 'Auth recap',
    }];
    const text = await formatMultiConceptResults(multi, ['auth', 'cookie']);
    expect(text).toContain('Auth recap');
    expect(text).toContain('auth: 90%');
    expect(await formatMultiConceptResults([], ['x', 'y'])).toMatch(/No conversations found/);
  });

  it('converts L2 distance to cosine similarity', () => {
    expect(l2DistanceToCosineSimilarity(0)).toBe(1);
    expect(l2DistanceToCosineSimilarity(2)).toBe(-1);
  });
});
