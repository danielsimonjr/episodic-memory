import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { safeRmSync } from './test-utils.js';

// The summarizer is mocked so no model is called. The tests show WHEN the sync asks for a summary.
const { summarizeMock } = vi.hoisted(() => ({ summarizeMock: vi.fn() }));
vi.mock('../src/summarizer.js', () => ({ summarizeConversation: summarizeMock }));

const { syncConversations } = await import('../src/sync.js');
const { GpuReservedError } = await import('../src/ollama-backend.js');

const KEYS = ['FLEET_GPU_RESERVATION', 'EPISODIC_MEMORY_SUMMARIZER_BACKEND', 'EPISODIC_MEMORY_MAX_SUMMARY_ATTEMPTS'];
const saved: Record<string, string | undefined> = {};
for (const k of KEYS) saved[k] = process.env[k];

const ID = '5555eeee-5555-5555-5555-555555555555';
const ID2 = '6666ffff-6666-6666-6666-666666666666';

function writeConversation(dir: string, project: string, name: string): void {
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
  writeFileSync(join(dir, project, name), content, 'utf-8');
}

let testDir: string;
let sourceDir: string;
let destDir: string;
let reservation: string;
let summaryPath: string;
let failPath: string;

beforeEach(() => {
  summarizeMock.mockReset();
  testDir = mkdtempSync(join(tmpdir(), 'em-gpu-sync-'));
  sourceDir = join(testDir, 'source');
  destDir = join(testDir, 'dest');
  mkdirSync(sourceDir, { recursive: true });
  reservation = join(testDir, 'gpu-reserved.json');
  process.env.FLEET_GPU_RESERVATION = reservation;
  writeConversation(sourceDir, 'proj', `${ID}.jsonl`);
  summaryPath = join(destDir, 'proj', `${ID}-summary.txt`);
  failPath = join(destDir, 'proj', `${ID}-summary.failed`);
});

afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  safeRmSync(testDir);
});

describe('sync with the ollama backend under a GPU reservation', () => {
  beforeEach(() => {
    process.env.EPISODIC_MEMORY_SUMMARIZER_BACKEND = 'ollama';
  });

  it('asks for no summary while the GPU is reserved, and asks again once it is free', async () => {
    writeFileSync(reservation, JSON.stringify({ holder: 'Starship' }));

    const held = await syncConversations(sourceDir, destDir, { skipIndex: true });
    expect(summarizeMock).not.toHaveBeenCalled();
    expect(held.summaryAttempts).toBe(0);
    expect(held.errors).toEqual([]);
    expect(held.summariesDeferred).toBe('fleet GPU reserved by Starship');
    expect(held.pendingSummaries).toBe(1);
    expect(existsSync(summaryPath)).toBe(false);
    expect(existsSync(failPath)).toBe(false);

    safeRmSync(reservation);
    summarizeMock.mockResolvedValue('<summary>Deferred, then written.</summary>');
    const free = await syncConversations(sourceDir, destDir, { skipIndex: true });
    expect(summarizeMock).toHaveBeenCalledTimes(1);
    expect(readFileSync(summaryPath, 'utf-8')).toContain('Deferred, then written');
    expect(free.summariesDeferred).toBeUndefined();
  });
});

describe('sync with the claude backend', () => {
  it('ignores the reservation, because the Claude backend does not use the GPU', async () => {
    delete process.env.EPISODIC_MEMORY_SUMMARIZER_BACKEND;
    writeFileSync(reservation, JSON.stringify({ holder: 'Starship' }));
    summarizeMock.mockResolvedValue('<summary>Claude summary.</summary>');

    await syncConversations(sourceDir, destDir, { skipIndex: true });

    expect(summarizeMock).toHaveBeenCalledTimes(1);
    expect(existsSync(summaryPath)).toBe(true);
  });

  it('reports no deferral', async () => {
    delete process.env.EPISODIC_MEMORY_SUMMARIZER_BACKEND;
    writeFileSync(reservation, JSON.stringify({ holder: 'Starship' }));
    summarizeMock.mockResolvedValue('<summary>Claude summary.</summary>');

    const result = await syncConversations(sourceDir, destDir, { skipIndex: true });

    expect(result.summariesDeferred).toBeUndefined();
  });
});

describe('a reservation that appears during a summary', () => {
  it('is not counted as a failed attempt, so the attempt cap is never spent on it', async () => {
    delete process.env.EPISODIC_MEMORY_SUMMARIZER_BACKEND;
    process.env.EPISODIC_MEMORY_MAX_SUMMARY_ATTEMPTS = '1'; // one real failure would give up for good
    summarizeMock.mockRejectedValueOnce(new GpuReservedError('Starship'));

    const first = await syncConversations(sourceDir, destDir, { skipIndex: true });
    expect(first.errors).toEqual([]);
    expect(existsSync(summaryPath)).toBe(false);
    expect(existsSync(failPath)).toBe(false);

    summarizeMock.mockResolvedValueOnce('<summary>Written on the second sync.</summary>');
    await syncConversations(sourceDir, destDir, { skipIndex: true });
    expect(readFileSync(summaryPath, 'utf-8')).toContain('Written on the second sync');
  });

  it('counts no attempt, reports the wait, and asks for no further summary in the same run', async () => {
    delete process.env.EPISODIC_MEMORY_SUMMARIZER_BACKEND;
    writeConversation(sourceDir, 'proj', `${ID2}.jsonl`);
    summarizeMock.mockRejectedValue(new GpuReservedError('fleet GPU reserved by Starship'));

    const result = await syncConversations(sourceDir, destDir, { skipIndex: true });

    expect(summarizeMock).toHaveBeenCalledTimes(1);
    expect(result.summaryAttempts).toBe(0);
    expect(result.summarized).toBe(0);
    expect(result.errors).toEqual([]);
    expect(result.summariesDeferred).toBe('fleet GPU reserved by Starship');
    expect(result.pendingSummaries).toBe(2);
  });
});
