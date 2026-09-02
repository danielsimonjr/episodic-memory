import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

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

let testDir: string, sourceDir: string, destDir: string;

beforeEach(() => {
  summarizeMock.mockReset();
  testDir = mkdtempSync(join(tmpdir(), 'em-audit-'));
  sourceDir = join(testDir, 'source');
  destDir = join(testDir, 'dest');
  mkdirSync(sourceDir, { recursive: true });
});
afterEach(() => {
  delete process.env.EPISODIC_MEMORY_MAX_SUMMARY_ATTEMPTS;
  try { rmSync(testDir, { recursive: true, force: true }); } catch {}
});

describe('empty -summary.txt must always carry a recorded REASON', () => {
  // THE DEFECT: giving up wrote the empty sentinel and then DELETED the failure record, so a
  // permanently-failed summary became byte-identical to a legitimately-empty one. Measured on
  // this machine 2026-09-02: 2,919 zero-byte summaries of 6,762, and ZERO failure markers.
  it('KEEPS the failure marker when it gives up, flagged as terminal', async () => {
    process.env.EPISODIC_MEMORY_MAX_SUMMARY_ATTEMPTS = '2';
    summarizeMock.mockRejectedValue(new Error('deterministic summary failure'));
    const id = '4444dddd-4444-4444-4444-444444444444';
    writeConversation(sourceDir, 'proj', `${id}.jsonl`);
    const summaryPath = join(destDir, 'proj', `${id}-summary.txt`);
    const failPath = join(destDir, 'proj', `${id}-summary.failed`);

    await syncConversations(sourceDir, destDir, { skipIndex: true });
    await syncConversations(sourceDir, destDir, { skipIndex: true });

    expect(existsSync(summaryPath)).toBe(true);            // sentinel still written
    expect(existsSync(failPath)).toBe(true);               // ...and the REASON survives
    const rec = JSON.parse(readFileSync(failPath, 'utf-8'));
    expect(rec.gaveUp).toBe(true);
    expect(typeof rec.lastError).toBe('string');
  });

  // REGRESSION: keeping the marker must not resurrect the poison-pill loop F1 fixed.
  it('still does NOT re-queue a conversation it gave up on', async () => {
    process.env.EPISODIC_MEMORY_MAX_SUMMARY_ATTEMPTS = '2';
    summarizeMock.mockRejectedValue(new Error('deterministic summary failure'));
    const id = '5555eeee-5555-5555-5555-555555555555';
    writeConversation(sourceDir, 'proj', `${id}.jsonl`);

    await syncConversations(sourceDir, destDir, { skipIndex: true });
    await syncConversations(sourceDir, destDir, { skipIndex: true });
    expect(summarizeMock).toHaveBeenCalledTimes(2);
    await syncConversations(sourceDir, destDir, { skipIndex: true });
    expect(summarizeMock).toHaveBeenCalledTimes(2);         // no third attempt
  });

  // An empty summary with NO marker at all is the legacy shape: unknown reason. It must be
  // COUNTED, because 43% of this machine's summaries are exactly that and nothing reported it.
  it('counts pre-existing empty summaries that carry no reason at all', async () => {
    summarizeMock.mockResolvedValue('a real summary');
    const id = '6666ffff-6666-6666-6666-666666666666';
    writeConversation(sourceDir, 'proj', `${id}.jsonl`);
    // First sync produces a real summary...
    await syncConversations(sourceDir, destDir, { skipIndex: true });
    // ...then simulate the legacy artefact: truncate it, leave no marker.
    writeFileSync(join(destDir, 'proj', `${id}-summary.txt`), '', 'utf-8');

    const r = await syncConversations(sourceDir, destDir, { skipIndex: true });
    expect(r.emptySummaries).toBe(1);
    expect(r.unexplainedEmptySummaries).toBe(1);
  });

  // A real summary must not be counted as empty - the control.
  it('does NOT count a healthy summary as empty', async () => {
    summarizeMock.mockResolvedValue('a real summary with content');
    const id = '7777aaaa-7777-7777-7777-777777777777';
    writeConversation(sourceDir, 'proj', `${id}.jsonl`);
    await syncConversations(sourceDir, destDir, { skipIndex: true });
    const r = await syncConversations(sourceDir, destDir, { skipIndex: true });
    expect(r.emptySummaries).toBe(0);
    expect(r.unexplainedEmptySummaries).toBe(0);
  });
});
