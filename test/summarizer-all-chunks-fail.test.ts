import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { ConversationExchange } from '../src/types.js';

// Every chunk call gets a plain HTTP 400 from a fake Ollama endpoint. No test reaches a model.
const { summarizeConversation } = await import('../src/summarizer.js');

const KEYS = ['EPISODIC_MEMORY_SUMMARIZER_BACKEND', 'EPISODIC_MEMORY_OLLAMA_URL', 'EPISODIC_MEMORY_OLLAMA_MODEL', 'EPISODIC_MEMORY_OLLAMA_FALLBACK_MODEL'];
const saved: Record<string, string | undefined> = {};
for (const k of KEYS) saved[k] = process.env[k];

function exchanges(count: number): ConversationExchange[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `x${i}`,
    project: 'proj',
    timestamp: '2026-11-27T09:00:00.000Z',
    userMessage: `Question ${i} with enough text to count as a real exchange in the transcript`,
    assistantMessage: `Answer ${i} with enough text to count as a real exchange in the transcript`,
    archivePath: '/a.jsonl',
    lineStart: i * 2 + 1,
    lineEnd: i * 2 + 2,
  })) as ConversationExchange[];
}

beforeEach(() => {
  process.env.EPISODIC_MEMORY_SUMMARIZER_BACKEND = 'ollama';
  process.env.EPISODIC_MEMORY_OLLAMA_URL = 'http://127.0.0.1:11434';
  process.env.EPISODIC_MEMORY_OLLAMA_MODEL = 'unit-model';
  delete process.env.EPISODIC_MEMORY_OLLAMA_FALLBACK_MODEL;
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe('summarizeConversation, hierarchical path', () => {
  it('rejects when every chunk fails, instead of returning the error text as the summary', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 400 })));
    const result = await summarizeConversation(exchanges(20)).then((s) => s, (e: unknown) => e);
    expect(result).toBeInstanceOf(Error);
    expect((result as Error).message).toMatch(/no chunk/);
  });
});
