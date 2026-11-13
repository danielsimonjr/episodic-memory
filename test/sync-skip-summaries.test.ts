import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { safeRmSync } from './test-utils.js';

// EPISODIC_MEMORY_SKIP_SUMMARIES=1 turns off the summary step of a sync. Ported from upstream c8d0e3f.
// A mock replaces the summarizer, so no test reaches a model.
const { summarizeMock } = vi.hoisted(() => ({ summarizeMock: vi.fn() }));
vi.mock('../src/summarizer.js', () => ({ summarizeConversation: summarizeMock }));

const { buildSyncOptionsFromEnv, syncConversations } = await import('../src/sync.js');

const ID = '3333cccc-3333-4333-8333-333333333333';

function writeConversation(dir: string): void {
  mkdirSync(join(dir, 'proj'), { recursive: true });
  const content =
    JSON.stringify({
      type: 'user', uuid: 'u1', parentUuid: null, timestamp: '2025-10-01T13:00:00Z',
      isSidechain: false, message: { role: 'user', content: 'A real question with enough substance to summarize.' },
    }) + '\n' +
    JSON.stringify({
      type: 'assistant', uuid: 'a1', parentUuid: 'u1', timestamp: '2025-10-01T13:00:01Z',
      isSidechain: false, message: { role: 'assistant', content: 'A real, substantive answer to the question.' },
    });
  writeFileSync(join(dir, 'proj', `${ID}.jsonl`), content, 'utf-8');
}

describe('buildSyncOptionsFromEnv', () => {
  it('sets skipSummaries when EPISODIC_MEMORY_SKIP_SUMMARIES is exactly 1', () => {
    expect(buildSyncOptionsFromEnv({ EPISODIC_MEMORY_SKIP_SUMMARIES: '1' }).skipSummaries).toBe(true);
  });

  it('leaves the summaries on when the variable is unset', () => {
    expect(buildSyncOptionsFromEnv({}).skipSummaries).toBe(false);
  });

  it('leaves the summaries on for every other value', () => {
    for (const value of ['0', 'true', 'yes', '', ' 1', '1 ']) {
      expect(buildSyncOptionsFromEnv({ EPISODIC_MEMORY_SKIP_SUMMARIES: value }).skipSummaries, JSON.stringify(value)).toBe(false);
    }
  });
});

describe('sync with EPISODIC_MEMORY_SKIP_SUMMARIES', () => {
  let testDir: string;
  let sourceDir: string;
  let destDir: string;

  beforeEach(() => {
    summarizeMock.mockReset();
    summarizeMock.mockResolvedValue('A real summary.');
    testDir = mkdtempSync(join(tmpdir(), 'em-skip-summaries-'));
    sourceDir = join(testDir, 'source');
    destDir = join(testDir, 'dest');
    writeConversation(sourceDir);
  });

  afterEach(() => {
    safeRmSync(testDir);
  });

  it('copies the file, calls no summarizer and writes no summary file', async () => {
    const options = buildSyncOptionsFromEnv({ EPISODIC_MEMORY_SKIP_SUMMARIES: '1' });
    const result = await syncConversations(sourceDir, destDir, { ...options, skipIndex: true });

    expect(result.copied).toBe(1);
    expect(result.summarized).toBe(0);
    expect(result.errors).toEqual([]);
    expect(summarizeMock).not.toHaveBeenCalled();
    expect(readdirSync(join(destDir, 'proj')).filter(f => f.endsWith('-summary.txt'))).toEqual([]);
  });

  it('summarizes the file when the variable is unset (the control)', async () => {
    const options = buildSyncOptionsFromEnv({});
    const result = await syncConversations(sourceDir, destDir, { ...options, skipIndex: true });

    expect(result.summarized).toBe(1);
    expect(summarizeMock).toHaveBeenCalledTimes(1);
    expect(readFileSync(join(destDir, 'proj', `${ID}-summary.txt`), 'utf-8')).toBe('A real summary.');
  });

  it('the sync command reads the variable and reports the skipped step', () => {
    // A wiring guard. A sync command in a test would load the embedding model, so the test reads the call site.
    const source = readFileSync(join(__dirname, '..', 'src', 'sync-cli.ts'), 'utf-8');
    expect(source).toMatch(/const syncOptions = buildSyncOptionsFromEnv\(process\.env\);/);
    expect(source).toMatch(/syncConversations\(sourceDir, destDir, \{ \.\.\.syncOptions, summaryLimit:/);
    expect(source).toMatch(/Summaries: skipped \(EPISODIC_MEMORY_SKIP_SUMMARIES=1\)/);
  });
});
