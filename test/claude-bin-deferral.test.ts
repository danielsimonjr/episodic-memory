import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import type { ConversationExchange } from '../src/types.js';
import { safeRmSync } from './test-utils.js';

// The SDK is mocked, so no test starts a Claude Code process. A test that expects a deferral also
// expects no SDK call: before the fix, the summarizer ignored the variable and called the SDK.
const { queryMock } = vi.hoisted(() => ({ queryMock: vi.fn() }));
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({ query: queryMock }));

const { summarizeConversation, callLearnModel } = await import('../src/summarizer.js');
const { ClaudeBinError, CLAUDE_BIN_ENV } = await import('../src/claude-bin.js');
const { deferralDetail } = await import('../src/deferral.js');
const { GpuReservedError } = await import('../src/ollama-backend.js');

const KEYS = [
  CLAUDE_BIN_ENV,
  'EPISODIC_MEMORY_SUMMARIZER_BACKEND',
  'EPISODIC_MEMORY_OLLAMA_URL',
  'EPISODIC_MEMORY_OLLAMA_MODEL',
  'EPISODIC_MEMORY_OLLAMA_FALLBACK_MODEL',
];
const saved: Record<string, string | undefined> = {};
for (const k of KEYS) saved[k] = process.env[k];

let dir: string;
beforeEach(() => {
  queryMock.mockReset();
  dir = mkdtempSync(join(tmpdir(), 'em-claude-bin-defer-'));
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  safeRmSync(dir);
});

function exchanges(count: number): ConversationExchange[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `x${i}`,
    project: 'proj',
    timestamp: '2026-11-12T09:00:00.000Z',
    userMessage: `Question ${i} with enough text to count as a real exchange in the transcript`,
    assistantMessage: `Answer ${i} with enough text to count as a real exchange in the transcript`,
    archivePath: '/a.jsonl',
    lineStart: i * 2 + 1,
    lineEnd: i * 2 + 2,
  })) as ConversationExchange[];
}

/** A fake Claude Code executable: a .mjs file that prints a version. */
function fakeBin(version: string): string {
  const p = join(dir, `claude-${version}.mjs`);
  writeFileSync(p, `process.stdout.write(${JSON.stringify(`${version} (Claude Code)\n`)});`);
  return p;
}

function sdkResult(text: string) {
  return (async function* () {
    yield { type: 'result', subtype: 'success', is_error: false, result: text };
  })();
}

describe('deferralDetail', () => {
  it('returns the detail of a GPU reservation and of an unusable executable, and null for any other error', () => {
    expect(deferralDetail(new GpuReservedError('fleet GPU reserved by Starship'))).toBe('fleet GPU reserved by Starship');
    expect(deferralDetail(new ClaudeBinError('the binary is missing'))).toBe('the binary is missing');
    expect(deferralDetail(new Error('the model failed'))).toBeNull();
    expect(deferralDetail('a string')).toBeNull();
  });
});

describe('the summarizer with an unusable Claude Code executable', () => {
  beforeEach(() => {
    process.env.EPISODIC_MEMORY_SUMMARIZER_BACKEND = 'claude';
    process.env[CLAUDE_BIN_ENV] = join(dir, 'missing', 'claude.exe');
  });

  it('rejects a short conversation with ClaudeBinError and makes no SDK call', async () => {
    await expect(summarizeConversation(exchanges(3))).rejects.toBeInstanceOf(ClaudeBinError);
    expect(queryMock).not.toHaveBeenCalled();
  });

  it('rejects a long conversation with ClaudeBinError: a chunk does not skip the error', async () => {
    await expect(summarizeConversation(exchanges(20))).rejects.toBeInstanceOf(ClaudeBinError);
    expect(queryMock).not.toHaveBeenCalled();
  });

  it('rejects a learn text call with ClaudeBinError', async () => {
    await expect(callLearnModel('a prompt')).rejects.toBeInstanceOf(ClaudeBinError);
    expect(queryMock).not.toHaveBeenCalled();
  });

  // An unusable fallback counts as no fallback. A deferral here would hold back the whole queue on every run
  // behind one transcript that Ollama cannot summarize, while Ollama summarizes every other one.
  it('rejects a failed Ollama call with the Ollama error, not a deferral, when the Claude fallback is unusable', async () => {
    process.env.EPISODIC_MEMORY_SUMMARIZER_BACKEND = 'ollama';
    process.env.EPISODIC_MEMORY_OLLAMA_URL = 'http://127.0.0.1:9';
    process.env.EPISODIC_MEMORY_OLLAMA_MODEL = 'qwen3.8:27b';
    process.env.EPISODIC_MEMORY_OLLAMA_FALLBACK_MODEL = 'haiku';
    const error = await summarizeConversation(exchanges(3)).then(
      () => null,
      (e: unknown) => e
    );
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(ClaudeBinError);
    expect(deferralDetail(error)).toBeNull();
    expect(queryMock).not.toHaveBeenCalled();
  });
});

