import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { summarizeConversation } from '../src/summarizer.js';
import { GpuReservedError } from '../src/ollama-backend.js';
import type { ConversationExchange } from '../src/types.js';
import { safeRmSync } from './test-utils.js';

const KEYS = [
  'FLEET_GPU_RESERVATION',
  'EPISODIC_MEMORY_SUMMARIZER_BACKEND',
  'EPISODIC_MEMORY_OLLAMA_URL',
  'EPISODIC_MEMORY_OLLAMA_MODEL',
];
const saved: Record<string, string | undefined> = {};
for (const k of KEYS) saved[k] = process.env[k];

function exchanges(count: number): ConversationExchange[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `x${i}`,
    project: 'proj',
    timestamp: '2026-10-08T09:00:00.000Z',
    userMessage: `Question ${i} with enough text to count as a real exchange in the transcript`,
    assistantMessage: `Answer ${i} with enough text to count as a real exchange in the transcript`,
    archivePath: '/a.jsonl',
    lineStart: i * 2 + 1,
    lineEnd: i * 2 + 2,
  })) as ConversationExchange[];
}

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'em-sum-gpu-'));
  process.env.FLEET_GPU_RESERVATION = join(dir, 'gpu-reserved.json');
  process.env.EPISODIC_MEMORY_SUMMARIZER_BACKEND = 'ollama';
  process.env.EPISODIC_MEMORY_OLLAMA_URL = 'http://127.0.0.1:9';
  process.env.EPISODIC_MEMORY_OLLAMA_MODEL = 'qwen3.8:27b';
  writeFileSync(process.env.FLEET_GPU_RESERVATION, JSON.stringify({ holder: 'Starship' }));
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

describe('summarizeConversation under a GPU reservation', () => {
  it('rejects a short conversation with GpuReservedError', async () => {
    await expect(summarizeConversation(exchanges(3))).rejects.toBeInstanceOf(GpuReservedError);
  });

  it('rejects a long conversation instead of storing a partial summary from skipped chunks', async () => {
    // Without the rethrow, every chunk "fails, skipping" and the function returns
    // 'Error: Unable to summarize conversation.', which the sync would store as the summary.
    await expect(summarizeConversation(exchanges(20))).rejects.toBeInstanceOf(GpuReservedError);
  });
});

describe('summarizeConversation when the reservation appears during the run', () => {
  const okResponse = { ok: true, status: 200, json: async () => ({ response: '<summary>One chunk summary.</summary>' }) } as any;

  // Count the model calls of a long conversation while the GPU is free: chunks, then one synthesis.
  async function callsWhileFree(): Promise<number> {
    rmReservation();
    const stub = vi.fn(async () => okResponse);
    vi.stubGlobal('fetch', stub);
    await summarizeConversation(exchanges(20));
    vi.unstubAllGlobals();
    return stub.mock.calls.length;
  }

  function rmReservation() {
    safeRmSync(process.env.FLEET_GPU_RESERVATION!);
  }
  function reserve() {
    writeFileSync(process.env.FLEET_GPU_RESERVATION!, JSON.stringify({ holder: 'Starship' }));
  }

  afterEach(() => vi.unstubAllGlobals());

  it('rejects when only the synthesis call is blocked, instead of storing the chunk summaries joined', async () => {
    const total = await callsWhileFree();
    expect(total).toBeGreaterThan(2); // at least two chunks and the synthesis

    // The reservation appears after the last chunk, so the next call is the synthesis.
    let calls = 0;
    vi.stubGlobal('fetch', vi.fn(async () => {
      calls++;
      if (calls === total - 1) reserve();
      return okResponse;
    }));

    await expect(summarizeConversation(exchanges(20))).rejects.toBeInstanceOf(GpuReservedError);
    expect(calls).toBe(total - 1);
  });

  it('rejects when one chunk is blocked, even if the GPU is free again for the later calls', async () => {
    // The reservation appears after the first chunk. The failed chunk is logged; at that moment the
    // reservation ends. Without the rethrow, the later chunks and the synthesis succeed and the
    // function returns a summary that lacks the blocked chunk.
    rmReservation();
    let calls = 0;
    vi.stubGlobal('fetch', vi.fn(async () => {
      calls++;
      if (calls === 1) reserve();
      return okResponse;
    }));
    vi.mocked(console.log).mockImplementation((message?: unknown) => {
      if (String(message).includes('failed, skipping')) rmReservation();
    });

    await expect(summarizeConversation(exchanges(20))).rejects.toBeInstanceOf(GpuReservedError);
  });
});
