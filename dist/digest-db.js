import { toFtsQuery } from './fts-query.js';
function fromRow(r) {
    return {
        id: r.id,
        tier: r.tier,
        project: r.project,
        periodStart: r.period_start,
        periodEnd: r.period_end,
        text: r.text,
        sources: JSON.parse(r.sources),
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
export function ensureDigestSchema(db) {
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
export function insertDigestEntry(db, e) {
    const tx = db.transaction(() => {
        const res = db
            .prepare(`INSERT OR IGNORE INTO digest_entry
           (tier, project, period_start, period_end, text, sources, model, created_at, handoff)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
            .run(e.tier, e.project, e.periodStart, e.periodEnd, e.text, JSON.stringify(e.sources), e.model, new Date().toISOString(), e.handoff ? 1 : 0);
        if (res.changes === 0)
            return null;
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
export function listActiveEntries(db, project) {
    const rows = db
        .prepare(`SELECT * FROM digest_entry
       WHERE project = ? AND superseded_by IS NULL
       ORDER BY period_start DESC, id DESC`)
        .all(project);
    return rows.map(fromRow);
}
/**
 * List the active entries of one tier for all projects. The compression step reads this list.
 *
 * The list excludes handoff notes and sorts by project, then by period start, oldest first.
 */
export function listActiveByTier(db, tier) {
    const rows = db
        .prepare(`SELECT * FROM digest_entry
       WHERE tier = ? AND superseded_by IS NULL AND handoff = 0
       ORDER BY project, period_start, id`)
        .all(tier);
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
export function supersede(db, ids, byId) {
    const stmt = db.prepare('UPDATE digest_entry SET superseded_by = ? WHERE id = ? AND superseded_by IS NULL');
    const tx = db.transaction(() => {
        for (const id of ids)
            stmt.run(byId, id);
    });
    tx();
}
/** A bracket group of a line. A citation mark group has the stored digest form `[#a,#b]`. */
// A group holds no `[`, so an unclosed bracket before a mark cannot hide the mark.
const BRACKET_GROUP = /\[([^\][]*)\]/g;
/**
 * List the exchange ids that the mark groups of a digest line cite.
 *
 * A mark group has the form `[#a,#b]`. A line can hold one mark group for each statement, so the
 * function reads every bracket group of the line, not only the last group. The function ignores each
 * part that does not start with `#`. The function returns an empty list when the line has no mark group.
 *
 * @param line the digest line to check
 */
export function citedExchangeIds(line) {
    const ids = [];
    for (const match of line.matchAll(BRACKET_GROUP)) {
        for (const part of match[1].split(',')) {
            const trimmed = part.trim();
            if (trimmed.startsWith('#'))
                ids.push(trimmed.slice(1));
        }
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
export function hideCitedLines(text, hideExchangeIds) {
    if (!hideExchangeIds || hideExchangeIds.length === 0)
        return text;
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
export function searchDigest(db, query, project, limit = 10, opts = {}) {
    const q = toFtsQuery(query);
    if (!q)
        return [];
    const rows = db
        .prepare(`SELECT e.* FROM digest_fts f
       JOIN digest_entry e ON e.id = f.id
       WHERE digest_fts MATCH ? AND e.superseded_by IS NULL
         AND (? IS NULL OR e.project = ?)
       ORDER BY rank
       LIMIT ?`)
        .all(q, project ?? null, project ?? null, limit);
    const hide = opts.hideExchangeIds;
    if (!hide || hide.length === 0)
        return rows.map(fromRow);
    const out = [];
    for (const row of rows) {
        const filtered = hideCitedLines(row.text, hide);
        // An entry with no visible line left names nothing the solver may see.
        if (!filtered.trim())
            continue;
        out.push({ ...fromRow(row), text: filtered });
    }
    return out;
}
