import { describe, it, expect } from 'vitest';
import { existsSync } from 'fs';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { buildCodexSummarizerCommand, callLearnModel, runCodexCommand } from '../src/summarizer.js';
import { REAL_SDK_MESSAGE, takeRealSdkCalls } from './real-sdk-guard.js';

// `setup-env.ts` replaces `query` of the Claude Agent SDK in every test file. Each test below drains
// the recorded calls, because the `afterEach` of the setup file fails a test that leaves a call behind.

describe('real SDK guard', () => {
  it('fails a learn-model call that has no fake at once, and records the call', async () => {
    const started = Date.now();
    await expect(callLearnModel('a prompt that must not reach a model')).rejects.toThrow(REAL_SDK_MESSAGE);
    expect(Date.now() - started).toBeLessThan(2000);
    expect(takeRealSdkCalls()).toEqual(['a prompt that must not reach a model']);
  });

  it('replaces query for a direct import of the SDK too', () => {
    expect(() => query({ prompt: 'direct' } as never)).toThrow(REAL_SDK_MESSAGE);
    expect(takeRealSdkCalls()).toEqual(['direct']);
  });

  it('keeps the other exports of the SDK', async () => {
    const sdk = await import('@anthropic-ai/claude-agent-sdk');
    expect(typeof sdk.tool).toBe('function');
    expect(typeof sdk.createSdkMcpServer).toBe('function');
  });

  it('records nothing when no test reaches the SDK', () => {
    expect(takeRealSdkCalls()).toEqual([]);
  });
});

describe('codex command in tests', () => {
  it('names a codex executable that does not exist, so a codex summary fails at once', async () => {
    const bin = process.env.EPISODIC_MEMORY_CODEX_BIN;
    expect(bin).toBeTruthy();
    expect(existsSync(bin!)).toBe(false);
    const command = buildCodexSummarizerCommand({ sessionId: 's', prompt: 'p' });
    expect(command.command).toBe(bin);
    const started = Date.now();
    await expect(runCodexCommand(command)).rejects.toThrow();
    expect(Date.now() - started).toBeLessThan(5000);
  });
});
