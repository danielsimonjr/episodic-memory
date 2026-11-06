import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { parseIdCitedLines } from '../../src/learn/cited-ids.js';
import type { SourceRef } from '../../src/learn/types.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HEX_A = 'a'.repeat(32);
const HEX_B = 'b'.repeat(32);
const HEX_C = 'c'.repeat(32);
const HEX_UNKNOWN = 'f'.repeat(32);

const EXCHANGE_A_TEXT =
  'the alpha service stores session tokens in the vault behind a rotating key';
const EXCHANGE_B_TEXT = 'the beta worker drains the retry queue on every cold start';
const EXCHANGE_C_TEXT = 'gamma dashboards render latency percentiles per release train';

function ref(id: string): SourceRef {
  return {
    id,
    path: `/archive/proj/session-${id.slice(0, 4)}.jsonl`,
    lineStart: 1,
    lineEnd: 9,
    sessionId: `session-${id.slice(0, 4)}`,
  };
}

function resolve(over: { attempts?: number[] } = {}) {
  const known: Record<string, { ref: SourceRef; text: string }> = {
    [HEX_A]: { ref: ref(HEX_A), text: EXCHANGE_A_TEXT },
    [HEX_B]: { ref: ref(HEX_B), text: EXCHANGE_B_TEXT },
    [HEX_C]: { ref: ref(HEX_C), text: EXCHANGE_C_TEXT },
  };
  const attempts = new Set(over.attempts ?? [1, 2, 3]);
  return {
    exchange: (id: string) => known[id] ?? null,
    attempt: (id: number) => attempts.has(id),
  };
}

