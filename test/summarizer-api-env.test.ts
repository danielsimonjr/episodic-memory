import { describe, it, expect, afterEach } from 'vitest';
import { getApiEnv } from '../src/summarizer.js';
import { SUMMARIZER_GUARD_ENV } from '../src/reentrancy.js';

describe('getApiEnv', () => {
  const keys = [
    'EPISODIC_MEMORY_API_BASE_URL',
    'EPISODIC_MEMORY_API_TOKEN',
    'EPISODIC_MEMORY_API_TIMEOUT_MS',
  ];
  const prev: Record<string, string | undefined> = {};

  afterEach(() => {
    for (const key of keys) {
      if (prev[key] === undefined) delete process.env[key];
      else process.env[key] = prev[key];
    }
  });

  it('always sets the reentrancy guard and accepts a safe https base URL', () => {
    for (const key of keys) prev[key] = process.env[key];
    process.env.EPISODIC_MEMORY_API_BASE_URL = 'https://api.example.com/v1';
    process.env.EPISODIC_MEMORY_API_TOKEN = 'tok';
    process.env.EPISODIC_MEMORY_API_TIMEOUT_MS = '5000';
    const env = getApiEnv();
    expect(env?.[SUMMARIZER_GUARD_ENV]).toBe('1');
    expect(env?.ANTHROPIC_BASE_URL).toBe('https://api.example.com/v1');
    expect(env?.ANTHROPIC_AUTH_TOKEN).toBe('tok');
    expect(env?.API_TIMEOUT_MS).toBe('5000');
  });

  it('ignores unsafe base URLs', () => {
    for (const key of keys) prev[key] = process.env[key];
    process.env.EPISODIC_MEMORY_API_BASE_URL = 'http://evil.example.com';
    delete process.env.EPISODIC_MEMORY_API_TOKEN;
    const env = getApiEnv();
    expect(env?.ANTHROPIC_BASE_URL).toBeUndefined();
    expect(env?.[SUMMARIZER_GUARD_ENV]).toBe('1');
  });
});
