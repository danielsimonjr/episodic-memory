import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { ensureDigestSchema, insertDigestEntry, supersede, type DigestTier } from '../src/digest-db.js';
import { buildDigestText, projectKeyFromCwd } from '../src/digest-inject.js';

let db: Database.Database;

function add(tier: DigestTier, start: string, text: string, over: { handoff?: boolean; project?: string } = {}) {
  return insertDigestEntry(db, {
    tier,
    project: over.project ?? 'proj-a',
    periodStart: start,
    periodEnd: start,
    text,
    sources: ['e1'],
    model: 'haiku',
    handoff: over.handoff ?? false,
  })!;
}

describe('projectKeyFromCwd', () => {
  it('maps every non-alphanumeric character to a hyphen, like the archive project key', () => {
    expect(projectKeyFromCwd('C:\\')).toBe('C--');
    expect(projectKeyFromCwd('C:\\Users\\danie\\Github')).toBe('C--Users-danie-Github');
    expect(projectKeyFromCwd('/home/me/my project')).toBe('-home-me-my-project');
  });
});

describe('buildDigestText', () => {
  beforeEach(() => {
    db = new Database(':memory:');
    ensureDigestSchema(db);
  });

  it('returns an empty string when the project has no entries', () => {
    expect(buildDigestText(db, 'proj-a', 6000)).toBe('');
  });

  it('puts a handoff note first, then newer entries before older ones', () => {
    add('session', '2026-10-01T09:00:00.000Z', 'Old fact [#e1]');
    add('session', '2026-10-07T09:00:00.000Z', 'New fact [#e1]');
    add('session', '2026-10-03T09:00:00.000Z', 'Resume the cache work [#e1]', { handoff: true });
    const text = buildDigestText(db, 'proj-a', 6000);
    expect(text.indexOf('Resume the cache work')).toBeLessThan(text.indexOf('New fact'));
    expect(text.indexOf('New fact')).toBeLessThan(text.indexOf('Old fact'));
  });

  it('omits superseded entries and other projects', () => {
    const a = add('session', '2026-10-01T09:00:00.000Z', 'Replaced fact [#e1]');
    const day = add('day', '2026-10-01T00:00:00.000Z', 'Day summary [#e1]');
    supersede(db, [a], day);
    add('session', '2026-10-02T09:00:00.000Z', 'Other project fact [#e1]', { project: 'proj-b' });
    const text = buildDigestText(db, 'proj-a', 6000);
    expect(text).toContain('Day summary');
    expect(text).not.toContain('Replaced fact');
    expect(text).not.toContain('Other project fact');
  });

  it('never exceeds the budget, drops the oldest entries first, and ends on a whole line', () => {
    for (let d = 1; d <= 9; d++) {
      add('session', `2026-10-0${d}T09:00:00.000Z`, `Fact number ${d} ${'x'.repeat(100)} [#e1]`);
    }
    const text = buildDigestText(db, 'proj-a', 600);
    expect(text.length).toBeLessThanOrEqual(600);
    expect(text).toContain('Fact number 9');
    expect(text).not.toContain('Fact number 1 ');
    expect(text.endsWith('\n')).toBe(true);
  });

  it('returns an empty string when even the header plus one entry does not fit', () => {
    add('session', '2026-10-01T09:00:00.000Z', `Big ${'y'.repeat(500)} [#e1]`);
    expect(buildDigestText(db, 'proj-a', 100)).toBe('');
  });
});
