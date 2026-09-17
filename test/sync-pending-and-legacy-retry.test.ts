import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync, statSync } from 'fs';
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

// A transcript the parser yields zero exchanges from: no user/assistant message pairs.
function writeEmptyConversation(dir: string, project: string, name: string): string {
  mkdirSync(join(dir, project), { recursive: true });
  const file = join(dir, project, name);
  writeFileSync(file, JSON.stringify({ type: 'summary', summary: 'x', leafUuid: 'l1' }) + '\n', 'utf-8');
  return file;
}

const uuid = (n: number) => `${String(n).padStart(8, '0')}-aaaa-4aaa-8aaa-aaaaaaaaaaaa`;

let testDir: string, sourceDir: string, destDir: string;
beforeEach(() => {
  summarizeMock.mockReset();
  testDir = mkdtempSync(join(tmpdir(), 'em-pending-'));
  sourceDir = join(testDir, 'source');
  destDir = join(testDir, 'dest');
  mkdirSync(sourceDir, { recursive: true });
});
afterEach(() => {
  delete process.env.EPISODIC_MEMORY_MAX_SUMMARY_ATTEMPTS;
  try { rmSync(testDir, { recursive: true, force: true }); } catch {}
});

// ---------------------------------------------------------------------------------------------
// DEFECT A (2026-09-17): pendingSummaries was assigned BEFORE the summarise loop, although its
// own doc comment says "still LACK a summary AFTER this run". Production symptoms on the ZBOOK:
//   'Summarized: 4 (4 still pending)'                       - contradictory
//   'Sync finished WITHOUT SUMMARISING ANYTHING - 3 ...'    - a FALSE ALARM: all 3 were
//                                                             legitimate no-exchanges sentinels
// ---------------------------------------------------------------------------------------------
describe('pendingSummaries is measured AFTER the work', () => {
  it('is 0 once every queued conversation got a real summary', async () => {
    summarizeMock.mockResolvedValue('a real summary');
    writeConversation(sourceDir, 'proj', `${uuid(1)}.jsonl`);
    writeConversation(sourceDir, 'proj', `${uuid(2)}.jsonl`);
    const r = await syncConversations(sourceDir, destDir, { skipIndex: true });
    expect(r.summarized).toBe(2);
    expect(r.pendingSummaries).toBe(0);
  });

  it('is 0 when every queued conversation was a no-exchanges sentinel (the false alarm)', async () => {
    writeEmptyConversation(sourceDir, 'proj', `${uuid(3)}.jsonl`);
    writeEmptyConversation(sourceDir, 'proj', `${uuid(4)}.jsonl`);
    writeEmptyConversation(sourceDir, 'proj', `${uuid(5)}.jsonl`);
    const r = await syncConversations(sourceDir, destDir, { skipIndex: true });
    expect(summarizeMock).not.toHaveBeenCalled();
    expect(r.summarized).toBe(0);
    expect(r.pendingSummaries).toBe(0);
  });

  it('CONTROL: still counts a conversation whose summary failed and will retry', async () => {
    summarizeMock.mockRejectedValue(new Error('transient summariser failure'));
    writeConversation(sourceDir, 'proj', `${uuid(6)}.jsonl`);
    const r = await syncConversations(sourceDir, destDir, { skipIndex: true });
    expect(r.summarized).toBe(0);
    expect(r.pendingSummaries).toBe(1);
  });

  it('CONTROL: still counts conversations deferred past the per-run budget', async () => {
    summarizeMock.mockResolvedValue('a real summary');
    for (const n of [7, 8, 9]) writeConversation(sourceDir, 'proj', `${uuid(n)}.jsonl`);
    const r = await syncConversations(sourceDir, destDir, { skipIndex: true, summaryLimit: 1 });
    expect(r.summarized).toBe(1);
    expect(r.pendingSummaries).toBe(2);
  });
});

