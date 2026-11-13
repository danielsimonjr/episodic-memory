import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import type { ConversationExchange } from '../src/types.js';
import { safeRmSync } from './test-utils.js';

// The SDK is mocked, so no test starts a Claude Code process.
// A failed login is global: every later call fails the same way. The summary loop must stop at the first
// failure and count no attempt. Before the fix, each queued conversation made one call and lost one attempt.
const { queryMock } = vi.hoisted(() => ({ queryMock: vi.fn() }));
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({ query: queryMock }));

const { summarizeConversation } = await import('../src/summarizer.js');
const { ClaudeAuthError, deferralDetail, isClaudeAuthFailure } = await import('../src/deferral.js');

const KEYS = [
  'EPISODIC_MEMORY_SUMMARIZER_BACKEND',
  'EPISODIC_MEMORY_OLLAMA_URL',
  'EPISODIC_MEMORY_OLLAMA_MODEL',
  'EPISODIC_MEMORY_OLLAMA_FALLBACK_MODEL',
];
const saved: Record<string, string | undefined> = {};
for (const k of KEYS) saved[k] = process.env[k];

// A secret-shaped value, built at run time so that no secret scanner flags the source file.
const FAKE_KEY = 'sk-' + 'a'.repeat(32);
const AUTH_TEXT =
  'Failed to authenticate. API Error: 401 {"type":"error","error":{"type":"authentication_error",' +
  '"message":"OAuth token has expired"}}';

let dir: string;
beforeEach(() => {
  queryMock.mockReset();
  dir = mkdtempSync(join(tmpdir(), 'em-claude-auth-'));
  process.env.EPISODIC_MEMORY_SUMMARIZER_BACKEND = 'claude';
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
    timestamp: '2026-11-13T09:00:00.000Z',
    userMessage: `Question ${i} with enough text to count as a real exchange in the transcript`,
    assistantMessage: `Answer ${i} with enough text to count as a real exchange in the transcript`,
    archivePath: '/a.jsonl',
    lineStart: i * 2 + 1,
    lineEnd: i * 2 + 2,
  })) as ConversationExchange[];
}

function sdkError(status: number | null, text: string, subtype = 'success') {
  return (async function* () {
    yield { type: 'result', subtype, is_error: true, api_error_status: status, result: text };
  })();
}

async function failure(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => null,
    (e: unknown) => e
  );
}

describe('isClaudeAuthFailure', () => {
  // One text for each branch of the match, so that each branch has its own test.
  it.each([
    'Failed to authenticate.',
    '{"error":{"type":"authentication_error"}}',
    'The OAuth access token has expired',
    'API Error: 401 Invalid bearer token',
  ])('matches %j without a status', (text) => {
    expect(isClaudeAuthFailure(undefined, text)).toBe(true);
  });

  it('matches status 401 with any text', () => {
    expect(isClaudeAuthFailure(401, '')).toBe(true);
  });

  it.each([
    [529, 'API Error: 529 Overloaded'],
    [400, 'API Error: 400 prompt is too long at line 401'],
    [null, 'request 401 of 900 failed'],
  ])('does not match status %j with text %j', (status, text) => {
    expect(isClaudeAuthFailure(status, text)).toBe(false);
  });
});

describe('the SDK error of a summary call', () => {
  it('keeps the status and the result text of an ordinary API error', async () => {
    queryMock.mockImplementation(() => sdkError(529, 'API Error: 529 Overloaded'));
    const error = await failure(summarizeConversation(exchanges(3)));
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain('status=529');
    expect((error as Error).message).toContain('Overloaded');
    expect(deferralDetail(error)).toBeNull();
  });

  it('redacts a secret in the result text', async () => {
    queryMock.mockImplementation(() => sdkError(500, `API Error: 500 request with key ${FAKE_KEY} failed`));
    const error = await failure(summarizeConversation(exchanges(3)));
    expect((error as Error).message).toContain('[redacted]');
    expect((error as Error).message).not.toContain(FAKE_KEY);
  });

  it('is not a login failure when the text holds 401 for another reason', async () => {
    queryMock.mockImplementation(() => sdkError(400, 'API Error: 400 prompt is too long at line 401'));
    const error = await failure(summarizeConversation(exchanges(3)));
    expect(error).not.toBeInstanceOf(ClaudeAuthError);
    expect(deferralDetail(error)).toBeNull();
  });

  it('bounds the result text', async () => {
    queryMock.mockImplementation(() => sdkError(500, 'x'.repeat(5000)));
    const error = await failure(summarizeConversation(exchanges(3)));
    expect((error as Error).message.length).toBeLessThan(1000);
  });
});

