import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import type { ConversationExchange } from '../src/types.js';
import { safeRmSync } from './test-utils.js';

// On some hosts the embedding backend cannot load. initEmbeddings then rejects with EmbeddingsUnavailableError.
// The default `both` search failed with that error, although its text step needs no embedder.
// A `both` search must return the text hits. A `both` search must report the missing vector step.
// A `vector` search must still fail.
const { initMock, queryMock } = vi.hoisted(() => ({ initMock: vi.fn(), queryMock: vi.fn() }));

vi.mock('../src/embeddings.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/embeddings.js')>();
  return { ...actual, initEmbeddings: initMock, generateQueryEmbedding: queryMock };
});

const { EmbeddingsUnavailableError } = await import('../src/embeddings.js');
const { initDatabase, insertExchange, closeSharedReaderDatabase } = await import('../src/db.js');
const { searchConversations } = await import('../src/search.js');
const { handleToolCall } = await import('../src/mcp-tools.js');

const BACKEND_ERROR = 'Failed to load the embedding backend (onnxruntime-node). ERR_DLOPEN_FAILED: onnxruntime_binding.node';
const DIM = 384;

describe('a search when the embedding backend cannot load', () => {
  let testDir: string;
  const saved = { db: process.env.TEST_DB_PATH, archive: process.env.TEST_ARCHIVE_DIR };

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'em-search-no-embed-'));
    process.env.TEST_DB_PATH = join(testDir, 'index.sqlite');
    process.env.TEST_ARCHIVE_DIR = join(testDir, 'archive');
    mkdirSync(join(testDir, 'archive'), { recursive: true });
    initMock.mockReset();
    queryMock.mockReset();
    initMock.mockRejectedValue(new EmbeddingsUnavailableError(BACKEND_ERROR));
    queryMock.mockRejectedValue(new Error('the test must not embed a query'));

    const archivePath = join(testDir, 'archive', 'sess.jsonl');
    writeFileSync(archivePath, '{}\n', 'utf-8');
    const exchange: ConversationExchange = {
      id: 'e1',
      project: 'proj',
      timestamp: '2025-03-01T09:00:00.000Z',
      userMessage: 'How does the deploy script rotate the keys?',
      assistantMessage: 'The deploy script rotates the keys before the upload.',
      archivePath,
      lineStart: 1,
      lineEnd: 2,
    };
    const db = initDatabase();
    try {
      insertExchange(db, exchange, Array.from({ length: DIM }, () => 0));
      // insertExchange also writes the full-text row, so the text step uses FTS5 and not the LIKE fallback.
      expect((db.prepare('SELECT COUNT(*) AS n FROM exchanges_fts').get() as { n: number }).n).toBe(1);
    } finally {
      db.close();
    }
  });

  afterEach(() => {
    closeSharedReaderDatabase();
    if (saved.db === undefined) delete process.env.TEST_DB_PATH;
    else process.env.TEST_DB_PATH = saved.db;
    if (saved.archive === undefined) delete process.env.TEST_ARCHIVE_DIR;
    else process.env.TEST_ARCHIVE_DIR = saved.archive;
    safeRmSync(testDir);
  });

  it('a both search returns the text hits and reports the missing vector step', async () => {
    const notices: string[] = [];
    const results = await searchConversations('deploy keys', { mode: 'both', onNotice: m => notices.push(m) });

    expect(results.map(r => r.exchange.id)).toEqual(['e1']);
    // The vector step did not run, so a text row has no similarity (not the 1.0 of a distance of 0).
    expect(results[0].similarity).toBeUndefined();
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatch(/vector search is unavailable/i);
    expect(notices[0]).toContain(BACKEND_ERROR);
  });

  it('a both search without onNotice writes the notice to stderr', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const results = await searchConversations('deploy keys', { mode: 'both' });
      expect(results.map(r => r.exchange.id)).toEqual(['e1']);
      expect(errorSpy.mock.calls.some(call => /vector search is unavailable/i.test(String(call[0])))).toBe(true);
    } finally {
      errorSpy.mockRestore();
    }
  });

  it('a vector search still fails with EmbeddingsUnavailableError', async () => {
    await expect(searchConversations('deploy keys', { mode: 'vector', onNotice: () => {} }))
      .rejects.toBeInstanceOf(EmbeddingsUnavailableError);
  });

  it('a both search still fails for any other embedding error (the control)', async () => {
    initMock.mockRejectedValue(new Error('a model file is corrupt'));
    await expect(searchConversations('deploy keys', { mode: 'both', onNotice: () => {} }))
      .rejects.toThrow('a model file is corrupt');
  });

  it('the search tool puts the notice in the markdown and the JSON result', async () => {
    const md = await handleToolCall('search', { query: 'deploy keys' });
    expect(md.isError).toBeUndefined();
    expect(md.content[0].text).toMatch(/vector search is unavailable/i);
    expect(md.content[0].text).toContain('deploy script');

    const json = await handleToolCall('search', { query: 'deploy keys', response_format: 'json' });
    expect(json.isError).toBeUndefined();
    const body = JSON.parse(json.content[0].text);
    expect(body.count).toBe(1);
    expect(body.notices).toHaveLength(1);
    expect(body.notices[0]).toMatch(/vector search is unavailable/i);
  });

  it('the JSON result of the search tool has no notices field when every step ran', async () => {
    const json = await handleToolCall('search', { query: 'deploy keys', mode: 'text', response_format: 'json' });
    expect(JSON.parse(json.content[0].text)).not.toHaveProperty('notices');
  });
});
