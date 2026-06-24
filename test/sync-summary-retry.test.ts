import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// Mock the summarizer so we can force failures (poison-pill) and successes without
// spawning real SDK subprocesses. sync.ts imports it via dynamic import('./summarizer.js').
const { summarizeMock } = vi.hoisted(() => ({ summarizeMock: vi.fn() }));
vi.mock('../src/summarizer.js', () => ({ summarizeConversation: summarizeMock }));

const { syncConversations } = await import('../src/sync.js');

function writeConversation(dir: string, project: string, name: string): string {
  mkdirSync(join(dir, project), { recursive: true });
  const content =
    JSON.stringify({
      type: 'user', uuid: 'u1', parentUuid: null, timestamp: '2025-10-01T13:00:00Z',
      isSidechain: false, message: { role: 'user', content: 'A real question with enough substance to summarize.' },
    }) + '\n' +
    JSON.stringify({
      type: 'assistant', uuid: 'a1', parentUuid: 'u1', timestamp: '2025-10-01T13:00:01Z',
      isSidechain: false, message: { role: 'assistant', content: 'A real, substantive answer to the question.' },
    });
  const file = join(dir, project, name);
  writeFileSync(file, content, 'utf-8');
  return file;
}

let testDir: string;
let sourceDir: string;
let destDir: string;

beforeEach(() => {
  summarizeMock.mockReset();
  testDir = mkdtempSync(join(tmpdir(), 'em-retry-'));
  sourceDir = join(testDir, 'source');
  destDir = join(testDir, 'dest');
  mkdirSync(sourceDir, { recursive: true });
});

afterEach(() => {
  delete process.env.EPISODIC_MEMORY_MAX_SUMMARY_ATTEMPTS;
  try { rmSync(testDir, { recursive: true, force: true }); } catch {}
});

describe('summary failure handling (F1 poison-pill cap)', () => {
  it('stops re-queuing a conversation that always fails after the attempt cap, writing a sentinel', async () => {
    process.env.EPISODIC_MEMORY_MAX_SUMMARY_ATTEMPTS = '2';
    summarizeMock.mockRejectedValue(new Error('deterministic summary failure'));
    const id = '2222bbbb-2222-2222-2222-222222222222';
    writeConversation(sourceDir, 'proj', `${id}.jsonl`);
    const summaryPath = join(destDir, 'proj', `${id}-summary.txt`);

    // Attempt 1
    await syncConversations(sourceDir, destDir, { skipIndex: true });
    expect(summarizeMock).toHaveBeenCalledTimes(1);
    expect(existsSync(summaryPath)).toBe(false); // not given up yet

    // Attempt 2 reaches the cap → sentinel written
    await syncConversations(sourceDir, destDir, { skipIndex: true });
    expect(summarizeMock).toHaveBeenCalledTimes(2);
    expect(existsSync(summaryPath)).toBe(true);

    // Third sync must NOT re-attempt — the sentinel marks it done
    await syncConversations(sourceDir, destDir, { skipIndex: true });
    expect(summarizeMock).toHaveBeenCalledTimes(2);
  });

  it('clears the failure record and writes the real summary if a later attempt succeeds', async () => {
    process.env.EPISODIC_MEMORY_MAX_SUMMARY_ATTEMPTS = '5';
    const id = '3333cccc-3333-3333-3333-333333333333';
    writeConversation(sourceDir, 'proj', `${id}.jsonl`);
    const summaryPath = join(destDir, 'proj', `${id}-summary.txt`);

    summarizeMock.mockRejectedValueOnce(new Error('transient'));
    await syncConversations(sourceDir, destDir, { skipIndex: true });
    expect(existsSync(summaryPath)).toBe(false);

    summarizeMock.mockResolvedValueOnce('<summary>Recovered summary.</summary>');
    await syncConversations(sourceDir, destDir, { skipIndex: true });
    expect(readFileSync(summaryPath, 'utf-8')).toContain('Recovered summary');
  });
});

describe('summary budget (F2)', () => {
  it('honors summaryLimit and reports the number of attempts', async () => {
    summarizeMock.mockResolvedValue('<summary>ok</summary>');
    for (let i = 0; i < 3; i++) {
      writeConversation(sourceDir, 'proj', `4444dddd-4444-4444-4444-${String(i).padStart(12, '0')}.jsonl`);
    }

    const result = await syncConversations(sourceDir, destDir, { skipIndex: true, summaryLimit: 1 });

    expect(summarizeMock).toHaveBeenCalledTimes(1);
    expect(result.summaryAttempts).toBe(1);
    expect(result.summarized).toBe(1);
  });
});

describe('non-UUID session files (F9)', () => {
  it('still queues a conversation whose filename has no UUID', async () => {
    summarizeMock.mockResolvedValue('<summary>named file summary</summary>');
    writeConversation(sourceDir, 'proj', 'human-named-transcript.jsonl');

    const result = await syncConversations(sourceDir, destDir, { skipIndex: true });

    expect(summarizeMock).toHaveBeenCalledTimes(1);
    expect(result.summarized).toBe(1);
  });
});
