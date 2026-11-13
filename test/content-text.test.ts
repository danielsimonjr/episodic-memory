import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { extractContentText, safeParseJson } from '../src/content-text.js';

describe('extractContentText', () => {
  it('returns a string content unchanged', () => {
    expect(extractContentText('plain text')).toBe('plain text');
  });

  it('joins the text of the text blocks with a newline and skips the other blocks', () => {
    const content = [
      { type: 'text', text: 'first' },
      { type: 'tool_use', name: 'Bash' },
      null,
      'a bare string',
      { type: 'text', text: 42 },
      { type: 'output_text', text: 'second' },
    ];
    expect(extractContentText(content)).toBe('first\nsecond');
  });

  it('returns an empty string for content that is not a string or an array', () => {
    expect(extractContentText(undefined)).toBe('');
    expect(extractContentText({ text: 'not in an array' })).toBe('');
    expect(extractContentText(7)).toBe('');
  });
});

describe('safeParseJson', () => {
  it('parses valid JSON', () => {
    expect(safeParseJson('{"a":[1,2]}')).toEqual({ a: [1, 2] });
  });

  it('returns the input string when the JSON is not valid', () => {
    expect(safeParseJson('not json {')).toBe('not json {');
  });
});

describe('the callers', () => {
  it('use the shared module and keep no copy of their own', () => {
    for (const file of ['../src/parser.ts', '../src/show.ts']) {
      const source = readFileSync(new URL(file, import.meta.url), 'utf-8');
      expect(source, file).toContain("from './content-text.js'");
      expect(source, file).not.toMatch(/function (extractTextFromContent|extractCodexText|safeParseJson)\b/);
    }
  });
});
