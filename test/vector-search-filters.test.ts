import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import type { ConversationExchange } from '../src/types.js';
import { safeRmSync } from './test-utils.js';

// A search that takes the nearest rows before it applies the WHERE clause can return no row: the filter can
// drop every near row. The search must apply the filter first. The fixed query vector and the fixed row vectors put each row at a known distance.
const DIM = 384;
const QUERY = Array.from({ length: DIM }, (_, i) => (i === 0 ? 1 : 0));

vi.mock('../src/embeddings.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/embeddings.js')>();
  return {
    ...actual,
    initEmbeddings: async () => {},
    generateQueryEmbedding: async () => QUERY,
  };
});

const { initDatabase, insertExchange, openDatabaseReadonly } = await import('../src/db.js');
const { searchConversations } = await import('../src/search.js');

/** A row vector at L2 distance `d` from the query vector. */
function at(d: number): number[] {
  return QUERY.map((v, i) => (i === 1 ? d : v));
}

interface Row {
  id: string;
  distance: number;
  timestamp?: string;
  project?: string;
  isSidechain?: boolean;
}

describe('vector search applies the filters before the nearest rows are taken', () => {
  let testDir: string;
  const originalDbPath = process.env.TEST_DB_PATH;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'em-vector-filters-'));
    process.env.TEST_DB_PATH = join(testDir, 'index.sqlite');
    mkdirSync(join(testDir, 'archive'), { recursive: true });
  });

  afterEach(() => {
    if (originalDbPath === undefined) delete process.env.TEST_DB_PATH;
    else process.env.TEST_DB_PATH = originalDbPath;
    safeRmSync(testDir);
  });

  function seed(rows: Row[]): void {
    const db = initDatabase();
    try {
      for (const row of rows) {
        const archivePath = join(testDir, 'archive', `${row.id}.jsonl`);
        writeFileSync(archivePath, '{}\n', 'utf-8');
        const exchange: ConversationExchange = {
          id: row.id,
          project: row.project ?? 'proj',
          timestamp: row.timestamp ?? '2025-03-01T09:00:00.000Z',
          userMessage: `question ${row.id}`,
          assistantMessage: `answer ${row.id}`,
          archivePath,
          lineStart: 1,
          lineEnd: 2,
          isSidechain: row.isSidechain ?? false,
        };
        insertExchange(db, exchange, at(row.distance));
      }
    } finally {
      db.close();
    }
  }

  async function ids(options: Parameters<typeof searchConversations>[1]): Promise<string[]> {
    const results = await searchConversations('any query', { mode: 'vector', ...options });
    return results.map(r => r.exchange.id);
  }

  // Ten rows. The two rows in the date range are the two farthest from the query.
  const dated: Row[] = Array.from({ length: 10 }, (_, i) => ({
    id: `r${i}`,
    distance: i + 1,
    timestamp: i >= 8 ? '2026-06-01T09:00:00.000Z' : '2025-03-01T09:00:00.000Z',
  }));

  it('returns both rows of a date range when they are the farthest rows', async () => {
    seed(dated);
    expect(await ids({ limit: 2, after: '2026-01-01' })).toEqual(['r8', 'r9']);
  });

  it('returns both rows before a date when they are the farthest rows', async () => {
    seed(dated.map(r => ({ ...r, timestamp: r.id === 'r8' || r.id === 'r9' ? '2024-06-01T09:00:00.000Z' : r.timestamp })));
    expect(await ids({ limit: 2, before: '2025-01-01' })).toEqual(['r8', 'r9']);
  });

  it('returns the rows of a project when they are the farthest rows', async () => {
    seed(dated.map(r => ({ ...r, project: r.id === 'r8' || r.id === 'r9' ? 'other' : 'proj' })));
    expect(await ids({ limit: 2, project: 'other' })).toEqual(['r8', 'r9']);
  });

  it('keeps the nearest-first order inside the filter', async () => {
    seed(dated);
    expect(await ids({ limit: 5, after: '2026-01-01' })).toEqual(['r8', 'r9']);
    expect(await ids({ limit: 1, after: '2026-01-01' })).toEqual(['r8']);
  });

  // No filter, but the seven nearest rows are sidechain rows, which a search never returns.
  it('fills the limit with main-thread rows when the nearest rows are sidechain rows', async () => {
    seed(Array.from({ length: 10 }, (_, i) => ({ id: `r${i}`, distance: i + 1, isSidechain: i < 7 })));
    expect(await ids({ limit: 3 })).toEqual(['r7', 'r8', 'r9']);
  });

  it('falls back to the text search on a read-only file that has no vector table yet', async () => {
    seed(dated);
    const raw = initDatabase();
    raw.exec('DROP TABLE exchange_vectors');
    raw.close();
    const db = openDatabaseReadonly();
    const notices: string[] = [];
    try {
      const results = await searchConversations('question', { mode: 'both', db, limit: 3, onNotice: m => notices.push(m) });
      expect(results.length).toBeGreaterThan(0);
      expect(notices.join(' ')).toMatch(/Vector search is unavailable/);
      await expect(searchConversations('question', { mode: 'vector', db })).rejects.toThrow(/exchange_vectors/);
    } finally {
      db.close();
    }
  });

  it('accepts a limit of 2000', async () => {
    seed(dated);
    expect(await ids({ limit: 2000 })).toHaveLength(10);
  });
});
