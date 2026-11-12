import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { initDatabase } from '../src/db.js';
import {
  ensureDigestSchema,
  insertDigestEntry,
  listActiveEntries,
  supersede,
  searchDigest,
  type DigestEntry,
} from '../src/digest-db.js';
import { safeRmSync, suppressConsole } from './test-utils.js';

suppressConsole();

type NewEntry = Omit<DigestEntry, 'id' | 'createdAt' | 'supersededBy'>;

function entry(over: Partial<NewEntry> = {}): NewEntry {
  return {
    tier: 'session',
    project: 'proj-a',
    periodStart: '2026-10-08T09:00:00.000Z',
    periodEnd: '2026-10-08T09:30:00.000Z',
    text: 'Chose sqlite for the cache [#ex1]',
    sources: ['ex1'],
    model: 'haiku',
    handoff: false,
    ...over,
  };
}

describe('digest-db', () => {
  let db: Database.Database;
  beforeEach(() => {
    db = new Database(':memory:');
    ensureDigestSchema(db);
  });

  it('creates the schema twice without error', () => {
    expect(() => ensureDigestSchema(db)).not.toThrow();
  });

  it('inserts an entry and lists it as active', () => {
    const id = insertDigestEntry(db, entry());
    expect(id).toBeTypeOf('number');
    const rows = listActiveEntries(db, 'proj-a');
    expect(rows).toHaveLength(1);
    expect(rows[0].sources).toEqual(['ex1']);
    expect(rows[0].handoff).toBe(false);
  });

  it('returns null for a duplicate tier/project/period_start key', () => {
    expect(insertDigestEntry(db, entry())).toBeTypeOf('number');
    expect(insertDigestEntry(db, entry({ text: 'other [#ex2]' }))).toBeNull();
    expect(listActiveEntries(db, 'proj-a')).toHaveLength(1);
  });

  it('supersede keeps the rows but hides them from listActiveEntries', () => {
    const a = insertDigestEntry(db, entry())!;
    const b = insertDigestEntry(db, entry({ periodStart: '2026-10-08T10:00:00.000Z' }))!;
    const day = insertDigestEntry(db, entry({ tier: 'day', periodStart: '2026-10-08T00:00:00.000Z' }))!;
    supersede(db, [a, b], day);
    expect(listActiveEntries(db, 'proj-a').map(e => e.id)).toEqual([day]);
    const total = (db.prepare('SELECT COUNT(*) AS c FROM digest_entry').get() as { c: number }).c;
    expect(total).toBe(3);
  });

  it('searchDigest finds a word in the text and honours the project filter', () => {
    insertDigestEntry(db, entry());
    insertDigestEntry(db, entry({ project: 'proj-b', text: 'Chose postgres [#ex9]', sources: ['ex9'] }));
    expect(searchDigest(db, 'sqlite').map(e => e.project)).toEqual(['proj-a']);
    expect(searchDigest(db, 'postgres', 'proj-a')).toEqual([]);
  });

  it('searchDigest does not throw on FTS syntax characters', () => {
    insertDigestEntry(db, entry());
    expect(() => searchDigest(db, 'a "b (c')).not.toThrow();
  });

  it('searchDigest drops a line citing a hidden id and keeps the rest', () => {
    insertDigestEntry(
      db,
      entry({
        text: `Kept line about postgres [#ex1]\nHidden line about the cache [#ex9]\nAnother kept line [#ex1]`,
      })
    );
    // The entry still matches the query, so it comes back — with the hidden
    // line gone and every other line intact.
    const [hit] = searchDigest(db, 'cache', undefined, 10, { hideExchangeIds: ['ex9'] });
    expect(hit).toBeDefined();
    expect(hit.text).not.toContain('Hidden line about the cache');
    expect(hit.text).not.toContain('#ex9');
    expect(hit.text).toContain('Kept line about postgres [#ex1]');
    expect(hit.text).toContain('Another kept line [#ex1]');

    const [other] = searchDigest(db, 'postgres', undefined, 10, { hideExchangeIds: ['ex9'] });
    expect(other.text).not.toContain('Hidden line about the cache');
  });

  it('searchDigest hides a line whose inner mark group cites a hidden id', () => {
    insertDigestEntry(db, entry({ text: 'The cache fact [#ex9] and the postgres fact [#ex1]\nKept cache line [#ex1]' }));
    const [hit] = searchDigest(db, 'cache', undefined, 10, { hideExchangeIds: ['ex9'] });
    expect(hit.text).not.toContain('#ex9');
    expect(hit.text).toBe('Kept cache line [#ex1]');
  });

  it('searchDigest hides a line whose hidden mark sits inside an unclosed bracket', () => {
    insertDigestEntry(db, entry({ text: 'Note [see the cache [#ex9] and more [#ex1]\nKept cache line [#ex1]' }));
    const [hit] = searchDigest(db, 'cache', undefined, 10, { hideExchangeIds: ['ex9'] });
    expect(hit.text).not.toContain('#ex9');
    expect(hit.text).toBe('Kept cache line [#ex1]');
  });

  it('searchDigest reports nothing when every line cites a hidden id', () => {
    insertDigestEntry(db, entry({ text: 'Only the cache [#ex9]' }));
    expect(searchDigest(db, 'cache', undefined, 10, { hideExchangeIds: ['ex9'] })).toEqual([]);
  });

  it('searchDigest with no hideExchangeIds returns the whole text', () => {
    insertDigestEntry(db, entry({ text: 'Kept [#ex1]\nHidden [#ex9]' }));
    const [hit] = searchDigest(db, 'hidden');
    expect(hit.text).toContain('Hidden [#ex9]');
    expect(hit.text).toContain('Kept [#ex1]');
  });

  it('searchDigest leaves an entry unchanged when no line names a hidden id', () => {
    insertDigestEntry(db, entry({ text: 'Kept [#ex1]' }));
    const [hit] = searchDigest(db, 'kept', undefined, 10, { hideExchangeIds: ['ex9'] });
    expect(hit.text).toBe('Kept [#ex1]');
  });
});

describe('digest schema via migrateSchema', () => {
  const dir = path.join(os.tmpdir(), 'digest-migrate-' + Date.now());
  beforeEach(() => {
    fs.mkdirSync(dir, { recursive: true });
    process.env.TEST_DB_PATH = path.join(dir, 't.db');
  });
  afterEach(() => {
    delete process.env.TEST_DB_PATH;
    safeRmSync(dir);
  });

  it('initDatabase creates digest_entry and digest_fts', () => {
    const db = initDatabase();
    const names = (db.prepare(`SELECT name FROM sqlite_master WHERE name IN ('digest_entry','digest_fts')`).all() as { name: string }[]).map(r => r.name).sort();
    expect(names).toEqual(['digest_entry', 'digest_fts']);
    db.close();
  });
});
