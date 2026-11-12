import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promptBudgetChars } from '../src/summarizer.js';
import { suppressConsole } from './test-utils.js';

suppressConsole();

const KEYS = ['EPISODIC_MEMORY_SUMMARIZER_BACKEND', 'EPISODIC_MEMORY_OLLAMA_MAX_PROMPT_CHARS'];
const saved: Record<string, string | undefined> = {};

describe('promptBudgetChars', () => {
  beforeEach(() => {
    for (const k of KEYS) saved[k] = process.env[k];
  });
  afterEach(() => {
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it('is 48000 on the claude backend, whatever the Ollama cap is', () => {
    process.env.EPISODIC_MEMORY_SUMMARIZER_BACKEND = 'claude';
    process.env.EPISODIC_MEMORY_OLLAMA_MAX_PROMPT_CHARS = '1000';
    expect(promptBudgetChars()).toBe(48000);
  });

  it('is 24000 on the ollama backend by default', () => {
    process.env.EPISODIC_MEMORY_SUMMARIZER_BACKEND = 'ollama';
    delete process.env.EPISODIC_MEMORY_OLLAMA_MAX_PROMPT_CHARS;
    expect(promptBudgetChars()).toBe(24000);
  });

  it('reads EPISODIC_MEMORY_OLLAMA_MAX_PROMPT_CHARS on the ollama backend', () => {
    process.env.EPISODIC_MEMORY_SUMMARIZER_BACKEND = 'ollama';
    process.env.EPISODIC_MEMORY_OLLAMA_MAX_PROMPT_CHARS = '10000';
    expect(promptBudgetChars()).toBe(10000);
  });

  it('floors a fractional cap the way the Ollama call does', () => {
    process.env.EPISODIC_MEMORY_SUMMARIZER_BACKEND = 'ollama';
    process.env.EPISODIC_MEMORY_OLLAMA_MAX_PROMPT_CHARS = '10000.5';
    expect(promptBudgetChars()).toBe(10000);
  });

  it('falls back to 24000 for an invalid cap', () => {
    process.env.EPISODIC_MEMORY_SUMMARIZER_BACKEND = 'ollama';
    for (const raw of ['abc', '0', '-5', '']) {
      process.env.EPISODIC_MEMORY_OLLAMA_MAX_PROMPT_CHARS = raw;
      expect(promptBudgetChars()).toBe(24000);
    }
  });
});
