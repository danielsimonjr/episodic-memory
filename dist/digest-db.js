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
/** Create the digest tables. Idempotent. Entries are never deleted; compression sets superseded_by. */
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
/** Insert one entry. Returns its id, or null when the (tier, project, period_start) key already exists. */
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
/** Entries that no compressed entry has replaced, newest period first. */
export function listActiveEntries(db, project) {
    const rows = db
        .prepare(`SELECT * FROM digest_entry
       WHERE project = ? AND superseded_by IS NULL
       ORDER BY period_start DESC, id DESC`)
        .all(project);
    return rows.map(fromRow);
}
/** Active, non-handoff entries of one tier across all projects, oldest first. Input for compression. */
export function listActiveByTier(db, tier) {
    const rows = db
        .prepare(`SELECT * FROM digest_entry
       WHERE tier = ? AND superseded_by IS NULL AND handoff = 0
       ORDER BY project, period_start, id`)
        .all(tier);
    return rows.map(fromRow);
}
/** Mark entries as replaced by another entry. Rows stay in the table. */
export function supersede(db, ids, byId) {
    const stmt = db.prepare('UPDATE digest_entry SET superseded_by = ? WHERE id = ? AND superseded_by IS NULL');
    const tx = db.transaction(() => {
        for (const id of ids)
            stmt.run(byId, id);
    });
    tx();
}
function toFtsQuery(query) {
    const terms = query.match(/[\p{L}\p{N}_]+/gu) ?? [];
    if (terms.length === 0)
        return null;
    return terms.map(t => `"${t}"`).join(' ');
}
/** A citation mark group at the end of a line: `[#a,#b]` (the stored digest form). */
const TRAILING_MARK_GROUP = /\s*\[([^\]]*)\]\s*$/;
/** The exchange ids a digest line cites, or an empty list when it cites nothing. */
export function citedExchangeIds(line) {
    const match = TRAILING_MARK_GROUP.exec(line);
    if (!match)
        return [];
    const ids = [];
    for (const part of match[1].split(',')) {
        const trimmed = part.trim();
        if (trimmed.startsWith('#'))
            ids.push(trimmed.slice(1));
    }
    return ids;
}
/**
 * Drop every line that cites a hidden exchange, keeping the rest verbatim.
 *
 * The learn solver is handed a task's source exchange ids and must never see a
 * digest line naming one (spec §4.4 leak rule). Whole lines go, never partial
 * text: a line with its marks cut off is a hint with a dangling claim, and the
 * marks are what make a line verifiable.
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
/** Full-text search over active entries. Never throws on FTS syntax characters. */
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
