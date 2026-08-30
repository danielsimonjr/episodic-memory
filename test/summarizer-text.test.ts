import { describe, it, expect } from 'vitest';
import { extractSummary, formatConversationText } from '../src/summarizer.js';
import type { ConversationExchange } from '../src/types.js';

describe('summarizer text helpers', () => {
  it('extracts tagged summaries and falls back to trimmed text', () => {
    expect(extractSummary('pre <summary>  the gist  </summary> post')).toBe('the gist');
    expect(extractSummary('  no tags  ')).toBe('no tags');
  });

  it('rejects non-string SDK failures', () => {
    expect(() => extractSummary(undefined as unknown as string)).toThrow(/no text/);
  });

  it('formats exchanges as User/Agent blocks', () => {
    const exchanges: ConversationExchange[] = [
      {
        id: '1',
        project: 'p',
        timestamp: 't',
        userMessage: 'hi',
        assistantMessage: 'hello',
        archivePath: '/a.jsonl',
        lineStart: 1,
        lineEnd: 2,
      },
      {
        id: '2',
        project: 'p',
        timestamp: 't',
        userMessage: 'next',
        assistantMessage: 'ok',
        archivePath: '/a.jsonl',
        lineStart: 3,
        lineEnd: 4,
      },
    ];
    const text = formatConversationText(exchanges);
    expect(text).toContain('User: hi');
    expect(text).toContain('Agent: hello');
    expect(text).toContain('---');
    expect(text).toContain('User: next');
  });
});
