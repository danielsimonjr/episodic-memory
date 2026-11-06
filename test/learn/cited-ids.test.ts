import { describe, it, expect } from 'vitest';
import { parseIdCitedLines } from '../../src/learn/cited-ids.js';
import type { SourceRef } from '../../src/learn/types.js';

function id(seed: string): string {
  return seed.repeat(32).slice(0, 32);
}

const ALPHA = id('a');
const BETA = id('b');

function refFor(exchangeId: string): SourceRef {
  return {
    id: exchangeId,
    path: `/archive/project/${exchangeId}.jsonl`,
    lineStart: 1,
    lineEnd: 4,
    sessionId: 'session-1',
  };
}

const EXCHANGE_TEXT: Record<string, string> = {
  [ALPHA]: 'The retry wrapper lives in the search module and the archive writer buffers lines.',
  [BETA]: 'Ollama backend selection happens in the summarizer with a model override.',
};

function resolvers(over: Partial<{ known: string[]; attempts: number[] }> = {}) {
  const known = new Set(over.known ?? [ALPHA, BETA]);
  const attempts = new Set(over.attempts ?? [11, 12]);
  return {
    exchange: (exchangeId: string) => {
      if (!known.has(exchangeId)) return null;
      return {
        ref: refFor(exchangeId),
        text: EXCHANGE_TEXT[exchangeId] ?? '',
      };
    },
    attempt: (attemptId: number) => attempts.has(attemptId),
  };
}

function mark(exchangeId: string): string {
  return `[#${exchangeId}]`;
}

