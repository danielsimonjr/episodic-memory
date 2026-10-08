import { describe, it, expect } from 'vitest';
import { parseCitedLines, redactEntryText } from '../src/digest-validate.js';

const marks = new Map<number, string>([
  [1, 'ex-a'],
  [2, 'ex-b'],
  [3, 'ex-c'],
]);

describe('parseCitedLines', () => {
  it('keeps a line with a valid mark and rewrites it to the stable form', () => {
    const r = parseCitedLines('Chose sqlite for the cache [2]', marks);
    expect(r.lines).toEqual(['Chose sqlite for the cache [#ex-b]']);
    expect(r.sources).toEqual(['ex-b']);
    expect(r.dropped).toBe(0);
  });

  it('drops a line with no mark', () => {
    const r = parseCitedLines('A claim with no citation', marks);
    expect(r.lines).toEqual([]);
    expect(r.dropped).toBe(1);
  });

  it('drops a line that cites an unknown mark', () => {
    const r = parseCitedLines('Cites a ghost [99]', marks);
    expect(r.lines).toEqual([]);
    expect(r.dropped).toBe(1);
  });

  it('drops the whole line when a valid and an unknown mark are mixed', () => {
    const r = parseCitedLines('Half right [1,99]', marks);
    expect(r.lines).toEqual([]);
    expect(r.sources).toEqual([]);
    expect(r.dropped).toBe(1);
  });

  it('accepts several marks and dedupes sources in order', () => {
    const r = parseCitedLines('First fact [1,2]\nSecond fact [2,3]', marks);
    expect(r.lines).toEqual(['First fact [#ex-a,#ex-b]', 'Second fact [#ex-b,#ex-c]']);
    expect(r.sources).toEqual(['ex-a', 'ex-b', 'ex-c']);
  });

  it('ignores blank lines and bullet prefixes', () => {
    const r = parseCitedLines('\n- Bullet fact [1]\n\n', marks);
    expect(r.lines).toEqual(['Bullet fact [#ex-a]']);
    expect(r.dropped).toBe(0);
  });

  it('does not treat a number in prose as a mark', () => {
    const r = parseCitedLines('Raised the limit to 3 workers', marks);
    expect(r.lines).toEqual([]);
  });
});

describe('redactEntryText', () => {
  it('redacts a planted token even when the opt-in env is unset', () => {
    delete process.env.EPISODIC_MEMORY_REDACT_SECRETS;
    const out = redactEntryText('token sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGH used');
    expect(out).not.toContain('sk-ant-api03');
    expect(out).toContain('[redacted]');
  });
});
