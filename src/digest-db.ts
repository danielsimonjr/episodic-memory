import type Database from 'better-sqlite3';

export type DigestTier = 'session' | 'day' | 'week';

export interface DigestEntry {
  id: number;
  tier: DigestTier;
  project: string;
  periodStart: string;
  periodEnd: string;
  text: string;
  sources: string[];
  model: string;
  createdAt: string;
  supersededBy: number | null;
  handoff: boolean;
}

type NewDigestEntry = Omit<DigestEntry, 'id' | 'createdAt' | 'supersededBy'>;

interface Row {
  id: number;
  tier: DigestTier;
  project: string;
  period_start: string;
  period_end: string;
  text: string;
  sources: string;
  model: string;
  created_at: string;
  superseded_by: number | null;
  handoff: number;
}

function fromRow(r: Row): DigestEntry {
  return {
    id: r.id,
    tier: r.tier,
    project: r.project,
    periodStart: r.period_start,
    periodEnd: r.period_end,
    text: r.text,
    sources: JSON.parse(r.sources) as string[],
    model: r.model,
    createdAt: r.created_at,
    supersededBy: r.superseded_by,
    handoff: r.handoff === 1,
  };
}

/** Create the digest tables. Idempotent. Entries are never deleted; compression sets superseded_by. */
export function ensureDigestSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS digest_entry (
      id INTEGER PRIMARY KEY,
      tier TEXT NOT NULL CHECK (tier IN ('session','day','week')),
      project TEXT NOT NULL,
      period_start TEXT NOT NULL,
      period_end TEXT NOT NULL,
      text TEXT NOT NULL,
      sources TEXT NOT NULL,
      model TEXT NOT NULL,
      created_at TEXT NOT NULL,
      superseded_by INTEGER,
      handoff INTEGER NOT NULL DEFAULT 0,
      UNIQUE (tier, project, period_start)
    );
    CREATE INDEX IF NOT EXISTS idx_digest_project ON digest_entry(project, superseded_by);
    CREATE VIRTUAL TABLE IF NOT EXISTS digest_fts USING fts5(
      id UNINDEXED,
      text,
      tokenize = 'porter unicode61'
    );
  `);
}

/** Insert one entry. Returns its id, or null when the (tier, project, period_start) key already exists. */
export function insertDigestEntry(db: Database.Database, e: NewDigestEntry): number | null {
  const tx = db.transaction((): number | null => {
    const res = db
      .prepare(
        `INSERT OR IGNORE INTO digest_entry
           (tier, project, period_start, period_end, text, sources, model, created_at, handoff)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        e.tier,
        e.project,
        e.periodStart,
        e.periodEnd,
        e.text,
        JSON.stringify(e.sources),
        e.model,
        new Date().toISOString(),
        e.handoff ? 1 : 0
      );
    if (res.changes === 0) return null;
    const id = Number(res.lastInsertRowid);
    db.prepare('INSERT INTO digest_fts (id, text) VALUES (?, ?)').run(id, e.text);
    return id;
  });
  return tx();
}

/** Entries that no compressed entry has replaced, newest period first. */
export function listActiveEntries(db: Database.Database, project: string): DigestEntry[] {
  const rows = db
    .prepare(
      `SELECT * FROM digest_entry
       WHERE project = ? AND superseded_by IS NULL
       ORDER BY period_start DESC, id DESC`
    )
    .all(project) as Row[];
  return rows.map(fromRow);
}

/** Mark entries as replaced by another entry. Rows stay in the table. */
export function supersede(db: Database.Database, ids: number[], byId: number): void {
  const stmt = db.prepare('UPDATE digest_entry SET superseded_by = ? WHERE id = ? AND superseded_by IS NULL');
  const tx = db.transaction(() => {
    for (const id of ids) stmt.run(byId, id);
  });
  tx();
}

function toFtsQuery(query: string): string | null {
  const terms = query.match(/[\p{L}\p{N}_]+/gu) ?? [];
  if (terms.length === 0) return null;
  return terms.map(t => `"${t}"`).join(' ');
}

/** Full-text search over active entries. Never throws on FTS syntax characters. */
export function searchDigest(db: Database.Database, query: string, project?: string, limit = 10): DigestEntry[] {
  const q = toFtsQuery(query);
  if (!q) return [];
  const rows = db
    .prepare(
      `SELECT e.* FROM digest_fts f
       JOIN digest_entry e ON e.id = f.id
       WHERE digest_fts MATCH ? AND e.superseded_by IS NULL
         AND (? IS NULL OR e.project = ?)
       ORDER BY rank
       LIMIT ?`
    )
    .all(q, project ?? null, project ?? null, limit) as Row[];
  return rows.map(fromRow);
}
