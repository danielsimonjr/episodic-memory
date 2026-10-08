import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { ensureDigestSchema, insertDigestEntry, listActiveEntries } from '../src/digest-db.js';
import { compressDigest } from '../src/digest-compress.js';
import { suppressConsole } from './test-utils.js';

suppressConsole();

let db: Database.Database;

function addSession(n: number, day = '2026-10-06', project = 'proj-a') {
  const hh = String(n).padStart(2, '0');
  return insertDigestEntry(db, {
    tier: 'session',
    project,
    periodStart: `${day}T${hh}:00:00.000Z`,
    periodEnd: `${day}T${hh}:30:00.000Z`,
    text: `Fact ${n} [#e${n}]`,
    sources: [`e${n}`],
    model: 'haiku',
    handoff: false,
  })!;
}

const NOW = new Date('2026-10-20T12:00:00.000Z');

const merge = async (prompt: string) => {
  // The fake model cites every mark it sees in the prompt.
  const notes = prompt.split('Notes:')[1] ?? '';
  const nums = [...notes.matchAll(/\[(\d+(?:,\d+)*)\]/g)].flatMap(m => m[1].split(','));
  const uniq = [...new Set(nums)];
  return `Merged work on the cache [${uniq.join(',')}]`;
};

describe('compressDigest', () => {
  beforeEach(() => {
    db = new Database(':memory:');
    ensureDigestSchema(db);
  });

  it('turns six session entries on one day into one day entry and supersedes all six', async () => {
    const ids = [1, 2, 3, 4, 5, 6].map(n => addSession(n));
    const r = await compressDigest(db, { model: merge, dayCap: 5, now: NOW });
    expect(r.created).toBe(1);
    const active = listActiveEntries(db, 'proj-a');
    expect(active).toHaveLength(1);
    expect(active[0].tier).toBe('day');
    expect(active[0].sources).toEqual(['e1', 'e2', 'e3', 'e4', 'e5', 'e6']);
    const rows = db.prepare('SELECT id, superseded_by FROM digest_entry WHERE tier = ?').all('session') as { id: number; superseded_by: number | null }[];
    expect(rows).toHaveLength(6);
    expect(rows.every(x => x.superseded_by === active[0].id)).toBe(true);
    expect(ids).toHaveLength(6);
  });

  it('leaves five or fewer session entries alone', async () => {
    [1, 2, 3, 4, 5].forEach(n => addSession(n));
    const r = await compressDigest(db, { model: merge, dayCap: 5, now: NOW });
    expect(r.created).toBe(0);
    expect(listActiveEntries(db, 'proj-a')).toHaveLength(5);
  });

  it('is idempotent', async () => {
    [1, 2, 3, 4, 5, 6].forEach(n => addSession(n));
    await compressDigest(db, { model: merge, dayCap: 5, now: NOW });
    const r2 = await compressDigest(db, { model: merge, dayCap: 5, now: NOW });
    expect(r2.created).toBe(0);
    expect(listActiveEntries(db, 'proj-a')).toHaveLength(1);
  });

  it('never merges across projects', async () => {
    [1, 2, 3].forEach(n => addSession(n, '2026-10-06', 'proj-a'));
    [11, 12, 13].forEach(n => addSession(n, '2026-10-06', 'proj-b'));
    const r = await compressDigest(db, { model: merge, dayCap: 5, now: NOW });
    expect(r.created).toBe(0);
  });

  it('turns more than seven day entries in one ISO week into a week entry', async () => {
    // 2026-09-07 is a Monday: these seven day entries fill one ISO week that ended before NOW.
    const days = ['2026-09-07', '2026-09-08', '2026-09-09', '2026-09-10', '2026-09-11', '2026-09-12', '2026-09-13'];
    for (const d of days) {
      insertDigestEntry(db, {
        tier: 'day',
        project: 'proj-a',
        periodStart: `${d}T00:00:00.000Z`,
        periodEnd: `${d}T23:59:59.000Z`,
        text: `Day fact ${d} [#x${d}]`,
        sources: [`x${d}`],
        model: 'haiku',
        handoff: false,
      });
    }
    const r = await compressDigest(db, { model: merge, weekCap: 6, now: NOW });
    expect(r.created).toBe(1);
    const active = listActiveEntries(db, 'proj-a');
    expect(active).toHaveLength(1);
    expect(active[0].tier).toBe('week');
  });

  it('does not compress today', async () => {
    [1, 2, 3, 4, 5, 6].forEach(n => addSession(n, '2026-10-20'));
    const r = await compressDigest(db, { model: merge, dayCap: 5, now: NOW });
    expect(r.created).toBe(0);
    expect(listActiveEntries(db, 'proj-a')).toHaveLength(6);
  });

  it('a failed compress call leaves the originals active', async () => {
    [1, 2, 3, 4, 5, 6].forEach(n => addSession(n));
    const r = await compressDigest(db, {
      model: async () => {
        throw new Error('boom');
      },
      dayCap: 5,
      now: NOW,
    });
    expect(r.failed).toBe(1);
    expect(r.created).toBe(0);
    expect(listActiveEntries(db, 'proj-a')).toHaveLength(6);
  });

  it('an invalid answer leaves the originals active', async () => {
    [1, 2, 3, 4, 5, 6].forEach(n => addSession(n));
    const r = await compressDigest(db, { model: async () => 'No citation here', dayCap: 5, now: NOW });
    expect(r.created).toBe(0);
    expect(listActiveEntries(db, 'proj-a')).toHaveLength(6);
  });

  it('does not compress a handoff note', async () => {
    [1, 2, 3, 4, 5].forEach(n => addSession(n));
    insertDigestEntry(db, {
      tier: 'session',
      project: 'proj-a',
      periodStart: '2026-10-06T23:00:00.000Z',
      periodEnd: '2026-10-06T23:00:00.000Z',
      text: 'Handoff: resume the cache work [#e1]',
      sources: ['e1'],
      model: 'user',
      handoff: true,
    });
    const r = await compressDigest(db, { model: merge, dayCap: 5, now: NOW });
    expect(r.created).toBe(0);
  });
});
