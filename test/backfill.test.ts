import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync, statSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const { summarizeMock } = vi.hoisted(() => ({ summarizeMock: vi.fn() }));
vi.mock('../src/summarizer.js', () => ({ summarizeConversation: summarizeMock }));
const { selectBackfillCandidates, backfillArchive } = await import('../src/backfill.js');

const uuid = (n: number) => `${String(n).padStart(8, '0')}-bbbb-4bbb-8bbb-bbbbbbbbbbbb`;
function conv(dir: string, project: string, n: number, withExchanges = true): string {
  mkdirSync(join(dir, project), { recursive: true });
  const f = join(dir, project, `${uuid(n)}.jsonl`);
  const body = withExchanges
    ? JSON.stringify({ type: 'user', uuid: 'u', parentUuid: null, timestamp: '2025-10-01T13:00:00Z', isSidechain: false, message: { role: 'user', content: 'A real question with enough substance to summarize here.' } }) + '\n' +
      JSON.stringify({ type: 'assistant', uuid: 'a', parentUuid: 'u', timestamp: '2025-10-01T13:00:01Z', isSidechain: false, message: { role: 'assistant', content: 'A real substantive answer to that question.' } })
    : JSON.stringify({ type: 'summary', summary: 'x', leafUuid: 'l' });
  writeFileSync(f, body, 'utf-8');
  return f;
}
const sum = (f: string) => f.replace('.jsonl', '-summary.txt');
const fail = (f: string) => f.replace('.jsonl', '-summary.failed');

let root: string;
beforeEach(() => { summarizeMock.mockReset(); root = mkdtempSync(join(tmpdir(), 'em-backfill-')); });
afterEach(() => { try { rmSync(root, { recursive: true, force: true }); } catch {} });

describe('selectBackfillCandidates', () => {
  it('selects archive-only conversations with NO summary and legacy/retrying empties, never explained ones', () => {
    const none = conv(root, 'p', 1);                                   // no summary file -> candidate
    const legacy = conv(root, 'p', 2); writeFileSync(sum(legacy), '');  // empty, no marker -> candidate
    const retry = conv(root, 'p', 3); writeFileSync(sum(retry), ''); writeFileSync(fail(retry), JSON.stringify({ attempts: 1, lastError: 'x' }));
    const done = conv(root, 'p', 4); writeFileSync(sum(done), 'a summary');
    const noEx = conv(root, 'p', 5); writeFileSync(sum(noEx), ''); writeFileSync(fail(noEx), JSON.stringify({ reason: 'no-exchanges' }));
    const gaveUp = conv(root, 'p', 6); writeFileSync(sum(gaveUp), ''); writeFileSync(fail(gaveUp), JSON.stringify({ attempts: 3, gaveUp: true }));
    const got = selectBackfillCandidates(root).map((c) => c.path).sort();
    expect(got).toEqual([none, legacy, retry].sort());
  });

  it('skips excluded projects and ignores non-conversation files', () => {
    conv(root, 'keep', 7);
    conv(root, 'skipme', 8);
    writeFileSync(join(root, 'keep', 'notes.txt'), 'x');
    const got = selectBackfillCandidates(root, { excludedProjects: ['skipme'] });
    expect(got.map((c) => c.path)).toEqual([join(root, 'keep', `${uuid(7)}.jsonl`)]);
  });
});

describe('backfillArchive', () => {
  it('dry run counts candidates and writes nothing', async () => {
    const f = conv(root, 'p', 9);
    const r = await backfillArchive(root, { dryRun: true });
    expect(r.candidates).toBe(1);
    expect(summarizeMock).not.toHaveBeenCalled();
    expect(existsSync(sum(f))).toBe(false);
  });

  it('summarizes up to the limit, leaves the rest, and marks no-exchange conversations explained', async () => {
    summarizeMock.mockResolvedValue('backfilled summary');
    const a = conv(root, 'p', 10), b = conv(root, 'p', 11), c = conv(root, 'p', 12, false);
    const r = await backfillArchive(root, { limit: 2 });
    expect(r.candidates).toBe(3);
    expect(r.processed).toBe(2);
    const after = selectBackfillCandidates(root);
    expect(after.length).toBe(1);
    const r2 = await backfillArchive(root, {});
    expect(r2.processed).toBe(1);
    expect(selectBackfillCandidates(root).length).toBe(0);
    for (const f of [a, b]) expect(readFileSync(sum(f), 'utf-8')).toBe('backfilled summary');
    expect(statSync(sum(c)).size).toBe(0);
    expect(JSON.parse(readFileSync(fail(c), 'utf-8')).reason).toBe('no-exchanges');
    void r2;
  });

  it('records a failure instead of throwing, so one bad conversation does not stop the run', async () => {
    summarizeMock.mockRejectedValueOnce(new Error('backend down')).mockResolvedValue('ok');
    conv(root, 'p', 13); conv(root, 'p', 14);
    const r = await backfillArchive(root, {});
    expect(r.processed).toBe(2);
    expect(r.summarized).toBe(1);
    expect(r.errors.length).toBe(1);
  });

  it('an EMPTY summary is a failure, not a success, so the conversation cannot loop forever', async () => {
    process.env.EPISODIC_MEMORY_MAX_SUMMARY_ATTEMPTS = '2';
    try {
      summarizeMock.mockResolvedValue('   ');
      const f = conv(root, 'p', 15);
      const r1 = await backfillArchive(root, {});
      expect(r1.summarized).toBe(0);
      expect(r1.errors.length).toBe(1);
      await backfillArchive(root, {});                       // attempt 2 -> gives up
      expect(JSON.parse(readFileSync(fail(f), 'utf-8')).gaveUp).toBe(true);
      expect(selectBackfillCandidates(root).length).toBe(0); // left the candidate set
    } finally {
      delete process.env.EPISODIC_MEMORY_MAX_SUMMARY_ATTEMPTS;
    }
  });
});