describe('the summarizer executable option', () => {
  beforeEach(() => {
    process.env.EPISODIC_MEMORY_SUMMARIZER_BACKEND = 'claude';
  });

  it('passes no executable option to the SDK when the variable is unset', async () => {
    delete process.env[CLAUDE_BIN_ENV];
    queryMock.mockImplementation(() => sdkResult('<summary>Did the thing.</summary>'));
    await expect(summarizeConversation(exchanges(3))).resolves.toBe('Did the thing.');
    const options = queryMock.mock.calls[0][0].options;
    expect('pathToClaudeCodeExecutable' in options).toBe(false);
  });

  it('passes the probed path to the SDK when the variable names a usable binary', async () => {
    const bin = fakeBin('2.1.318');
    process.env[CLAUDE_BIN_ENV] = bin;
    queryMock.mockImplementation(() => sdkResult('<summary>Did the thing.</summary>'));
    await expect(summarizeConversation(exchanges(3))).resolves.toBe('Did the thing.');
    expect(queryMock.mock.calls[0][0].options.pathToClaudeCodeExecutable).toBe(bin);
  });
});

// The data-safety case. A host sets the variable to a path that is gone, then sync runs. The sync must
// defer: no summary file, no failure record and no counted attempt, so the queue is the same afterwards.
describe('sync with an unusable Claude Code executable', () => {
  const IDS = [
    '7777aaaa-7777-7777-7777-777777777777',
    '8888bbbb-8888-8888-8888-888888888888',
    '9999cccc-9999-9999-9999-999999999999',
  ];

  function writeConversation(root: string, name: string): void {
    mkdirSync(join(root, 'proj'), { recursive: true });
    const lines = [
      { type: 'user', uuid: 'u1', parentUuid: null, timestamp: '2025-10-01T13:00:00Z', isSidechain: false,
        message: { role: 'user', content: 'A real question with enough substance to summarize.' } },
      { type: 'assistant', uuid: 'a1', parentUuid: 'u1', timestamp: '2025-10-01T13:00:01Z', isSidechain: false,
        message: { role: 'assistant', content: 'A real, substantive answer to the question.' } },
    ];
    writeFileSync(join(root, 'proj', name), lines.map(l => JSON.stringify(l)).join('\n'), 'utf-8');
  }

  it('writes no summary and no failure record, counts no attempt, and reports the deferral', async () => {
    process.env.EPISODIC_MEMORY_SUMMARIZER_BACKEND = 'claude';
    process.env[CLAUDE_BIN_ENV] = join(dir, 'missing', 'claude.exe');
    const { syncConversations } = await import('../src/sync.js');
    const sourceDir = join(dir, 'source');
    const destDir = join(dir, 'dest');
    for (const id of IDS) writeConversation(sourceDir, `${id}.jsonl`);

    const result = await syncConversations(sourceDir, destDir, { skipIndex: true });

    expect(queryMock).not.toHaveBeenCalled();
    expect(result.summariesDeferred).toMatch(new RegExp(`${CLAUDE_BIN_ENV}=.*does not exist`));
    expect(result.summaryAttempts).toBe(0);
    expect(result.errors).toEqual([]);
    expect(result.pendingSummaries).toBe(IDS.length);
    const written = readdirSync(join(destDir, 'proj'));
    expect(written.filter(f => f.endsWith('-summary.txt'))).toEqual([]);
    expect(written.filter(f => f.endsWith('.failed'))).toEqual([]);
    for (const id of IDS) expect(existsSync(join(destDir, 'proj', `${id}.jsonl`))).toBe(true);
  });
});
