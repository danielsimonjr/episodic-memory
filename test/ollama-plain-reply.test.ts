import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { callOllama } from '../src/ollama-backend.js';
import { callDigestModel, callLearnModel } from '../src/summarizer.js';

// The digest and learn prompts ask for cited lines or JSON, never for a <summary> block.
// The summary-block guard must apply only to the conversation-summary prompts.

const KEYS = ['EPISODIC_MEMORY_SUMMARIZER_BACKEND', 'EPISODIC_MEMORY_OLLAMA_URL', 'EPISODIC_MEMORY_OLLAMA_MODEL', 'FLEET_GPU_RESERVATION'];
const saved: Record<string, string | undefined> = {};
for (const k of KEYS) saved[k] = process.env[k];

const PLAIN = 'Fixed the parser bug [1]\nOpen: the cache test [2]';

function okFetch(response: string) {
  return (async () => ({ ok: true, status: 200, json: async () => ({ response }) })) as unknown as typeof fetch;
}

beforeEach(() => {
  process.env.EPISODIC_MEMORY_SUMMARIZER_BACKEND = 'ollama';
  process.env.EPISODIC_MEMORY_OLLAMA_URL = 'http://localhost:11434';
  process.env.EPISODIC_MEMORY_OLLAMA_MODEL = 'm';
  delete process.env.FLEET_GPU_RESERVATION;
});

afterEach(() => {
  vi.unstubAllGlobals();
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe('Ollama replies without a <summary> block', () => {
  it('callOllama accepts a plain reply when requireSummaryBlock is false', async () => {
    await expect(callOllama('x', { fetchImpl: okFetch(PLAIN), requireSummaryBlock: false })).resolves.toBe(PLAIN);
  });

  it('callOllama still refuses a plain reply by default', async () => {
    await expect(callOllama('x', { fetchImpl: okFetch(PLAIN) })).rejects.toThrow(/summary/);
  });

  it('callOllama still refuses an empty reply when requireSummaryBlock is false', async () => {
    await expect(callOllama('x', { fetchImpl: okFetch('  '), requireSummaryBlock: false })).rejects.toThrow(/empty/);
  });

  it('callDigestModel returns a plain cited reply on the ollama backend', async () => {
    vi.stubGlobal('fetch', okFetch(PLAIN));
    await expect(callDigestModel('digest prompt')).resolves.toBe(PLAIN);
  });

  it('callLearnModel returns a plain JSON reply on the ollama backend', async () => {
    vi.stubGlobal('fetch', okFetch('{"tasks":[]}'));
    await expect(callLearnModel('learn prompt')).resolves.toBe('{"tasks":[]}');
  });
});
