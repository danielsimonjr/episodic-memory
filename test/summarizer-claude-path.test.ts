import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
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

beforeEach(() => {
  queryMock.mockReset();
});

afterEach(() => {
  delete process.env.EPISODIC_MEMORY_API_TIMEOUT_MS;
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

describe('summarizeConversation Claude path', () => {
  const exchanges = [
    ex('Help me build a parser for log files.', 'Sure — here is a streaming parser.'),
    ex('It crashes on empty lines.', 'Add a guard for empty input before parsing.'),
  ];

  it('summarizes from transcript text in a single SDK call and never attempts a doomed resume', async () => {
    // Resume of the original session always fails from the background-sync context
    // (the SDK resolves the session by the subprocess CWD-derived project dir, which
    // is the plugin dir, not the user's project), so we removed the resume attempt
    // entirely. A sessionId argument must NOT produce a `resume` option.
    queryMock.mockImplementationOnce(() =>
      sdkMessages([RESULT_SUCCESS('<summary>Summarized from transcript text.</summary>')]),
    );

    const summary = await summarizeConversation(exchanges, 'archived-session-uuid');

    expect(summary).toBe('Summarized from transcript text.');
    expect(queryMock).toHaveBeenCalledTimes(1);
    expect((queryMock.mock.calls[0][0] as any).options.resume).toBeUndefined();
    expect((queryMock.mock.calls[0][0] as any).prompt).toContain('streaming parser');
  });

  it('runs the summarizer subprocess in isolation (settingSources [], no MCP servers)', async () => {
    queryMock.mockImplementationOnce(() =>
      sdkMessages([RESULT_SUCCESS('<summary>ok</summary>')]),
    );

    await summarizeConversation(exchanges);

    const opts = (queryMock.mock.calls[0][0] as any).options;
    expect(opts.settingSources).toEqual([]);
    expect(opts.mcpServers).toEqual({});
  });

  it('caps the number of hierarchical chunks for very long conversations (F14)', async () => {
    // A huge conversation must not fan out one sequential SDK call per 8 exchanges
    // unbounded. With the cap, total calls stay bounded (<= MAX_CHUNKS + 1 synthesis).
    queryMock.mockImplementation(() =>
      sdkMessages([RESULT_SUCCESS('<summary>chunk</summary>')]),
    );
    const many: ConversationExchange[] = [];
    for (let i = 0; i < 400; i++) {
      many.push(ex(`User message number ${i} with enough text to be substantive.`, `Assistant reply ${i}.`));
    }

    await summarizeConversation(many);

    // Without the cap this would be ceil(400/8)=50 chunk calls + 1 synthesis = 51.
    // The cap must hold it well below that.
    expect(queryMock.mock.calls.length).toBeLessThanOrEqual(21);
  });

  it('throws a timeout error instead of hanging forever when the SDK subprocess never returns', async () => {
    // The root cause of the wedged orphans: callClaude awaited the SDK result with
    // no timeout, so a stalled subprocess blocked the sync indefinitely. callClaude
    // must abort via an AbortController after EPISODIC_MEMORY_API_TIMEOUT_MS and throw.
    process.env.EPISODIC_MEMORY_API_TIMEOUT_MS = '50';
    queryMock.mockImplementationOnce((arg: any) => {
      const ac: AbortController = arg.options.abortController;
      expect(ac).toBeInstanceOf(AbortController);
      return (async function* () {
        await new Promise<void>((_, reject) => {
          ac.signal.addEventListener('abort', () => reject(new Error('aborted by controller')));
        });
        yield RESULT_SUCCESS('never reached');
      })();
    });

    await expect(summarizeConversation(exchanges, 'whatever')).rejects.toThrow(/timed out/i);
  });
});