describe('parseIdCitedLines', () => {
  it('keeps a line with one resolving # mark and enough shared tokens', () => {
    const raw = `alpha service stores tokens in the vault [#${HEX_A}]`;
    const out = parseIdCitedLines(raw, resolve(), 3);
    expect(out.lines).toHaveLength(1);
    expect(out.lines[0]).toBe(`alpha service stores tokens in the vault [#${HEX_A}]`);
    expect(out.sources.map(s => s.id)).toEqual([HEX_A]);
    expect(out.dropped).toEqual([]);
  });

  it('drops a line with no marks', () => {
    const out = parseIdCitedLines('alpha service stores tokens in the vault', resolve(), 3);
    expect(out.lines).toEqual([]);
    expect(out.dropped).toEqual([
      { line: 'alpha service stores tokens in the vault', reason: 'no-marks' },
    ]);
  });

  it('drops a numeric [7] mark (digest style)', () => {
    const out = parseIdCitedLines('alpha service stores tokens in the vault [7]', resolve(), 3);
    expect(out.lines).toEqual([]);
    expect(out.dropped[0]?.reason).toBe('no-marks');
  });

  it('drops a line with an unknown id', () => {
    const out = parseIdCitedLines(
      `alpha service stores tokens in the vault [#${HEX_UNKNOWN}]`,
      resolve(),
      3
    );
    expect(out.lines).toEqual([]);
    expect(out.dropped).toEqual([
      {
        line: `alpha service stores tokens in the vault [#${HEX_UNKNOWN}]`,
        reason: 'unknown-id',
      },
    ]);
  });

  it('drops a mixed group when any mark is unknown', () => {
    const out = parseIdCitedLines(
      `alpha service stores tokens in the vault [#${HEX_A},#${HEX_UNKNOWN}]`,
      resolve(),
      3
    );
    expect(out.lines).toEqual([]);
    expect(out.dropped[0]?.reason).toBe('unknown-id');
  });

  it('drops a grounded-looking line whose cited exchange shares no tokens', () => {
    const out = parseIdCitedLines(`zebras migrate northwards every summer [#${HEX_A}]`, resolve(), 3);
    expect(out.lines).toEqual([]);
    expect(out.dropped).toEqual([
      { line: `zebras migrate northwards every summer [#${HEX_A}]`, reason: 'ungrounded' },
    ]);
  });

  it('counts distinct shared tokens, not occurrences', () => {
    const raw = `alpha alpha alpha alpha [#${HEX_A}]`;
    const out = parseIdCitedLines(raw, resolve(), 3);
    expect(out.lines).toEqual([]);
    expect(out.dropped[0]?.reason).toBe('ungrounded');
  });

  it('honours minGrounding: a 2-token overlap passes at 2 and fails at 3', () => {
    const raw = `alpha service appears elsewhere [#${HEX_A}]`;
    expect(parseIdCitedLines(raw, resolve(), 2).lines).toHaveLength(1);
    expect(parseIdCitedLines(raw, resolve(), 3).lines).toEqual([]);
  });

  it('keeps a line grounded only by the second of two cited exchanges', () => {
    const raw = `beta worker drains queue [#${HEX_A},#${HEX_B}]`;
    const out = parseIdCitedLines(raw, resolve(), 3);
    expect(out.lines).toHaveLength(1);
    expect(out.sources.map(s => s.id)).toEqual([HEX_A, HEX_B]);
  });

  it('[@n] resolves and is reported in attempts', () => {
    const raw = `alpha service stores tokens in the vault [#${HEX_A},@2]`;
    const out = parseIdCitedLines(raw, resolve(), 3);
    expect(out.lines).toHaveLength(1);
    expect(out.lines[0]).toContain(`[#${HEX_A},@2]`);
    expect(out.attempts).toEqual([2]);
    expect(out.sources.map(s => s.id)).toEqual([HEX_A]);
  });

  it('a line with only @ marks is dropped', () => {
    const out = parseIdCitedLines(`alpha service stores tokens @2`, resolve(), 3);
    expect(out.lines).toEqual([]);
    expect(out.dropped[0]?.reason).toBe('no-marks');
  });

  it('an @ mark grouped alone is dropped', () => {
    const out = parseIdCitedLines(`alpha service stores tokens [@2]`, resolve(), 3);
    expect(out.lines).toEqual([]);
    expect(out.dropped[0]?.reason).toBe('no-marks');
  });

  it('drops an unknown attempt id', () => {
    const out = parseIdCitedLines(
      `alpha service stores tokens in the vault [#${HEX_A},@99]`,
      resolve(),
      3
    );
    expect(out.lines).toEqual([]);
    expect(out.dropped[0]?.reason).toBe('unknown-id');
  });

  it('deduplicates sources and attempts across lines, first-seen order', () => {
    const raw = [
      `alpha service stores tokens in the vault [#${HEX_B},#${HEX_A},@3]`,
      `gamma dashboards render latency percentiles [#${HEX_C},#${HEX_A},@1]`,
    ].join('\n');
    const out = parseIdCitedLines(raw, resolve(), 3);
    expect(out.lines).toHaveLength(2);
    expect(out.sources.map(s => s.id)).toEqual([HEX_B, HEX_A, HEX_C]);
    expect(out.attempts).toEqual([3, 1]);
  });

  it('strips list bullets and trailing whitespace, and skips blank lines silently', () => {
    const raw = [
      '',
      `- alpha service stores tokens in the vault [#${HEX_A}]   `,
      '   ',
      '',
    ].join('\n');
    const out = parseIdCitedLines(raw, resolve(), 3);
    expect(out.lines).toEqual([`alpha service stores tokens in the vault [#${HEX_A}]`]);
    expect(out.dropped).toEqual([]);
  });

  it('ignores tokens shorter than four characters when grounding', () => {
    const raw = `the and for in to of [#${HEX_A}]`;
    const out = parseIdCitedLines(raw, resolve(), 1);
    expect(out.lines).toEqual([]);
    expect(out.dropped[0]?.reason).toBe('ungrounded');
  });

  it('matches tokens case-insensitively', () => {
    const raw = `ALPHA Service STORES Tokens [#${HEX_A}]`;
    expect(parseIdCitedLines(raw, resolve(), 4).lines).toHaveLength(1);
  });

  it('returns the source ref the resolver supplied', () => {
    const out = parseIdCitedLines(`alpha service stores tokens in the vault [#${HEX_A}]`, resolve(), 3);
    expect(out.sources).toEqual([ref(HEX_A)]);
  });

  it('never emits a mark for an unresolved id', () => {
    const out = parseIdCitedLines(
      `alpha service stores tokens in the vault [#${HEX_A}]\nzebra [#${HEX_UNKNOWN}]`,
      resolve(),
      3
    );
    expect(out.lines.join('\n')).not.toContain(HEX_UNKNOWN);
  });
});

describe('cited-ids module shape', () => {
  const SRC = path.join(HERE, '..', '..', 'src', 'learn', 'cited-ids.ts');

  it('imports only types, so it is pure', () => {
    const source = fs.readFileSync(SRC, 'utf8');
    const specifiers = [...source.matchAll(/^\s*import\s[^'"]*?['"]([^'"]+)['"]/gm)].map(
      m => m[1]
    );
    expect(specifiers).toEqual(['./types.js']);
    expect(source).not.toMatch(/process\.env/);
  });
});