// ---------------------------------------------------------------------------------------------
// DEFECT B (2026-09-17): an EMPTY -summary.txt with NO reason marker satisfies the needs-summary
// gate forever. Those are the legacy artefacts of pre-1.5.2 give-ups that deleted their marker;
// 27 remained on the ZBOOK, reported every run as 'SILENT FAILURE' and never retried. They are
// now re-queued in the LAST priority tier inside the normal budget, so they drain without the
// storm the old comment feared, and each one ends explained.
// ---------------------------------------------------------------------------------------------
describe('legacy empty summaries with no reason are retried, last and within budget', () => {
  it('re-summarises a legacy unexplained empty summary', async () => {
    summarizeMock.mockResolvedValue('recovered summary');
    const id = uuid(10);
    writeConversation(sourceDir, 'proj', `${id}.jsonl`);
    await syncConversations(sourceDir, destDir, { skipIndex: true });
    const summaryPath = join(destDir, 'proj', `${id}-summary.txt`);
    writeFileSync(summaryPath, '', 'utf-8');                  // legacy shape: empty, no marker
    summarizeMock.mockClear();

    const r = await syncConversations(sourceDir, destDir, { skipIndex: true });
    expect(summarizeMock).toHaveBeenCalledTimes(1);
    expect(statSync(summaryPath).size).toBeGreaterThan(0);
    expect(r.summarized).toBe(1);
    const r2 = await syncConversations(sourceDir, destDir, { skipIndex: true });
    expect(r2.unexplainedEmptySummaries).toBe(0);
  });

  it('a legacy empty with no exchanges becomes EXPLAINED without an SDK call', async () => {
    const id = uuid(11);
    writeEmptyConversation(sourceDir, 'proj', `${id}.jsonl`);
    mkdirSync(join(destDir, 'proj'), { recursive: true });
    await syncConversations(sourceDir, destDir, { skipIndex: true });
    const failPath = join(destDir, 'proj', `${id}-summary.failed`);
    rmSync(failPath, { force: true });                        // strip the reason -> legacy shape
    const r = await syncConversations(sourceDir, destDir, { skipIndex: true });
    expect(summarizeMock).not.toHaveBeenCalled();
    expect(existsSync(failPath)).toBe(true);
    expect(JSON.parse(readFileSync(failPath, 'utf-8')).reason).toBe('no-exchanges');
    const r2 = await syncConversations(sourceDir, destDir, { skipIndex: true });
    expect(r2.unexplainedEmptySummaries).toBe(0);
    void r;
  });

  it('FRESH work goes first: a legacy empty never takes the budget from a new conversation', async () => {
    summarizeMock.mockResolvedValue('summary');
    const legacy = uuid(12), fresh = uuid(13);
    writeConversation(sourceDir, 'proj', `${legacy}.jsonl`);
    await syncConversations(sourceDir, destDir, { skipIndex: true });
    writeFileSync(join(destDir, 'proj', `${legacy}-summary.txt`), '', 'utf-8');
    writeConversation(sourceDir, 'proj', `${fresh}.jsonl`);
    summarizeMock.mockClear();

    await syncConversations(sourceDir, destDir, { skipIndex: true, summaryLimit: 1 });
    expect(statSync(join(destDir, 'proj', `${fresh}-summary.txt`)).size).toBeGreaterThan(0);
    expect(statSync(join(destDir, 'proj', `${legacy}-summary.txt`)).size).toBe(0);
  });

  it('a legacy empty that FAILS once keeps being retried up to the attempt cap, then is explained', async () => {
    process.env.EPISODIC_MEMORY_MAX_SUMMARY_ATTEMPTS = '3';
    summarizeMock.mockResolvedValue('first real summary');
    const id = uuid(15);
    writeConversation(sourceDir, 'proj', `${id}.jsonl`);
    await syncConversations(sourceDir, destDir, { skipIndex: true });
    const summaryPath = join(destDir, 'proj', `${id}-summary.txt`);
    writeFileSync(summaryPath, '', 'utf-8');                  // legacy shape
    summarizeMock.mockReset();
    summarizeMock.mockRejectedValueOnce(new Error('transient'));
    summarizeMock.mockResolvedValue('recovered on the second try');

    await syncConversations(sourceDir, destDir, { skipIndex: true });   // attempt 1 fails
    expect(summarizeMock).toHaveBeenCalledTimes(1);
    await syncConversations(sourceDir, destDir, { skipIndex: true });   // must be retried
    expect(summarizeMock).toHaveBeenCalledTimes(2);
    expect(statSync(summaryPath).size).toBeGreaterThan(0);
  });

  it('CONTROL: an empty summary that CARRIES a give-up marker is NOT retried', async () => {
    process.env.EPISODIC_MEMORY_MAX_SUMMARY_ATTEMPTS = '1';
    summarizeMock.mockRejectedValue(new Error('deterministic failure'));
    writeConversation(sourceDir, 'proj', `${uuid(14)}.jsonl`);
    await syncConversations(sourceDir, destDir, { skipIndex: true });   // gives up on attempt 1
    expect(summarizeMock).toHaveBeenCalledTimes(1);
    await syncConversations(sourceDir, destDir, { skipIndex: true });
    expect(summarizeMock).toHaveBeenCalledTimes(1);                     // explained -> left alone
  });
});
