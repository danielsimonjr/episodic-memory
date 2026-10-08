import { describe, it, expect } from 'vitest';
import { buildSessionPrompt, buildCompressPrompt } from '../src/digest-prompts.js';
import { SUMMARIZER_CONTEXT_MARKER } from '../src/constants.js';
import type { ConversationExchange } from '../src/types.js';
import type { DigestEntry } from '../src/digest-db.js';

function ex(id: string, user: string, agent = 'ok'): ConversationExchange {
  return {
    id,
    project: 'p',
    timestamp: '2026-10-08T09:00:00.000Z',
    userMessage: user,
    assistantMessage: agent,
    archivePath: '/a.jsonl',
    lineStart: 1,
    lineEnd: 2,
  };
}

function entry(id: number, text: string, sources: string[]): DigestEntry {
  return {
    id,
    tier: 'session',
    project: 'p',
    periodStart: '2026-10-08T09:00:00.000Z',
    periodEnd: '2026-10-08T09:30:00.000Z',
    text,
    sources,
    model: 'haiku',
    createdAt: '2026-10-08T10:00:00.000Z',
    supersededBy: null,
    handoff: false,
  };
}

describe('buildSessionPrompt', () => {
  it('starts with the summarizer context marker so its own session is skipped by the indexer', () => {
    const { prompt } = buildSessionPrompt([ex('e1', 'hello there')]);
    expect(prompt.startsWith(SUMMARIZER_CONTEXT_MARKER)).toBe(true);
  });

  it('numbers exchanges from 1 and maps each mark to its id', () => {
    const { prompt, marks } = buildSessionPrompt([ex('e1', 'first'), ex('e2', 'second')]);
    expect([...marks.entries()]).toEqual([[1, 'e1'], [2, 'e2']]);
    expect(prompt).toContain('[1]');
    expect(prompt).toContain('[2]');
  });

  it('contains no planted secret', () => {
    const { prompt } = buildSessionPrompt([ex('e1', 'key sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGH')]);
    expect(prompt).not.toContain('sk-ant-api03');
  });

  it('caps very long exchanges', () => {
    const { prompt } = buildSessionPrompt([ex('e1', 'x'.repeat(200000))]);
    expect(prompt.length).toBeLessThan(60000);
  });
});

describe('buildCompressPrompt', () => {
  it('maps marks to the union of entry sources, in first-seen order', () => {
    const entries = [entry(1, 'A fact [#e1,#e2]', ['e1', 'e2']), entry(2, 'B fact [#e2,#e3]', ['e2', 'e3'])];
    const { prompt, marks } = buildCompressPrompt(entries, 'day');
    expect([...marks.entries()]).toEqual([[1, 'e1'], [2, 'e2'], [3, 'e3']]);
    expect(prompt).toContain('A fact [1,2]');
    expect(prompt).toContain('B fact [2,3]');
    expect(prompt.startsWith(SUMMARIZER_CONTEXT_MARKER)).toBe(true);
  });
});
