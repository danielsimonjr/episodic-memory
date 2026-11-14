import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import type { ConversationExchange } from '../src/types.js';
import { safeRmSync } from './test-utils.js';

// The text step selected `0 as distance`. A distance of 0 converts to a similarity of 1.0.
// A row that only the text step of a `both` search found therefore showed as a 100% match.
// A text row has no similarity. A row that the vector step found keeps the similarity of its distance.
const DIM = 384;
const QUERY = Array.from({ length: DIM }, (_, i) => (i === 0 ? 1 : 0));

vi.mock('../src/embeddings.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/embeddings.js')>();
  return { ...actual, initEmbeddings: async () => {}, generateQueryEmbedding: async () => QUERY };
});

const { initDatabase, insertExchange } = await import('../src/db.js');
const { searchConversations, formatResults } = await import('../src/search.js');

/** A row vector at L2 distance `d` from the query vector. */
function at(d: number): number[] {
  return QUERY.map((v, i) => (i === 1 ? d : v));
}

describe('the similarity of a text row', () => {
  let testDir: string;
  const originalDbPath = process.env.TEST_DB_PATH;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'em-text-similarity-'));
    process.env.TEST_DB_PATH = join(testDir, 'index.sqlite');
    mkdirSync(join(testDir, 'archive'), { recursive: true });
    const rows: Array<{ id: string; distance: number; user: string }> = [
      { id: 'near', distance: 0.1, user: 'How do I tune the cache size?' },
      { id: 'mid', distance: 0.5, user: 'Which port does the server listen on?' },
      { id: 'far', distance: 1.5, user: 'Where does the deploy script rotate the keys?' },
    ];
    const db = initDatabase();
    try {
      for (const row of rows) {
        const archivePath = join(testDir, 'archive', `${row.id}.jsonl`);
        writeFileSync(archivePath, '{}\n', 'utf-8');
        const exchange: ConversationExchange = {
          id: row.id,
          project: 'proj',
          timestamp: '2025-03-01T09:00:00.000Z',
          userMessage: row.user,
          assistantMessage: `answer ${row.id}`,
          archivePath,
          lineStart: 1,
          lineEnd: 2,
        };
        insertExchange(db, exchange, at(row.distance));
      }
    } finally {
      db.close();
    }
  });

  afterEach(() => {
    if (originalDbPath === undefined) delete process.env.TEST_DB_PATH;
    else process.env.TEST_DB_PATH = originalDbPath;
    safeRmSync(testDir);
  });

  it('a both search gives a text-only row no similarity, and a vector row its own', async () => {
    // limit 2: the vector step finds the near and mid rows. The words of the query match only the far row.
    // The merge alternates the two lists, so the text-only far row takes the second place.
    const results = await searchConversations('deploy keys', { mode: 'both', limit: 2 });
    const byId = new Map(results.map(r => [r.exchange.id, r]));

    expect(results.map(r => r.exchange.id)).toEqual(['near', 'far']);
    expect(byId.get('near')!.similarity).toBeCloseTo(1 - (0.1 * 0.1) / 2, 6);
    expect(byId.get('far')!.similarity).toBeUndefined();

    const text = await formatResults(results);
    // The stored vectors are float32. The distance is therefore a little more than 0.1, and the near row shows 99%.
    expect(text).toMatch(/1\. \[proj, 2025-03-01\] - 99% match/);
    expect(text).toMatch(/2\. \[proj, 2025-03-01\]\n/);
  });

  it('a both search keeps the vector similarity of a row that both steps find', async () => {
    // limit 3: the vector step finds all three rows, and the text step finds the far row too.
    const results = await searchConversations('deploy keys', { mode: 'both', limit: 3 });
    const far = results.find(r => r.exchange.id === 'far')!;
    expect(results.filter(r => r.exchange.id === 'far')).toHaveLength(1);
    expect(far.similarity).toBeCloseTo(1 - (1.5 * 1.5) / 2, 6);
  });

  it('a text row of the LIKE fallback has no similarity either', async () => {
    // Without the full-text table, the text step uses the LIKE search. initDatabase creates the table again,
    // so the search gets an open connection through the `db` option.
    const db = initDatabase();
    try {
      db.exec('DROP TABLE exchanges_fts');
      const both = await searchConversations('deploy keys', { mode: 'both', limit: 2, db });
      expect(both.map(r => r.exchange.id)).toEqual(['near', 'far']);
      expect(both.find(r => r.exchange.id === 'far')!.similarity).toBeUndefined();
      const text = await searchConversations('deploy keys', { mode: 'text', db });
      expect(text.map(r => r.exchange.id)).toEqual(['far']);
      expect(text[0].similarity).toBeUndefined();
    } finally {
      db.close();
    }
  });

  it('a text search gives no similarity', async () => {
    const results = await searchConversations('deploy keys', { mode: 'text' });
    expect(results.map(r => r.exchange.id)).toEqual(['far']);
    expect(results[0].similarity).toBeUndefined();
  });
});