describe('a failed Claude Code login', () => {
  it('rejects a short conversation with ClaudeAuthError, and the detail names 401', async () => {
    queryMock.mockImplementation(() => sdkError(401, AUTH_TEXT));
    const error = await failure(summarizeConversation(exchanges(3)));
    expect(error).toBeInstanceOf(ClaudeAuthError);
    expect(deferralDetail(error)).toMatch(/401/);
  });

  it('counts as a login failure from status 401 alone, when the text holds no login phrase', async () => {
    queryMock.mockImplementation(() => sdkError(401, 'Invalid credentials'));
    const error = await failure(summarizeConversation(exchanges(3)));
    expect(error).toBeInstanceOf(ClaudeAuthError);
    expect(deferralDetail(error)).toContain('status 401');
  });

  it('counts as a login failure from the result text alone, without a status', async () => {
    queryMock.mockImplementation(() => sdkError(null, AUTH_TEXT));
    expect(await failure(summarizeConversation(exchanges(3)))).toBeInstanceOf(ClaudeAuthError);
  });

  it('counts as a login failure when the SDK throws an error that names the 401', async () => {
    queryMock.mockImplementation(() =>
      (async function* () {
        throw new Error(`Claude Code process exited with code 1: ${AUTH_TEXT}`);
      })()
    );
    expect(await failure(summarizeConversation(exchanges(3)))).toBeInstanceOf(ClaudeAuthError);
  });

  it('rejects a long conversation at the first chunk: a chunk does not skip the error', async () => {
    queryMock.mockImplementation(() => sdkError(401, AUTH_TEXT));
    expect(await failure(summarizeConversation(exchanges(20)))).toBeInstanceOf(ClaudeAuthError);
    expect(queryMock).toHaveBeenCalledTimes(1);
  });

  // A failed fallback login counts as no fallback, as an unusable executable does. A deferral here would hold
  // back the whole queue behind one transcript that Ollama cannot summarize.
  it('rejects a failed Ollama call with the Ollama error, not a deferral, when the Claude fallback login fails', async () => {
    process.env.EPISODIC_MEMORY_SUMMARIZER_BACKEND = 'ollama';
    process.env.EPISODIC_MEMORY_OLLAMA_URL = 'http://127.0.0.1:9';
    process.env.EPISODIC_MEMORY_OLLAMA_MODEL = 'qwen3.8:27b';
    process.env.EPISODIC_MEMORY_OLLAMA_FALLBACK_MODEL = 'haiku';
    queryMock.mockImplementation(() => sdkError(401, AUTH_TEXT));
    const error = await failure(summarizeConversation(exchanges(3)));
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(ClaudeAuthError);
    expect(deferralDetail(error)).toBeNull();
    expect(queryMock).toHaveBeenCalledTimes(1);
  });
});

// The data-safety case. Five conversations wait for a summary, and the login has expired. The sync must make
// one call, then defer: no summary file, no failure record and no counted attempt.
describe('sync with a failed Claude Code login', () => {
  const IDS = [
    '1111aaaa-1111-4111-8111-111111111111',
    '2222bbbb-2222-4222-8222-222222222222',
    '3333cccc-3333-4333-8333-333333333333',
    '4444dddd-4444-4444-8444-444444444444',
    '5555eeee-5555-4555-8555-555555555555',
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

  it('makes one call for five queued files, counts no attempt and reports the deferral', async () => {
    queryMock.mockImplementation(() => sdkError(401, AUTH_TEXT));
    const { syncConversations } = await import('../src/sync.js');
    const sourceDir = join(dir, 'source');
    const destDir = join(dir, 'dest');
    for (const id of IDS) writeConversation(sourceDir, `${id}.jsonl`);

    const result = await syncConversations(sourceDir, destDir, { skipIndex: true });

    expect(queryMock).toHaveBeenCalledTimes(1);
    expect(result.summariesDeferred).toMatch(/401/);
    expect(result.summaryAttempts).toBe(0);
    expect(result.errors).toEqual([]);
    expect(result.pendingSummaries).toBe(IDS.length);
    const written = readdirSync(join(destDir, 'proj'));
    expect(written.filter(f => f.endsWith('-summary.txt'))).toEqual([]);
    expect(written.filter(f => f.endsWith('.failed'))).toEqual([]);
    for (const id of IDS) expect(existsSync(join(destDir, 'proj', `${id}.jsonl`))).toBe(true);
  });
});
