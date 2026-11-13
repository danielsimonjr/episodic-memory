import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { ensureDigestSchema, insertDigestEntry, supersede, searchDigest, type DigestEntry } from '../src/digest-db.js';
import { dropLinesCiting, removeDerivedText } from '../src/derived-text.js';

type NewEntry = Omit<DigestEntry, 'id' | 'createdAt' | 'supersededBy'>;

function entry(over: Partial<NewEntry> = {}): NewEntry {
  return {
    tier: 'session',
    project: 'proj-a',
    periodStart: '2026-10-08T09:00:00.000Z',
    periodEnd: '2026-10-08T09:30:00.000Z',
    text: 'Chose sqlite for the cache [#ex1]\nRejected redis for the queue [#ex2,#ex3]',
    sources: ['ex1', 'ex2', 'ex3'],
    model: 'haiku',
    handoff: false,
    ...over,
  };
}

interface Row {
  text: string;
  sources: string;
  superseded_by: number | null;
}

describe('dropLinesCiting removes the digest lines that cite a removed exchange', () => {
  it('keeps the other lines and rebuilds the sources in first-seen order', () => {
    const out = dropLinesCiting('Alpha line [#ex1]\nBeta line [#ex2,#ex3]\nGamma line [#ex3,#ex4]', new Set(['ex2']));
    expect(out.text).toBe('Alpha line [#ex1]\nGamma line [#ex3,#ex4]');
    expect(out.sources).toEqual(['ex1', 'ex3', 'ex4']);
    expect(out.dropped).toBe(1);
  });

  it('drops a line when only an inner mark group cites the removed exchange', () => {
    const out = dropLinesCiting('Alpha [#ex9] and beta [#ex1]\nGamma [#ex2]', new Set(['ex9']));
    expect(out.text).toBe('Gamma [#ex2]');
    expect(out.sources).toEqual(['ex2']);
    expect(out.dropped).toBe(1);
  });

  it('changes nothing when no line cites a removed exchange', () => {
    const text = 'Alpha [#ex1]\nBeta [#ex2]';
    expect(dropLinesCiting(text, new Set(['ex7']))).toEqual({ text, sources: ['ex1', 'ex2'], dropped: 0 });
  });

  it('does not read an id that only starts with a removed id as that id', () => {
    const out = dropLinesCiting('Alpha [#ex10]', new Set(['ex1']));
    expect(out.dropped).toBe(0);
  });
});

describe('removeDerivedText', () => {
  let db: Database.Database;
  beforeEach(() => {
    db = new Database(':memory:');
    ensureDigestSchema(db);
  });
  afterEach(() => db.close());

  const row = (id: number) =>
    db.prepare('SELECT text, sources, superseded_by FROM digest_entry WHERE id = ?').get(id) as Row | undefined;

  it('rewrites an entry that keeps a line, and the full-text index loses the dropped line', () => {
    const id = insertDigestEntry(db, entry())!;
    const result = removeDerivedText(db, ['ex2']);
    expect(result).toEqual({ digestLinesRemoved: 1, digestEntriesDeleted: 0 });
    expect(row(id)!.text).toBe('Chose sqlite for the cache [#ex1]');
    expect(JSON.parse(row(id)!.sources)).toEqual(['ex1']);
    expect(searchDigest(db, 'redis', 'proj-a', 10)).toEqual([]);
    expect(searchDigest(db, 'sqlite', 'proj-a', 10).map(e => e.id)).toEqual([id]);
  });

  it('deletes an entry whose every line cites a removed exchange, with its full-text row', () => {
    const id = insertDigestEntry(db, entry())!;
    const result = removeDerivedText(db, ['ex1', 'ex3']);
    expect(result).toEqual({ digestLinesRemoved: 2, digestEntriesDeleted: 1 });
    expect(row(id)).toBeUndefined();
    expect(db.prepare('SELECT COUNT(*) AS n FROM digest_fts').get()).toEqual({ n: 0 });
  });

  it('makes the entries that a deleted entry superseded active again', () => {
    const kept = insertDigestEntry(db, entry({ text: 'Kept fact [#ex5]', sources: ['ex5'] }))!;
    const day = insertDigestEntry(
      db,
      entry({ tier: 'day', periodStart: '2026-10-08', text: 'Merged fact [#ex1]', sources: ['ex1'] })
    )!;
    supersede(db, [kept], day);
    removeDerivedText(db, ['ex1']);
    expect(row(day)).toBeUndefined();
    expect(row(kept)!.superseded_by).toBeNull();
  });

  it('scrubs a superseded entry too', () => {
    const old = insertDigestEntry(db, entry())!;
    const day = insertDigestEntry(
      db,
      entry({ tier: 'day', periodStart: '2026-10-08', text: 'Other fact [#ex8]', sources: ['ex8'] })
    )!;
    supersede(db, [old], day);
    removeDerivedText(db, ['ex2']);
    expect(row(old)!.text).toBe('Chose sqlite for the cache [#ex1]');
    expect(row(old)!.superseded_by).toBe(day);
  });

  it('leaves a handoff note and an entry that cites none of the ids unchanged', () => {
    const note = insertDigestEntry(db, entry({ handoff: true, text: 'Next: ship it', sources: [] }))!;
    const other = insertDigestEntry(db, entry({ periodStart: '2026-10-09T09:00:00.000Z' }))!;
    expect(removeDerivedText(db, ['ex7'])).toEqual({ digestLinesRemoved: 0, digestEntriesDeleted: 0 });
    expect(row(note)!.text).toBe('Next: ship it');
    expect(row(other)!.text).toBe(entry().text);
  });

  it('returns zero counts for an empty id list and for a database without digest tables', () => {
    expect(removeDerivedText(db, [])).toEqual({ digestLinesRemoved: 0, digestEntriesDeleted: 0 });
    const bare = new Database(':memory:');
    try {
      expect(removeDerivedText(bare, ['ex1'])).toEqual({ digestLinesRemoved: 0, digestEntriesDeleted: 0 });
    } finally {
      bare.close();
    }
  });
});
