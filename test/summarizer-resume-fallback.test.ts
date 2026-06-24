import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { ConversationExchange } from '../src/types.js';
import { safeRmSync } from './test-utils.js';

// Mock the Claude Agent SDK so we can drive callClaude's result messages without
// spawning a real `claude` subprocess. vi.hoisted lets the mock factory reference
// the spy that the tests configure per-case.
const { queryMock } = vi.hoisted(() => ({ queryMock: vi.fn() }));
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({ query: queryMock }));

const { extractSummary, summarizeConversation, isSessionResumable } = await import('../src/summarizer.js');

/** Build an async iterable of SDK messages, fresh each call. */
function sdkMessages(messages: unknown[]) {
  return (async function* () {
    for (const m of messages) yield m;
  })();
}

function ex(userMessage: string, assistantMessage: string, project = 'proj'): ConversationExchange {
  return {
    id: 'id',
    project,
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

// Per-test temp ~/.claude so isSessionResumable() probes an isolated projects dir.
let claudeDir: string;
let prevClaudeConfigDir: string | undefined;

function makeSessionFile(sessionId: string, project = 'proj'): void {
  const dir = path.join(claudeDir, 'projects', project);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${sessionId}.jsonl`), '{}\n', 'utf-8');
}

beforeEach(() => {
  queryMock.mockReset();
  prevClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR;
  claudeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'em-resume-'));
  process.env.CLAUDE_CONFIG_DIR = claudeDir;
});

afterEach(() => {
  if (prevClaudeConfigDir === undefined) {
    delete process.env.CLAUDE_CONFIG_DIR;
  } else {
    process.env.CLAUDE_CONFIG_DIR = prevClaudeConfigDir;
  }
  safeRmSync(claudeDir);
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

describe('isSessionResumable', () => {
  it('returns false for an empty session id', () => {
    expect(isSessionResumable(undefined)).toBe(false);
    expect(isSessionResumable('')).toBe(false);
  });

  it('returns false when no transcript exists under ~/.claude/projects/', () => {
    expect(isSessionResumable('ghost-session', 'proj')).toBe(false);
  });

  it('returns true when the transcript exists in the mirrored project subdir', () => {
    makeSessionFile('live-session', 'proj');
    expect(isSessionResumable('live-session', 'proj')).toBe(true);
  });

  it('finds the transcript via a scan when the project subdir name differs', () => {
    makeSessionFile('live-session', 'some-other-project');
    // Caller's project hint is wrong/absent, but the scan still locates the file.
    expect(isSessionResumable('live-session', 'proj')).toBe(true);
    expect(isSessionResumable('live-session')).toBe(true);
  });
});

describe('summarizeConversation resume handling', () => {
  const exchanges = [
    ex('Help me build a parser for log files.', 'Sure — here is a streaming parser.'),
    ex('It crashes on empty lines.', 'Add a guard for empty input before parsing.'),
  ];

  it('skips the resume attempt entirely when the session is not resumable', async () => {
    // No session file created → not resumable → must go straight to transcript text
    // without ever spawning the doomed resume subprocess.
    queryMock.mockImplementationOnce(() =>
      sdkMessages([RESULT_SUCCESS('<summary>Summarized from transcript text.</summary>')]),
    );

    const summary = await summarizeConversation(exchanges, 'archived-session-uuid');

    expect(summary).toBe('Summarized from transcript text.');
    expect(queryMock).toHaveBeenCalledTimes(1);
    expect((queryMock.mock.calls[0][0] as any).options.resume).toBeUndefined();
    expect((queryMock.mock.calls[0][0] as any).prompt).toContain('streaming parser');
  });

  it('falls back to transcript text when a resumable session fails to resume anyway', async () => {
    // Session file exists (passes the pre-check) but the SDK still errors — the
    // try/catch safety net must recover via transcript text.
    makeSessionFile('flaky-session', 'proj');
    queryMock
      .mockImplementationOnce(() => sdkMessages([RESULT_RESUME_FAILURE]))
      .mockImplementationOnce(() => sdkMessages([RESULT_SUCCESS('<summary>Built a streaming log parser; fixed empty-line crash.</summary>')]));

    const summary = await summarizeConversation(exchanges, 'flaky-session');

    expect(summary).toBe('Built a streaming log parser; fixed empty-line crash.');
    expect(queryMock).toHaveBeenCalledTimes(2);
    expect((queryMock.mock.calls[0][0] as any).options.resume).toBe('flaky-session');
    expect((queryMock.mock.calls[1][0] as any).options.resume).toBeUndefined();
    expect((queryMock.mock.calls[1][0] as any).prompt).toContain('streaming parser');
  });

  it('returns the resume-based summary without a fallback call when resume succeeds', async () => {
    makeSessionFile('live-session', 'proj');
    queryMock.mockImplementationOnce(() =>
      sdkMessages([RESULT_SUCCESS('<summary>Resumed-session summary.</summary>')]),
    );

    const summary = await summarizeConversation(exchanges, 'live-session');

    expect(summary).toBe('Resumed-session summary.');
    expect(queryMock).toHaveBeenCalledTimes(1);
    expect((queryMock.mock.calls[0][0] as any).options.resume).toBe('live-session');
  });
});
