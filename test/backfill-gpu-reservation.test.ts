import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { safeRmSync } from './test-utils.js';

// The summarizer is mocked so no model is called. The tests show WHEN the backfill asks for a summary.
const { summarizeMock } = vi.hoisted(() => ({ summarizeMock: vi.fn() }));
vi.mock('../src/summarizer.js', () => ({ summarizeConversation: summarizeMock }));

const { backfillArchive, batchVerdict } = await import('../src/backfill.js');
const { GpuReservedError } = await import('../src/ollama-backend.js');

const KEYS = ['FLEET_GPU_RESERVATION', 'EPISODIC_MEMORY_SUMMARIZER_BACKEND'];
const saved: Record<string, string | undefined> = {};
for (const k of KEYS) saved[k] = process.env[k];

const uuid = (n: number) => `${String(n).padStart(8, '0')}-cccc-4ccc-8ccc-cccccccccccc`;
function conv(dir: string, n: number): string {
  mkdirSync(join(dir, 'p'), { recursive: true });
  const f = join(dir, 'p', `${uuid(n)}.jsonl`);
  writeFileSync(
    f,
    JSON.stringify({ type: 'user', uuid: 'u', parentUuid: null, timestamp: '2025-10-01T13:00:00Z', isSidechain: false, message: { role: 'user', content: 'A real question with enough substance to summarize here.' } }) + '\n' +
      JSON.stringify({ type: 'assistant', uuid: 'a', parentUuid: 'u', timestamp: '2025-10-01T13:00:01Z', isSidechain: false, message: { role: 'assistant', content: 'A real substantive answer to that question.' } }),
    'utf-8'
  );
  return f;
}
const sum = (f: string) => f.replace('.jsonl', '-summary.txt');
const fail = (f: string) => f.replace('.jsonl', '-summary.failed');

let root: string;
let reservation: string;

beforeEach(() => {
  summarizeMock.mockReset();
  root = mkdtempSync(join(tmpdir(), 'em-backfill-gpu-'));
  reservation = join(root, 'gpu-reserved.json');
  process.env.FLEET_GPU_RESERVATION = reservation;
  process.env.EPISODIC_MEMORY_SUMMARIZER_BACKEND = 'ollama';
  vi.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  safeRmSync(root);
});

describe('backfillArchive under a GPU reservation', () => {
  const archive = () => join(root, 'archive');

  it('asks for no summary and reports the wait while the GPU is reserved', async () => {
    const files = [conv(archive(), 1), conv(archive(), 2), conv(archive(), 3)];
    writeFileSync(reservation, JSON.stringify({ holder: 'Starship' }));

    const r = await backfillArchive(archive(), {});

    expect(summarizeMock).not.toHaveBeenCalled();
    expect(r.deferred).toContain('Starship');
    expect(r).toMatchObject({ candidates: 3, processed: 0, summarized: 0, summaryAttempts: 0, errors: [] });
    for (const f of files) {
      expect(existsSync(sum(f))).toBe(false);
      expect(existsSync(fail(f))).toBe(false);
    }
    expect(batchVerdict(undefined, r)).toBe('deferred');
  });

  it('stops at the first conversation when the reservation appears during the run, and counts no attempt', async () => {
    const files = [conv(archive(), 4), conv(archive(), 5), conv(archive(), 6)];
    summarizeMock.mockRejectedValue(new GpuReservedError('fleet GPU reserved by Starship'));

    const r = await backfillArchive(archive(), {});

    expect(summarizeMock).toHaveBeenCalledTimes(1);
    expect(r.deferred).toContain('Starship');
    expect(r).toMatchObject({ processed: 0, summarized: 0, summaryAttempts: 0, errors: [] });
    expect(batchVerdict(undefined, r)).toBe('deferred');
    for (const f of files) expect(existsSync(sum(f))).toBe(false);
  });

  it('still counts a real backend failure, so a dead backend is not mistaken for a wait', async () => {
    conv(archive(), 7); conv(archive(), 8); conv(archive(), 9);
    summarizeMock.mockRejectedValue(new Error('connection refused'));

    const r = await backfillArchive(archive(), {});

    expect(r.deferred).toBeUndefined();
    expect(r.summaryAttempts).toBe(3);
    expect(batchVerdict(undefined, r)).toBe('backend-down');
  });

  it('ignores the reservation for the claude backend', async () => {
    delete process.env.EPISODIC_MEMORY_SUMMARIZER_BACKEND;
    const f = conv(archive(), 10);
    writeFileSync(reservation, JSON.stringify({ holder: 'Starship' }));
    summarizeMock.mockResolvedValue('a summary');

    const r = await backfillArchive(archive(), {});

    expect(r.deferred).toBeUndefined();
    expect(r.summarized).toBe(1);
    expect(existsSync(sum(f))).toBe(true);
  });

  it('lets a dry run count candidates while the GPU is reserved', async () => {
    conv(archive(), 11);
    writeFileSync(reservation, JSON.stringify({ holder: 'Starship' }));

    const r = await backfillArchive(archive(), { dryRun: true });

    expect(r.candidates).toBe(1);
    expect(r.deferred).toBeUndefined();
  });
});

describe('batchVerdict', () => {
  it('puts a deferral before every other verdict, even when nothing was processed', () => {
    expect(batchVerdict(undefined, { candidates: 5, processed: 0, summarized: 0, summaryAttempts: 0, deferred: 'x' })).toBe('deferred');
    expect(batchVerdict(10, { candidates: 5, processed: 4, summarized: 0, summaryAttempts: 4, deferred: 'x' })).toBe('deferred');
  });
});
