import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Mock the Claude Agent SDK so a fallback call never spawns a real `claude` subprocess.
const { queryMock } = vi.hoisted(() => ({ queryMock: vi.fn() }));
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({ query: queryMock }));

const { callLearnModel, callDigestModel } = await import('../src/summarizer.js');
const { GpuReservedError } = await import('../src/ollama-backend.js');

const KEYS = [
  'FLEET_GPU_RESERVATION',
  'EPISODIC_MEMORY_SUMMARIZER_BACKEND',
  'EPISODIC_MEMORY_OLLAMA_URL',
  'EPISODIC_MEMORY_OLLAMA_MODEL',
  'EPISODIC_MEMORY_OLLAMA_FALLBACK_MODEL',
];
const saved: Record<string, string | undefined> = {};
for (const k of KEYS) saved[k] = process.env[k];

function sdkResult(text: string) {
  return (async function* () {
    yield { type: 'result', subtype: 'success', is_error: false, result: text };
  })();
}

function ollamaReply(text: string) {
  return vi.fn(async () => new Response(JSON.stringify({ response: text }), { status: 200 }));
}

beforeEach(() => {
  queryMock.mockReset();
  delete process.env.FLEET_GPU_RESERVATION;
  process.env.EPISODIC_MEMORY_SUMMARIZER_BACKEND = 'ollama';
  process.env.EPISODIC_MEMORY_OLLAMA_URL = 'http://127.0.0.1:11434';
  process.env.EPISODIC_MEMORY_OLLAMA_MODEL = 'qwen3.8:27b';
  delete process.env.EPISODIC_MEMORY_OLLAMA_FALLBACK_MODEL;
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe('the ollama fallback model', () => {
  it('retries a failed ollama call on the fallback model when EPISODIC_MEMORY_OLLAMA_FALLBACK_MODEL is set', async () => {
    process.env.EPISODIC_MEMORY_OLLAMA_FALLBACK_MODEL = 'haiku';
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 500 })));
    queryMock.mockImplementation(() => sdkResult('<summary>from haiku</summary>'));
    await expect(callDigestModel('p')).resolves.toBe('<summary>from haiku</summary>');
    expect(queryMock).toHaveBeenCalledTimes(1);
    expect(queryMock.mock.calls[0][0].options.model).toBe('haiku');
  });

  it('uses the fallback model for a failed learning call too', async () => {
    process.env.EPISODIC_MEMORY_OLLAMA_FALLBACK_MODEL = 'haiku';
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('connect ECONNREFUSED'); }));
    queryMock.mockImplementation(() => sdkResult('tasks from haiku'));
    await expect(callLearnModel('p')).resolves.toBe('tasks from haiku');
    expect(queryMock.mock.calls[0][0].options.model).toBe('haiku');
  });

  it('keeps the old behaviour when the setting is unset: the ollama error propagates', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 500 })));
    await expect(callDigestModel('p')).rejects.toThrow(/HTTP 500/);
    expect(queryMock).not.toHaveBeenCalled();
  });

  it('does not fall back on a GPU reservation, so the reservation still defers the work', async () => {
    process.env.EPISODIC_MEMORY_OLLAMA_FALLBACK_MODEL = 'haiku';
    const { mkdtempSync, writeFileSync } = await import('fs');
    const { tmpdir } = await import('os');
    const { join } = await import('path');
    const dir = mkdtempSync(join(tmpdir(), 'em-fb-gpu-'));
    process.env.FLEET_GPU_RESERVATION = join(dir, 'gpu-reserved.json');
    writeFileSync(process.env.FLEET_GPU_RESERVATION, JSON.stringify({ holder: 'test' }));
    await expect(callDigestModel('p')).rejects.toBeInstanceOf(GpuReservedError);
    expect(queryMock).not.toHaveBeenCalled();
  });
});
