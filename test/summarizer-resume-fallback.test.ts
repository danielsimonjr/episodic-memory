import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { ConversationExchange } from '../src/types.js';

// Mock the Claude Agent SDK so we can drive callClaude's result messages without
// spawning a real `claude` subprocess. vi.hoisted lets the mock factory reference
// the spy that the tests configure per-case.
const { queryMock } = vi.hoisted(() => ({ queryMock: vi.fn() }));
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({ query: queryMock }));

const { extractSummary, summarizeConversation } = await import('../src/summarizer.js');

/** Build an async iterable of SDK messages, fresh each call. */
function sdkMessages(messages: unknown[]) {
  return (async function* () {
    for (const m of messages) yield m;
  })();
}

function ex(userMessage: string, assistantMessage: string): ConversationExchange {
  return {
    id: 'id',
    project: 'proj',
    timestamp: '2026-01-01T00:00:00Z',
    userMessage,
    assistantMessage,
    archivePath: '/archive/x.jsonl',
    lineStart: 0,
    lineEnd: 1,
  };
}

const RESULT_SUCCESS = (text: string) => ({
  type: 'result',
  subtype: 'success',
  is_error: false,
  result: text,
});

// What the SDK actually returns when resuming a session that no longer exists:
// subtype 'error_during_execution', is_error true, and NO usable `result` field.
const RESULT_RESUME_FAILURE = {
  type: 'result',
  subtype: 'error_during_execution',
  is_error: true,
  result: undefined,
};

beforeEach(() => {
  queryMock.mockReset();
});

describe('extractSummary', () => {
  it('extracts the text inside <summary> tags', () => {
    expect(extractSummary('<summary>Did the thing.</summary>')).toBe('Did the thing.');
  });

  it('falls back to the trimmed text when no tags are present', () => {
    expect(extractSummary('  no tags here  ')).toBe('no tags here');
  });

  it('throws a clear error (not a cryptic .match crash) when given no text', () => {
    // Regression for the sync-orphan storm: callClaude could return undefined when
    // the SDK errored, and extractSummary crashed with
    // "Cannot read properties of undefined (reading 'match')".
    expect(() => extractSummary(undefined as unknown as string)).toThrow(/no text/i);
    expect(() => extractSummary(undefined as unknown as string)).not.toThrow(/match/);
  });
});

describe('summarizeConversation resume fallback', () => {
  const exchanges = [
    ex('Help me build a parser for log files.', 'Sure — here is a streaming parser.'),
    ex('It crashes on empty lines.', 'Add a guard for empty input before parsing.'),
  ];

  it('falls back to transcript text when resuming the original session fails', async () => {
    queryMock
      .mockImplementationOnce(() => sdkMessages([RESULT_RESUME_FAILURE]))
      .mockImplementationOnce(() => sdkMessages([RESULT_SUCCESS('<summary>Built a streaming log parser; fixed empty-line crash.</summary>')]));

    const summary = await summarizeConversation(exchanges, 'dead-session-uuid');

    expect(summary).toBe('Built a streaming log parser; fixed empty-line crash.');
    expect(queryMock).toHaveBeenCalledTimes(2);
    // First attempt resumes the original session...
    expect((queryMock.mock.calls[0][0] as any).options.resume).toBe('dead-session-uuid');
    // ...the fallback does NOT resume and includes the transcript text in the prompt.
    expect((queryMock.mock.calls[1][0] as any).options.resume).toBeUndefined();
    expect((queryMock.mock.calls[1][0] as any).prompt).toContain('streaming parser');
  });

  it('returns the resume-based summary without a fallback call when resume succeeds', async () => {
    queryMock.mockImplementationOnce(() =>
      sdkMessages([RESULT_SUCCESS('<summary>Resumed-session summary.</summary>')]),
    );

    const summary = await summarizeConversation(exchanges, 'live-session-uuid');

    expect(summary).toBe('Resumed-session summary.');
    expect(queryMock).toHaveBeenCalledTimes(1);
    expect((queryMock.mock.calls[0][0] as any).options.resume).toBe('live-session-uuid');
  });
});