describe('parseIdCitedLines', () => {
  it('keeps a line with one resolving # mark and enough shared tokens', () => {
    const raw = `The retry wrapper lives in the search module ${mark(ALPHA)}`;
    const out = parseIdCitedLines(raw, resolvers(), 3);
    expect(out.lines).toEqual([`The retry wrapper lives in the search module ${mark(ALPHA)}`]);
    expect(out.sources).toEqual([refFor(ALPHA)]);
    expect(out.dropped).toEqual([]);
  });

  it('keeps a line whose marks are separated by spaces after commas', () => {
    const raw = `Retry wrapper and ollama backend selection ${`[#${ALPHA}, #${BETA}]`}`;
    const out = parseIdCitedLines(raw, resolvers(), 3);
    expect(out.lines).toHaveLength(1);
    expect(out.sources.map(s => s.id)).toEqual([ALPHA, BETA]);
  });

  it('drops a line with no marks', () => {
    const out = parseIdCitedLines('The retry wrapper lives in the search module', resolvers(), 3);
    expect(out.lines).toEqual([]);
    expect(out.dropped).toEqual([
      { line: 'The retry wrapper lives in the search module', reason: 'no-marks' },
    ]);
  });

  it('drops a numeric [7] mark (digest style)', () => {
    const out = parseIdCitedLines('The retry wrapper lives in the search module [7]', resolvers(), 3);
    expect(out.lines).toEqual([]);
    expect(out.dropped[0]?.reason).toBe('no-marks');
  });

  it('drops a line with an unknown id', () => {
    const unknown = id('f');
    const out = parseIdCitedLines(
      `The retry wrapper lives in the search module ${mark(unknown)}`,
      resolvers(),
      3
    );
    expect(out.lines).toEqual([]);
    expect(out.dropped).toEqual([
      { line: `The retry wrapper lives in the search module ${mark(unknown)}`, reason: 'unknown-id' },
    ]);
  });

  it('drops an unknown combined mark even when the other mark resolves', () => {
    const unknown = id('f');
    const out = parseIdCitedLines(
      `Retry wrapper and ollama backend selection ${`[#${ALPHA},#${unknown}]`}`,
      resolvers(),
      3
    );
    expect(out.lines).toEqual([]);
    expect(out.dropped[0]?.reason).toBe('unknown-id');
  });

  it('drops a grounded-looking line whose cited exchange shares no tokens', () => {
    const out = parseIdCitedLines(
      `Zebra quinoa xylophone wandered through the vestibule ${mark(ALPHA)}`,
      resolvers(),
      3
    );
    expect(out.lines).toEqual([]);
    expect(out.dropped[0]?.reason).toBe('ungrounded');
  });

  it('counts distinct shared tokens, ignoring stop words and short words', () => {
    // "the", "and", "in", "of" are stop words; "the" is 3 chars anyway.
    const raw = `the and in of ${mark(ALPHA)}`;
    expect(parseIdCitedLines(raw, resolvers(), 1).lines).toEqual([]);
    expect(parseIdCitedLines(raw, resolvers(), 1).dropped[0]?.reason).toBe('ungrounded');
  });

  it('requires the whole minGrounding count from one cited exchange', () => {
    // Two tokens from ALPHA and two from BETA: neither reaches 3 alone.
    const raw = `retry wrapper ollama backend ${`[#${ALPHA},#${BETA}]`}`;
    expect(parseIdCitedLines(raw, resolvers(), 3).lines).toEqual([]);
  });

  it('passes when one of the cited exchanges is grounded enough', () => {
    const raw = `retry wrapper archive ollama backend ${`[#${ALPHA},#${BETA}]`}`;
    const out = parseIdCitedLines(raw, resolvers(), 3);
    expect(out.lines).toHaveLength(1);
    expect(out.sources.map(s => s.id)).toEqual([ALPHA, BETA]);
  });

  it('resolves an @ mark and reports it in attempts', () => {
    const raw = `Retry wrapper lives in the search module ${`[#${ALPHA},@11]`}`;
    const out = parseIdCitedLines(raw, resolvers(), 3);
    expect(out.lines).toEqual([`Retry wrapper lives in the search module ${`[#${ALPHA},@11]`}`]);
    expect(out.attempts).toEqual([11]);
  });

  it('drops a line with only @ marks', () => {
    const raw = `Retry wrapper lives in the search module [@11,@12]`;
    const out = parseIdCitedLines(raw, resolvers(), 3);
    expect(out.lines).toEqual([]);
    expect(out.dropped[0]?.reason).toBe('no-marks');
  });

  it('drops a line whose @ mark does not resolve', () => {
    const raw = `Retry wrapper lives in the search module ${`[#${ALPHA},@99]`}`;
    const out = parseIdCitedLines(raw, resolvers(), 3);
    expect(out.lines).toEqual([]);
    expect(out.dropped[0]?.reason).toBe('unknown-id');
  });

  it('deduplicates sources and attempts across lines', () => {
    const raw = [
      `Retry wrapper lives in the search module ${mark(ALPHA)}`,
      `Search module retry wrapper again ${`[#${ALPHA},@11]`}`,
    ].join('\n');
    const out = parseIdCitedLines(raw, resolvers(), 3);
    expect(out.lines).toHaveLength(2);
    expect(out.sources.map(s => s.id)).toEqual([ALPHA]);
    expect(out.attempts).toEqual([11]);
  });

  it('strips a leading bullet before matching the marks, and keeps the marks at line end', () => {
    const raw = `- Retry wrapper lives in the search module ${mark(ALPHA)}`;
    const out = parseIdCitedLines(raw, resolvers(), 3);
    expect(out.lines).toEqual([`Retry wrapper lives in the search module ${mark(ALPHA)}`]);
  });

  it('drops the whole line when the mark group is not at the end', () => {
    const raw = `Retry wrapper lives in the search module ${mark(ALPHA)} and then more prose`;
    const out = parseIdCitedLines(raw, resolvers(), 3);
    expect(out.lines).toEqual([]);
    expect(out.dropped[0]?.reason).toBe('no-marks');
  });

  it('ignores blank lines without recording them as dropped', () => {
    const raw = `\n\nRetry wrapper lives in the search module ${mark(ALPHA)}\n\n`;
    const out = parseIdCitedLines(raw, resolvers(), 3);
    expect(out.lines).toHaveLength(1);
    expect(out.dropped).toEqual([]);
  });

  it('rejects an uppercase-hex mark in the required form', () => {
    const upper = id('a').toUpperCase();
    const out = parseIdCitedLines(
      `Retry wrapper lives in the search module [#${upper}]`,
      resolvers({ known: [upper] }),
      3
    );
    expect(out.lines).toEqual([]);
    expect(out.dropped[0]?.reason).toBe('no-marks');
  });
});
