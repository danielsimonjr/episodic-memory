import { describe, it, expect, afterEach } from 'vitest';
import { summarizerBackend, callOllama, stripThinking } from '../src/ollama-backend.js';

const KEYS = ['EPISODIC_MEMORY_SUMMARIZER_BACKEND', 'EPISODIC_MEMORY_OLLAMA_URL', 'EPISODIC_MEMORY_OLLAMA_MODEL'];
const saved: Record<string, string | undefined> = {};
for (const k of KEYS) saved[k] = process.env[k];
afterEach(() => { for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } });

const okFetch = (body: any, capture?: any[]) => (async (url: string, init: any) => {
  capture?.push({ url, body: JSON.parse(init.body) });
  return { ok: true, status: 200, json: async () => body } as any;
}) as any;

describe('summarizerBackend', () => {
  it('defaults to claude and selects ollama only when asked', () => {
    delete process.env.EPISODIC_MEMORY_SUMMARIZER_BACKEND;
    expect(summarizerBackend()).toBe('claude');
    process.env.EPISODIC_MEMORY_SUMMARIZER_BACKEND = 'OLLAMA';
    expect(summarizerBackend()).toBe('ollama');
  });
});

describe('callOllama', () => {
  it('posts a non-streaming, non-thinking, temperature-0 request to the named model', async () => {
    process.env.EPISODIC_MEMORY_OLLAMA_URL = 'http://127.0.0.1:11434';
    process.env.EPISODIC_MEMORY_OLLAMA_MODEL = 'qwen3.8:27b';
    const cap: any[] = [];
    const out = await callOllama('hello', { fetchImpl: okFetch({ response: '<summary>x</summary>' }, cap) });
    expect(out).toBe('<summary>x</summary>');
    expect(cap[0].url).toBe('http://127.0.0.1:11434/api/generate');
    expect(cap[0].body).toMatchObject({ model: 'qwen3.8:27b', prompt: 'hello', stream: false, think: false, options: { temperature: 0 } });
  });

  it('refuses to run without an explicit model (a default would evict the shared host model)', async () => {
    process.env.EPISODIC_MEMORY_OLLAMA_URL = 'http://127.0.0.1:11434';
    delete process.env.EPISODIC_MEMORY_OLLAMA_MODEL;
    await expect(callOllama('x', { fetchImpl: okFetch({ response: 'y' }) })).rejects.toThrow(/EPISODIC_MEMORY_OLLAMA_MODEL/);
  });

  it('refuses plain http to a non-loopback host: transcripts must not cross a network unencrypted', async () => {
    process.env.EPISODIC_MEMORY_OLLAMA_URL = 'http://192.168.1.169:11434';
    process.env.EPISODIC_MEMORY_OLLAMA_MODEL = 'm';
    await expect(callOllama('x', { fetchImpl: okFetch({ response: 'y' }) })).rejects.toThrow(/localhost/);
  });

  it('truncates an oversized prompt to the character budget', async () => {
    process.env.EPISODIC_MEMORY_OLLAMA_URL = 'http://localhost:11434';
    process.env.EPISODIC_MEMORY_OLLAMA_MODEL = 'm';
    const cap: any[] = [];
    await callOllama('a'.repeat(50), { fetchImpl: okFetch({ response: '<summary>ok</summary>' }, cap), maxPromptChars: 10 });
    expect(cap[0].body.prompt.length).toBe(10);
  });

  it('rejects a reply with no <summary> tags: a small model that CONTINUES the transcript is not a summary', async () => {
    process.env.EPISODIC_MEMORY_OLLAMA_URL = 'http://localhost:11434';
    process.env.EPISODIC_MEMORY_OLLAMA_MODEL = 'm';
    // Both shapes measured from qwen2.5vl:3b on a real transcript, 2026-09-17.
    await expect(callOllama('x', { fetchImpl: okFetch({ response: "Sure, I can help with that. Let's update the doc comment." }) })).rejects.toThrow(/summary/);
    await expect(callOllama('x', { fetchImpl: okFetch({ response: '<|Summary of changes|' }) })).rejects.toThrow(/summary/);
  });

  it('throws on an HTTP error or an empty response so the caller records a failure', async () => {
    process.env.EPISODIC_MEMORY_OLLAMA_URL = 'http://localhost:11434';
    process.env.EPISODIC_MEMORY_OLLAMA_MODEL = 'm';
    const bad = (async () => ({ ok: false, status: 404, json: async () => ({ error: 'model not found' }) })) as any;
    await expect(callOllama('x', { fetchImpl: bad })).rejects.toThrow(/404/);
    await expect(callOllama('x', { fetchImpl: okFetch({ response: '   ' }) })).rejects.toThrow(/empty/);
  });
});

describe('stripThinking', () => {
  it('removes <think> blocks a reasoning model may emit', () => {
    expect(stripThinking('<think>hmm</think>\n<summary>s</summary>')).toBe('<summary>s</summary>');
  });
});
