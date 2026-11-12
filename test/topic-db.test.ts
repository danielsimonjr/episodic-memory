import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  ensureTopicSchema,
  installTopicEdit,
  listTopicDocs,
  readTopicDoc,
  searchTopicUnits,
  topicLinks,
  topicTimeline,
  getTopicSession,
  setTopicSessionStatus,
  recordTopicFailedCall,
  getTopicMeta,
  setTopicMeta,
} from '../src/topic-db.js';
import { safeRmSync, suppressConsole } from './test-utils.js';

suppressConsole();

const TABLES = ['topic_doc', 'topic_unit', 'topic_link', 'topic_event', 'topic_unit_fts', 'topic_session', 'topic_meta'];

const WORK_V1 =
  '# Work history\n\n## Employment\n\nJoined A in May.[^1]\n^4a8b10cd\n\n' +
  'Moved to B in August to work on [Orion](project.md#^7c91e2ab).[^2]\n^5e6f7a8b\n\n' +
  '[^1]: Time: 2026-05; Sources: #ex-111\n[^2]: Time: 2026-08; Sources: #ex-222\n';

const WORK_V2 =
  '# Work history\n\n## Employment\n\nJoined A in May.[^1]\n^4a8b10cd\n\n' +
  'Started a new role in June.[^2]\n^aaaaaaaa\n\n' +
  '[^1]: Time: 2026-05; Sources: #ex-111\n[^2]: Time: 2026-06; Sources: #ex-111\n';

/** WORK_V2 with the new paragraph ahead of the kept one. */
const WORK_V2_NEW_FIRST =
  '# Work history\n\n## Employment\n\nStarted a new role in June.[^2]\n^aaaaaaaa\n\n' +
  'Joined A in May.[^1]\n^4a8b10cd\n\n' +
  '[^1]: Time: 2026-05; Sources: #ex-111\n[^2]: Time: 2026-06; Sources: #ex-111\n';

const PROJECT_V1 =
  '# Project\n\n## Orion\n\nOrion is the work on B.[^1]\n^7c91e2ab\n\n' +
  '[^1]: Time: 2026-08-14; Sources: #ex-222\n';

const DUP_A = '# A\n\n## S\n\nX.[^1]\n^4a8b10cd\n\n[^1]: Time: 2026; Sources: #ex-111\n';
const DUP_B = '# B\n\n## S\n\nY.[^1]\n^4a8b10cd\n\n[^1]: Time: 2026; Sources: #ex-111\n';

/** Read every topic table, in row order, as text. */
function snapshot(db: Database.Database): Record<string, string> {
  const out: Record<string, string> = {};
  for (const table of TABLES) {
    out[table] = JSON.stringify(db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all());
  }
  return out;
}

function count(db: Database.Database, sql: string): number {
  return (db.prepare(sql).get() as { c: number }).c;
}

