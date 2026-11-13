import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { Database } from '../src/sqlite.js';
import { safeRmSync, suppressConsole } from './test-utils.js';

// Ported from upstream 7e0a415. On some hosts the embedding backend cannot load, for example when the native
// binding of sharp cannot open libvips. initEmbeddings then threw out of syncConversations. The throw stopped
// the summaries, and the SessionStart hook that runs the sync crashed. The sync must copy the files, record the
// error and run the summaries. The fork also tests the next run: a file that the failed run copied must still get
// its index entry, although the transcript does not change again.
const { initMock, embedMock, summarizeMock } = vi.hoisted(() => ({
  initMock: vi.fn(),
  embedMock: vi.fn(),
  summarizeMock: vi.fn(),
}));

vi.mock('../src/embeddings.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/embeddings.js')>();
  return { ...actual, initEmbeddings: initMock, generateExchangeEmbeddings: embedMock };
});
vi.mock('../src/summarizer.js', () => ({ summarizeConversation: summarizeMock }));

const { syncConversations } = await import('../src/sync.js');

const BACKEND_ERROR =
  'Failed to load the embedding backend (@huggingface/transformers). ' +
  'ERR_DLOPEN_FAILED: libvips-cpp.so.8.17.3: cannot open shared object file';
const SESSION = '019aff97-5651-71e0-80ec-b4f2c51095c3';

function transcript(): string {
  return [
    JSON.stringify({
      type: 'user', uuid: `${SESSION}-user-1`, parentUuid: null, timestamp: '2025-10-01T12:00:00Z',
      isSidechain: false, cwd: '/tmp/test-cwd',
      message: { role: 'user', content: 'What does the deploy script do?' },
    }),
    JSON.stringify({
      type: 'assistant', uuid: `${SESSION}-asst-1`, parentUuid: `${SESSION}-user-1`, timestamp: '2025-10-01T12:00:01Z',
      isSidechain: false,
      message: { role: 'assistant', content: [{ type: 'text', text: 'It deploys to prod via terraform apply.' }] },
    }),
  ].join('\n');
}

describe('sync when the embedding backend cannot load', () => {
  let testDir: string;
  let sourceDir: string;
  let destDir: string;
  let dbPath: string;
  let restoreConsole: () => void;
  const saved = { db: process.env.TEST_DB_PATH, config: process.env.EPISODIC_MEMORY_CONFIG_DIR };

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'em-sync-embeddings-unavailable-'));
    sourceDir = join(testDir, 'source');
    destDir = join(testDir, 'dest');
    dbPath = join(testDir, 'index.sqlite');
    mkdirSync(join(sourceDir, 'project-a'), { recursive: true });
    mkdirSync(join(testDir, 'config'), { recursive: true });
    process.env.TEST_DB_PATH = dbPath;
    process.env.EPISODIC_MEMORY_CONFIG_DIR = join(testDir, 'config');
    writeFileSync(join(sourceDir, 'project-a', `${SESSION}.jsonl`), transcript(), 'utf-8');
    initMock.mockReset();
    embedMock.mockReset();
    summarizeMock.mockReset();
    summarizeMock.mockResolvedValue('<summary>The deploy script runs terraform apply.</summary>');
    embedMock.mockImplementation(async (items: unknown[]) => items.map(() => new Array(384).fill(0.05)));
    restoreConsole = suppressConsole();
  });

  afterEach(() => {
    restoreConsole();
    if (saved.db === undefined) delete process.env.TEST_DB_PATH;
    else process.env.TEST_DB_PATH = saved.db;
    if (saved.config === undefined) delete process.env.EPISODIC_MEMORY_CONFIG_DIR;
    else process.env.EPISODIC_MEMORY_CONFIG_DIR = saved.config;
    safeRmSync(testDir);
  });

  function indexedRows(): number {
    if (!existsSync(dbPath)) return 0;
    const db = new Database(dbPath, { readonly: true });
    try {
      return (db.prepare('SELECT COUNT(*) AS n FROM exchanges').get() as { n: number }).n;
    } finally {
      db.close();
    }
  }

  it('copies the file, records the error and runs the summaries', async () => {
    initMock.mockRejectedValue(new Error(BACKEND_ERROR));

    const result = await syncConversations(sourceDir, destDir);

    expect(result.copied).toBe(1);
    expect(existsSync(join(destDir, 'project-a', `${SESSION}.jsonl`))).toBe(true);
    expect(result.indexed).toBe(0);
    expect(embedMock).not.toHaveBeenCalled();
    const error = result.errors.find(e => e.file === '(embeddings)');
    expect(error?.error).toMatch(/embedding backend unavailable/i);
    expect(error?.error).toMatch(/libvips-cpp\.so/);
    expect(summarizeMock).toHaveBeenCalledTimes(1);
    expect(result.summarized).toBe(1);
  });

  it('indexes the file at the next sync, although the transcript did not change', async () => {
    initMock.mockRejectedValueOnce(new Error(BACKEND_ERROR));
    await syncConversations(sourceDir, destDir, { skipSummaries: true });
    expect(indexedRows()).toBe(0);

    initMock.mockResolvedValue(undefined);
    const result = await syncConversations(sourceDir, destDir, { skipSummaries: true });

    expect(result.errors).toEqual([]);
    expect(result.indexed).toBe(1);
    expect(indexedRows()).toBe(1);

    // The file is current now, so a third sync copies nothing.
    const third = await syncConversations(sourceDir, destDir, { skipSummaries: true });
    expect(third.copied).toBe(0);
  });
});
