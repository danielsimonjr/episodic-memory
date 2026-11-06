import type Database from 'better-sqlite3';

/** The tier of a digest entry: `session`, `day` or `week`. */
export type DigestTier = 'session' | 'day' | 'week';

/**
 * One digest entry describes one project for one period.
 */
export interface DigestEntry {
  id: number;
  tier: DigestTier;
  project: string;
  periodStart: string;
  periodEnd: string;
  text: string;
  /** The exchange ids that the text cites. A handoff note has none. */
  sources: string[];
  /** The model that wrote the text, or `handoff` for a handoff note. */
  model: string;
  createdAt: string;
  /** The id of the entry that replaces this entry, or null while this entry is active. */
  supersededBy: number | null;
  /** True for a one-line note that a session stores for the next session. */
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

/**
 * Create the digest tables and the full-text index when they do not exist.
 *
 * Running the function again has no effect. The module never deletes an entry.
 * The supersede function marks a replaced entry instead.
 */
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

/**
 * Insert one digest entry and its full-text row in one transaction.
 *
 * The function sets created_at to the current time and returns the new id.
 * The function returns null, and writes nothing, when an entry with the same tier, project and periodStart already exists.
 */
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

/**
 * List the active entries of one project, newest period first.
 *
 * An entry is active while no other entry supersedes it. The list includes handoff notes.
 */
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

/**
 * List the active entries of one tier for all projects. The compression step reads this list.
 *
 * The list excludes handoff notes and sorts by project, then by period start, oldest first.
 */
export function listActiveByTier(db: Database.Database, tier: DigestTier): DigestEntry[] {
  const rows = db
    .prepare(
      `SELECT * FROM digest_entry
       WHERE tier = ? AND superseded_by IS NULL AND handoff = 0
       ORDER BY project, period_start, id`
    )
    .all(tier) as Row[];
  return rows.map(fromRow);
}

/**
 * Mark entries as replaced by another entry. The rows stay in the table.
 *
 * The function sets superseded_by only on entries that have no replacement yet.
 * An entry that already has a replacement keeps its first one.
 *
 * @param ids the entries to mark
 * @param byId the id of the replacing entry
 */
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

/** A citation mark group at the end of a line: `[#a,#b]` (the stored digest form). */
const TRAILING_MARK_GROUP = /\s*\[([^\]]*)\]\s*$/;

/**
 * List the exchange ids that the trailing mark group of a digest line cites.
 *
 * The mark group has the form `[#a,#b]`. The function returns an empty list when the line
 * has no trailing group. The function ignores each part that does not start with `#`.
 *
 * @param line the digest line to check
 */
export function citedExchangeIds(line: string): string[] {
  const match = TRAILING_MARK_GROUP.exec(line);
  if (!match) return [];
  const ids: string[] = [];
  for (const part of match[1].split(',')) {
    const trimmed = part.trim();
    if (trimmed.startsWith('#')) ids.push(trimmed.slice(1));
  }
  return ids;
}

/**
 * Remove every line that cites a hidden exchange, and keep the other lines unchanged.
 *
 * The learn solver must not see a digest line that names a source exchange of its task.
 * The function removes whole lines only. A line with its marks removed would state a claim
 * that no exchange supports.
 *
 * @param text the digest text, one line for each statement
 * @param hideExchangeIds the exchange ids to hide. The function returns `text` unchanged when this list is empty or missing.
 */
export function hideCitedLines(text: string, hideExchangeIds?: string[]): string {
  if (!hideExchangeIds || hideExchangeIds.length === 0) return text;
  const hidden = new Set(hideExchangeIds);
  return text
    .split('\n')
    .filter(line => !citedExchangeIds(line).some(id => hidden.has(id)))
    .join('\n');
}

/**
 * Search the active digest entries for a query.
 *
 * The function keeps only letters, digits and underscores from the query, and matches every remaining word.
 * A query with no such characters returns an empty list. When the caller omits `project`, the search covers all projects.
 * The SQL query returns at most `limit` entries, ordered by full-text rank.
 *
 * @param db the open index database
 * @param query the words to search for
 * @param project the project key to search. The search covers all projects when the caller omits `project`.
 * @param limit the maximum number of entries to fetch. Hidden lines can make the result shorter.
 * @param opts `hideExchangeIds` lists exchange ids. The function removes the lines that cite them and drops each entry with no line left.
 */
export function searchDigest(
  db: Database.Database,
  query: string,
  project?: string,
  limit = 10,
  opts: { hideExchangeIds?: string[] } = {}
): DigestEntry[] {
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
  const hide = opts.hideExchangeIds;
  if (!hide || hide.length === 0) return rows.map(fromRow);

  const out: DigestEntry[] = [];
  for (const row of rows) {
    const filtered = hideCitedLines(row.text, hide);
    // An entry with no visible line left names nothing the solver may see.
    if (!filtered.trim()) continue;
    out.push({ ...fromRow(row), text: filtered });
  }
  return out;
}