describe('topic-db', () => {
  let dir: string;
  let db: Database.Database;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'topic-db-'));
    db = new Database(path.join(dir, 't.db'));
    ensureTopicSchema(db);
  });

  afterEach(() => {
    db.close();
    safeRmSync(dir);
  });

  /** Install the work and project documents of the project `p`. */
  function installBoth(): void {
    const out = installTopicEdit(
      db,
      'p',
      {
        files: [
          { slug: 'work', text: WORK_V1 },
          { slug: 'project', text: PROJECT_V1 },
        ],
        deletes: [],
      },
      new Map()
    );
    expect(out).toBe('installed');
  }

  it('creates every table and creates them again without error', () => {
    expect(() => ensureTopicSchema(db)).not.toThrow();
    const names = (db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all() as { name: string }[]).map(
      r => r.name
    );
    for (const table of TABLES) expect(names).toContain(table);
  });

  it('installs an edit and reads the documents back', () => {
    installBoth();
    expect(listTopicDocs(db, 'p')).toEqual([
      { slug: 'project', title: 'Project', unitCount: 1 },
      { slug: 'work', title: 'Work history', unitCount: 2 },
    ]);
    const doc = readTopicDoc(db, 'p', 'work');
    expect(doc?.text).toBe(WORK_V1);
    expect(doc?.updatedAt).toEqual(expect.any(String));
    expect(readTopicDoc(db, 'p', 'missing')).toBeNull();
    expect(readTopicDoc(db, 'other', 'work')).toBeNull();
  });

  it('writes one derived row for each paragraph, link and footnote', () => {
    installBoth();
    expect(count(db, `SELECT COUNT(*) AS c FROM topic_unit WHERE project = 'p'`)).toBe(3);
    expect(count(db, `SELECT COUNT(*) AS c FROM topic_link WHERE project = 'p'`)).toBe(1);
    expect(count(db, `SELECT COUNT(*) AS c FROM topic_event WHERE project = 'p'`)).toBe(3);
    expect(count(db, `SELECT COUNT(*) AS c FROM topic_unit_fts WHERE project = 'p'`)).toBe(3);
  });

  it('lists the timeline in time order, with statements and source ids', () => {
    installBoth();
    expect(topicTimeline(db, 'p')).toEqual([
      { time: '2026-05', statement: 'Joined A in May.', unitId: '4a8b10cd', slug: 'work', heading: 'Work history > Employment', sources: ['ex-111'] },
      {
        time: '2026-08',
        statement: 'Moved to B in August to work on [Orion](project.md#^7c91e2ab).',
        unitId: '5e6f7a8b',
        slug: 'work',
        heading: 'Work history > Employment',
        sources: ['ex-222'],
      },
      { time: '2026-08-14', statement: 'Orion is the work on B.', unitId: '7c91e2ab', slug: 'project', heading: 'Project > Orion', sources: ['ex-222'] },
    ]);
  });

  it('keeps an event whose month overlaps the start of the range', () => {
    installBoth();
    expect(topicTimeline(db, 'p', { from: '2026-08-15' }).map(e => e.time)).toEqual(['2026-08']);
    expect(topicTimeline(db, 'p', { from: '2026-08-10' }).map(e => e.time)).toEqual(['2026-08', '2026-08-14']);
    expect(topicTimeline(db, 'p', { to: '2026-05-31' }).map(e => e.time)).toEqual(['2026-05']);
    expect(topicTimeline(db, 'p', { from: '2026-08-15', to: '2026-08' }).map(e => e.time)).toEqual(['2026-08']);
  });

  it('searches unit text with FTS and honours the project filter', () => {
    installBoth();
    expect(searchTopicUnits(db, 'Orion').map(h => h.unitId).sort()).toEqual(['5e6f7a8b', '7c91e2ab']);
    expect(searchTopicUnits(db, 'Orion', { project: 'other' })).toEqual([]);
    expect(searchTopicUnits(db, 'Japan')).toEqual([]);
    expect(searchTopicUnits(db, '  ')).toEqual([]);
  });

  it('limits a search to units with an event in the range and lists the times in range', () => {
    installBoth();
    const hits = searchTopicUnits(db, 'Orion', { from: '2026-08-15' });
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ project: 'p', slug: 'work', unitId: '5e6f7a8b', times: ['2026-08'] });
  });

  it('returns the backlinks and the outgoing links of a unit', () => {
    installBoth();
    expect(topicLinks(db, 'p', '7c91e2ab')).toEqual({
      outgoing: [],
      backlinks: [
        {
          slug: 'work',
          heading: 'Work history > Employment',
          unitId: '5e6f7a8b',
          text: 'Moved to B in August to work on [Orion](project.md#^7c91e2ab).[^2]',
        },
      ],
    });
    const out = topicLinks(db, 'p', '5e6f7a8b')!;
    expect(out.outgoing.map(l => [l.slug, l.unitId])).toEqual([['project', '7c91e2ab']]);
    expect(out.backlinks).toEqual([]);
  });

  it('returns null for a unit that the project does not hold', () => {
    installBoth();
    expect(topicLinks(db, 'p', 'deadbeef')).toBeNull();
    expect(topicLinks(db, 'other', '7c91e2ab')).toBeNull();
  });

  it('keeps the seq of a kept unit and gives a new unit a later seq', () => {
    installBoth();
    const before = new Map(
      (db.prepare(`SELECT unit_id, seq FROM topic_unit WHERE project = 'p'`).all() as { unit_id: string; seq: number }[]).map(
        r => [r.unit_id, r.seq]
      )
    );
    const updatedAt = readTopicDoc(db, 'p', 'work')!.updatedAt;
    const out = installTopicEdit(db, 'p', { files: [{ slug: 'work', text: WORK_V2_NEW_FIRST }], deletes: [] }, new Map([['work', updatedAt]]));
    expect(out).toBe('installed');
    const after = new Map(
      (db.prepare(`SELECT unit_id, seq FROM topic_unit WHERE project = 'p'`).all() as { unit_id: string; seq: number }[]).map(
        r => [r.unit_id, r.seq]
      )
    );
    expect(after.get('4a8b10cd')).toBe(before.get('4a8b10cd'));
    expect(after.get('aaaaaaaa')!).toBeGreaterThan(Math.max(...before.values()));
    expect(after.has('5e6f7a8b')).toBe(false);
    expect(count(db, `SELECT COUNT(*) AS c FROM topic_unit_fts WHERE project = 'p'`)).toBe(3);
    expect(searchTopicUnits(db, 'Moved')).toEqual([]);
  });

  it('installs nothing and leaves every table unchanged when a shown document changed', () => {
    installBoth();
    const before = snapshot(db);
    const out = installTopicEdit(
      db,
      'p',
      { files: [{ slug: 'work', text: WORK_V2 }], deletes: [], sessionId: 'sess-1' },
      new Map([['work', '1999-01-01T00:00:00.000Z']])
    );
    expect(out).toBe('stale');
    expect(snapshot(db)).toEqual(before);
    expect(getTopicSession(db, 'p', 'sess-1')).toBeNull();
  });

  it('treats a shown document that was deleted as stale', () => {
    installBoth();
    const updatedAt = readTopicDoc(db, 'p', 'project')!.updatedAt;
    db.prepare(`DELETE FROM topic_doc WHERE project = 'p' AND slug = 'project'`).run();
    const before = snapshot(db);
    const out = installTopicEdit(db, 'p', { files: [], deletes: ['project'] }, new Map([['project', updatedAt]]));
    expect(out).toBe('stale');
    expect(snapshot(db)).toEqual(before);
  });

  it('rolls back the whole edit when a derived row cannot be written', () => {
    installBoth();
    const before = snapshot(db);
    // Two documents with one identifier: the unit table has one row per (project, unit_id).
    expect(() =>
      installTopicEdit(
        db,
        'p',
        {
          files: [
            { slug: 'a', text: DUP_A },
            { slug: 'b', text: DUP_B },
          ],
          deletes: ['project'],
        },
        new Map()
      )
    ).toThrow();
    expect(snapshot(db)).toEqual(before);
  });

  it('rolls back and throws when a paragraph has no identifier', () => {
    installBoth();
    const before = snapshot(db);
    const noId = '# T\n\n## S\n\nNo id.[^1]\n\n[^1]: Time: 2026; Sources: #ex-111\n';
    expect(() => installTopicEdit(db, 'p', { files: [{ slug: 'work', text: noId }], deletes: [] }, new Map())).toThrow();
    expect(snapshot(db)).toEqual(before);
  });

  it('removes the rows of a deleted document', () => {
    installBoth();
    const out = installTopicEdit(db, 'p', { files: [], deletes: ['project'] }, new Map([['project', readTopicDoc(db, 'p', 'project')!.updatedAt]]));
    expect(out).toBe('installed');
    expect(listTopicDocs(db, 'p').map(d => d.slug)).toEqual(['work']);
    expect(count(db, `SELECT COUNT(*) AS c FROM topic_unit WHERE project = 'p' AND slug = 'project'`)).toBe(0);
    expect(topicTimeline(db, 'p').map(e => e.slug)).toEqual(['work', 'work']);
  });

  it('records a session as done in the same transaction as the install', () => {
    const out = installTopicEdit(
      db,
      'p',
      { files: [{ slug: 'work', text: WORK_V1 }], deletes: [], sessionId: 'sess-9' },
      new Map()
    );
    expect(out).toBe('installed');
    expect(getTopicSession(db, 'p', 'sess-9')).toEqual({ status: 'done', attempts: 0, error: null });
  });

  it('counts failed calls on a pending session and records the last error', () => {
    expect(getTopicSession(db, 'p', 'sess-2')).toBeNull();
    expect(recordTopicFailedCall(db, 'p', 'sess-2', 'boom 1')).toBe(1);
    expect(recordTopicFailedCall(db, 'p', 'sess-2', 'boom 2')).toBe(2);
    expect(getTopicSession(db, 'p', 'sess-2')).toEqual({ status: 'pending', attempts: 2, error: 'boom 2' });
    setTopicSessionStatus(db, 'p', 'sess-2', 'rejected', 'final');
    expect(getTopicSession(db, 'p', 'sess-2')).toEqual({ status: 'rejected', attempts: 2, error: 'final' });
  });

  it.each(['3', '#ex-111, 3', '#'])('rolls back and throws for the source text "%s"', sources => {
    installBoth();
    const before = snapshot(db);
    const text = PROJECT_V1.replace('Sources: #ex-222', `Sources: ${sources}`);
    const updatedAt = readTopicDoc(db, 'p', 'project')!.updatedAt;
    expect(() =>
      installTopicEdit(db, 'p', { files: [{ slug: 'project', text }], deletes: [] }, new Map([['project', updatedAt]]))
    ).toThrow(/not a #<exchange id>/);
    expect(snapshot(db)).toEqual(before);
  });

  it('rejects a range bound that is not a valid time', () => {
    installBoth();
    expect(() => topicTimeline(db, 'p', { from: '2026-8' })).toThrow(/range bound/);
    expect(() => searchTopicUnits(db, 'Orion', { to: '2026-13' })).toThrow(/range bound/);
  });

  it('returns no rows for a query of only an underscore', () => {
    installBoth();
    expect(searchTopicUnits(db, '_')).toEqual([]);
  });

  it('gives each footnote of a two-footnote paragraph its own statement', () => {
    const text =
      '# Work history\n\n## Employment\n\nJoined A in May.[^1] Moved to B in August to work on [Orion](project.md#^7c91e2ab).[^2]\n^4a8b10cd\n\n' +
      '[^1]: Time: 2026-05; Sources: #ex-111\n[^2]: Time: 2026-08; Sources: #ex-222\n';
    installTopicEdit(
      db,
      'p',
      { files: [{ slug: 'work', text }, { slug: 'project', text: PROJECT_V1 }], deletes: [] },
      new Map()
    );
    const statements = topicTimeline(db, 'p', {})
      .filter(e => e.unitId === '4a8b10cd')
      .map(e => e.statement);
    expect(statements).toEqual([
      'Joined A in May.',
      'Moved to B in August to work on [Orion](project.md#^7c91e2ab).',
    ]);
  });

  it('stores and reads meta values', () => {
    expect(getTopicMeta(db, 'since')).toBeNull();
    setTopicMeta(db, 'since', '2026-11-01T00:00:00.000Z');
    expect(getTopicMeta(db, 'since')).toBe('2026-11-01T00:00:00.000Z');
    setTopicMeta(db, 'since', 'later');
    expect(getTopicMeta(db, 'since')).toBe('later');
  });
});
