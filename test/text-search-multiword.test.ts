import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import type Database from 'better-sqlite3';
import { initDatabase, insertExchange } from '../src/db.js';
import { buildFtsMatchQuery, searchConversations } from '../src/search.js';
import type { ConversationExchange } from '../src/types.js';
import { safeRmSync } from './test-utils.js';

// A multi-word text search used to match the whole query as one phrase. "database refactor"
// then missed "refactor the database layer". Each word must now match in any order.
// Both paths have tests: the FTS5 query and the LIKE search.
// The LIKE search runs when the FTS5 table is missing.

describe('buildFtsMatchQuery', () => {
  it('quotes each word, so that each word must match', () => {
    expect(buildFtsMatchQuery('hello world')).toBe('"hello" "world"');
  });

  it('drops quotes and operators from the words', () => {
    expect(buildFtsMatchQuery('say "hi" OR NEAR(x)')).toBe('"say" "hi" "OR" "NEAR" "x"');
  });

  it('keeps one quoted phrase when the text holds no word', () => {
    expect(buildFtsMatchQuery('!! "')).toBe('"!! """');
  });
});

describe('text search with several words', () => {
  let testDir: string;
  const originalDbPath = process.env.TEST_DB_PATH;

  const TEXTS: Array<[string, string]> = [
    ['refactor', 'We should refactor the database layer before the release.'],
    ['other', 'The release notes mention the layer of paint on the wall.'],
    ['wildcard', 'The ratio was aXb in the second run.'],
    ['literal', 'The ratio was a%b in the third run.'],
  ];

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'em-multiword-'));
    process.env.TEST_DB_PATH = join(testDir, 'index.sqlite');
    const archiveDir = join(testDir, 'archive');
    mkdirSync(archiveDir, { recursive: true });
    const db = initDatabase();
    for (const [id, text] of TEXTS) {
      const archivePath = join(archiveDir, `${id}.jsonl`);
      writeFileSync(archivePath, '{}\n', 'utf-8');
      const exchange: ConversationExchange = {
        id,
        project: 'proj',
        timestamp: '2026-11-13T09:00:00.000Z',
        userMessage: text,
        assistantMessage: 'Noted.',
        archivePath,
        lineStart: 1,
        lineEnd: 2,
      };
      insertExchange(db, exchange, new Array(384).fill(0.1));
    }
    db.close();
  });

  afterEach(() => {
    if (originalDbPath === undefined) delete process.env.TEST_DB_PATH;
    else process.env.TEST_DB_PATH = originalDbPath;
    safeRmSync(testDir);
  });

  async function ids(query: string, db?: Database.Database): Promise<string[]> {
    const results = await searchConversations(query, { mode: 'text', limit: 10, db });
    return results.map(r => r.exchange.id).sort();
  }

  // initDatabase() creates and refills exchanges_fts. As a result, the LIKE tests keep one connection
  // without the table and pass it to the search, so the FTS5 query fails and the LIKE search runs.
  async function likeIds(query: string): Promise<string[]> {
    const db = initDatabase();
    try {
      db.exec('DROP TABLE exchanges_fts');
      expect(() => db.prepare('SELECT 1 FROM exchanges_fts')).toThrow(/no such table/);
      return await ids(query, db);
    } finally {
      db.close();
    }
  }

  it('FTS5: finds an exchange that holds each word in another order', async () => {
    expect(await ids('database refactor')).toEqual(['refactor']);
  });

  it('FTS5: finds no exchange when one word is missing', async () => {
    expect(await ids('database paint')).toEqual([]);
  });

  it('LIKE fallback: finds an exchange that holds each word in another order', async () => {
    expect(await likeIds('database refactor')).toEqual(['refactor']);
  });

  it('LIKE fallback: finds no exchange when one word is missing', async () => {
    expect(await likeIds('database paint')).toEqual([]);
  });

  it('LIKE fallback: reads % and _ in a word as text, not as a wildcard', async () => {
    expect(await likeIds('a%b')).toEqual(['literal']);
    expect(await likeIds('a_b')).toEqual([]);
  });
});
