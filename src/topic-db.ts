import type Database from 'better-sqlite3';
import { toFtsQuery } from './fts-query.js';
import { footnoteStatements, parseTopicDoc } from './topic-format.js';
import { endOf, isValidTime, startOf } from './topic-time.js';

/** A staged edit: the validated text of each written document, and the slugs to delete. */
export interface TopicEdit {
  /** The validated text of each written document. Every paragraph has an identifier. */
  files: { slug: string; text: string }[];
  /** The slugs of the documents to delete. */
  deletes: string[];
  /** The session that the edit organizes. When set, the install records it as `done` in the same transaction. */
  sessionId?: string;
}

/** The status of a session in topic memory. */
export type TopicSessionStatus = 'pending' | 'done' | 'rejected';

/** The progress row of one session. */
export interface TopicSession {
  status: TopicSessionStatus;
  /** The number of failed model calls. */
  attempts: number;
  /** The last error text, or null. */
  error: string | null;
}

/** A unit that a search found. */
export interface TopicUnitHit {
  project: string;
  slug: string;
  heading: string;
  unitId: string;
  text: string;
  /** The event times of the unit. With a range, the times that overlap the range. */
  times: string[];
}

/** A unit at the other end of a link. */
export interface TopicLinkedUnit {
  slug: string;
  heading: string;
  unitId: string;
  text: string;
}

/** One footnote, placed on the timeline. */
export interface TopicEvent {
  time: string;
  /** The text of the paragraph up to the footnote reference. */
  statement: string;
  unitId: string;
  slug: string;
  heading: string;
  /** The exchange ids that the footnote cites. */
  sources: string[];
}

/** A time range. Each bound is a YYYY, YYYY-MM or YYYY-MM-DD value, and both bounds are inclusive. */
export interface TopicRange {
  from?: string;
  to?: string;
}

/** The schema of the topic tables. The function creates each table when it does not exist. */
export function ensureTopicSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS topic_doc (
      project TEXT NOT NULL,
      slug TEXT NOT NULL,
      text TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (project, slug)
    );
    CREATE TABLE IF NOT EXISTS topic_unit (
      project TEXT NOT NULL,
      unit_id TEXT NOT NULL,
      slug TEXT NOT NULL,
      heading TEXT NOT NULL,
      text TEXT NOT NULL,
      seq INTEGER NOT NULL,
      PRIMARY KEY (project, unit_id)
    );
    CREATE TABLE IF NOT EXISTS topic_link (
      project TEXT NOT NULL,
      from_unit TEXT NOT NULL,
      to_unit TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_topic_link_to ON topic_link(project, to_unit);
    CREATE TABLE IF NOT EXISTS topic_event (
      project TEXT NOT NULL,
      unit_id TEXT NOT NULL,
      time TEXT NOT NULL,
      statement TEXT NOT NULL,
      sources TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_topic_event_unit ON topic_event(project, unit_id);
    CREATE VIRTUAL TABLE IF NOT EXISTS topic_unit_fts USING fts5(
      unit_id UNINDEXED,
      project UNINDEXED,
      text,
      tokenize = 'porter unicode61'
    );
    CREATE TABLE IF NOT EXISTS topic_session (
      project TEXT NOT NULL,
      session_id TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('pending','done','rejected')),
      attempts INTEGER NOT NULL DEFAULT 0,
      error TEXT,
      PRIMARY KEY (project, session_id)
    );
    CREATE TABLE IF NOT EXISTS topic_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);
}

/**
 * Install one edit and rebuild the derived tables of the project, in one transaction.
 *
 * The function first compares the stored `updated_at` of each shown document with `expectedUpdatedAt`.
 * On a mismatch, or when a shown document is gone, it returns `stale` and writes nothing. Otherwise it
 * writes the documents, rebuilds the units, links, events and full-text rows of the project, and keeps
 * the `seq` of each unit that stays. When `edit.sessionId` is set, it records that session as `done`.
 * A failed write throws, and the transaction rolls back every change.
 *
 * @param db the open index database
 * @param project the project key
 * @param edit the validated texts and the deleted slugs
 * @param expectedUpdatedAt the `updated_at` that each shown document had when the prompt was built, by slug
 */
export function installTopicEdit(
  db: Database.Database,
  project: string,
  edit: TopicEdit,
  expectedUpdatedAt: ReadonlyMap<string, string>
): 'installed' | 'stale' {
  const tx = db.transaction((): 'installed' | 'stale' => {
    const current = db.prepare('SELECT updated_at FROM topic_doc WHERE project = ? AND slug = ?');
    for (const [slug, updatedAt] of expectedUpdatedAt) {
      const row = current.get(project, slug) as { updated_at: string } | undefined;
      if (row === undefined || row.updated_at !== updatedAt) return 'stale';
    }
    const now = new Date().toISOString();
    const upsert = db.prepare(
      `INSERT INTO topic_doc (project, slug, text, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT (project, slug) DO UPDATE SET text = excluded.text, updated_at = excluded.updated_at`
    );
    for (const file of edit.files) upsert.run(project, file.slug, file.text, now);
    const remove = db.prepare('DELETE FROM topic_doc WHERE project = ? AND slug = ?');
    for (const slug of edit.deletes) remove.run(project, slug);
    rebuildDerived(db, project);
    if (edit.sessionId !== undefined) markSession(db, project, edit.sessionId, 'done', null);
    return 'installed';
  });
  return tx();
}

/**
 * List the documents of a project with their title and unit count, by slug.
 *
 * @param db the open index database
 * @param project the project key
 */
export function listTopicDocs(db: Database.Database, project: string): { slug: string; title: string; unitCount: number }[] {
  const rows = db.prepare('SELECT slug, text FROM topic_doc WHERE project = ? ORDER BY slug').all(project) as {
    slug: string;
    text: string;
  }[];
  return rows.map(row => {
    const doc = parseTopicDoc(row.slug, row.text);
    return { slug: row.slug, title: doc.title, unitCount: doc.units.length };
  });
}

/**
 * Read one document of a project.
 *
 * @param db the open index database
 * @param project the project key
 * @param slug the slug of the document
 * @returns the text and its `updated_at`, or null when the document does not exist
 */
export function readTopicDoc(
  db: Database.Database,
  project: string,
  slug: string
): { slug: string; text: string; updatedAt: string } | null {
  const row = db.prepare('SELECT slug, text, updated_at FROM topic_doc WHERE project = ? AND slug = ?').get(project, slug) as
    | { slug: string; text: string; updated_at: string }
    | undefined;
  return row ? { slug: row.slug, text: row.text, updatedAt: row.updated_at } : null;
}

/**
 * Search the paragraphs of the topic documents with full-text search.
 *
 * The function keeps only letters, digits and underscores from the query, and matches every remaining word.
 * With `from` or `to`, the function keeps a unit only when one of its events overlaps the range, and it
 * lists the overlapping times. Without a range, it lists every event time. The function returns at most
 * `limit` units (default 10), in rank order.
 *
 * @param db the open index database
 * @param query the words to search for
 * @param opts `project` limits the search to one project. `from` and `to` set the range. `limit` caps the result.
 */
export function searchTopicUnits(
  db: Database.Database,
  query: string,
  opts: { project?: string; from?: string; to?: string; limit?: number } = {}
): TopicUnitHit[] {
  assertRange({ from: opts.from, to: opts.to });
  const match = toFtsQuery(query);
  if (!match) return [];
  const project = opts.project ?? null;
  const hasRange = opts.from !== undefined || opts.to !== undefined;
  const range: TopicRange = { from: opts.from, to: opts.to };
  const limit = opts.limit ?? 10;
  const rows = db
    .prepare(
      `SELECT f.project AS project, f.unit_id AS unit_id, u.slug AS slug, u.heading AS heading, u.text AS text
       FROM topic_unit_fts f
       JOIN topic_unit u ON u.project = f.project AND u.unit_id = f.unit_id
       WHERE topic_unit_fts MATCH ? AND (? IS NULL OR f.project = ?)
       ORDER BY rank`
    )
    .all(match, project, project) as {
    project: string;
    unit_id: string;
    slug: string;
    heading: string;
    text: string;
  }[];

  const eventTimes = db.prepare('SELECT time FROM topic_event WHERE project = ? AND unit_id = ?');
  const hits: TopicUnitHit[] = [];
  for (const row of rows) {
    const times = (eventTimes.all(row.project, row.unit_id) as { time: string }[])
      .map(r => r.time)
      .filter(time => !hasRange || overlaps(time, range))
      .sort(compareTimes);
    if (hasRange && times.length === 0) continue;
    hits.push({
      project: row.project,
      slug: row.slug,
      heading: row.heading,
      unitId: row.unit_id,
      text: row.text,
      times,
    });
    if (hits.length >= limit) break;
  }
  return hits;
}

/**
 * List the outgoing links and the backlinks of one unit.
 *
 * @param db the open index database
 * @param project the project key
 * @param unitId the identifier of the unit
 */
export function topicLinks(
  db: Database.Database,
  project: string,
  unitId: string
): { outgoing: TopicLinkedUnit[]; backlinks: TopicLinkedUnit[] } | null {
  const known = db.prepare('SELECT 1 FROM topic_unit WHERE project = ? AND unit_id = ?').get(project, unitId);
  if (known === undefined) return null;
  const outgoing = db
    .prepare(
      `SELECT DISTINCT u.slug AS slug, u.heading AS heading, u.unit_id AS unit_id, u.text AS text, u.seq AS seq
       FROM topic_link l
       JOIN topic_unit u ON u.project = l.project AND u.unit_id = l.to_unit
       WHERE l.project = ? AND l.from_unit = ?
       ORDER BY u.seq`
    )
    .all(project, unitId) as LinkRow[];
  const backlinks = db
    .prepare(
      `SELECT DISTINCT u.slug AS slug, u.heading AS heading, u.unit_id AS unit_id, u.text AS text, u.seq AS seq
       FROM topic_link l
       JOIN topic_unit u ON u.project = l.project AND u.unit_id = l.from_unit
       WHERE l.project = ? AND l.to_unit = ?
       ORDER BY u.seq`
    )
    .all(project, unitId) as LinkRow[];
  return { outgoing: outgoing.map(toLinked), backlinks: backlinks.map(toLinked) };
}

/**
 * List the footnote events of a project in time order, optionally within a range.
 *
 * Each event has its time, its statement, its unit and the exchange ids it cites. An event is in the range
 * when its precision-padded interval overlaps the range. A month `2026-08` covers `2026-08-01` to `2026-08-31`.
 *
 * @param db the open index database
 * @param project the project key
 * @param range the optional bounds, inclusive
 */
export function topicTimeline(db: Database.Database, project: string, range: TopicRange = {}): TopicEvent[] {
  assertRange(range);
  const rows = db
    .prepare(
      `SELECT e.time AS time, e.statement AS statement, e.unit_id AS unit_id, e.sources AS sources,
              u.slug AS slug, u.heading AS heading, u.seq AS seq
       FROM topic_event e
       JOIN topic_unit u ON u.project = e.project AND u.unit_id = e.unit_id
       WHERE e.project = ?`
    )
    .all(project) as {
    time: string;
    statement: string;
    unit_id: string;
    sources: string;
    slug: string;
    heading: string;
    seq: number;
  }[];
  return rows
    .filter(r => overlaps(r.time, range))
    .sort((a, b) => compareTimes(a.time, b.time) || a.seq - b.seq)
    .map(r => ({
      time: r.time,
      statement: r.statement,
      unitId: r.unit_id,
      slug: r.slug,
      heading: r.heading,
      sources: JSON.parse(r.sources) as string[],
    }));
}

/**
 * Read the progress row of one session.
 *
 * @param db the open index database
 * @param project the project key
 * @param sessionId the session id
 * @returns the row, or null when the session has no row
 */
export function getTopicSession(db: Database.Database, project: string, sessionId: string): TopicSession | null {
  const row = db
    .prepare('SELECT status, attempts, error FROM topic_session WHERE project = ? AND session_id = ?')
    .get(project, sessionId) as { status: TopicSessionStatus; attempts: number; error: string | null } | undefined;
  return row ? { status: row.status, attempts: row.attempts, error: row.error } : null;
}

/**
 * Set the status of a session and its last error. The attempt count does not change.
 *
 * @param db the open index database
 * @param project the project key
 * @param sessionId the session id
 * @param status the new status
 * @param error the error text, or null
 */
export function setTopicSessionStatus(
  db: Database.Database,
  project: string,
  sessionId: string,
  status: 'done' | 'rejected',
  error: string | null = null
): void {
  markSession(db, project, sessionId, status, error);
}

/**
 * Count one failed model call for a session and return the new count.
 *
 * The function creates the row as `pending` on the first failure. It keeps the status as it is.
 *
 * @param db the open index database
 * @param project the project key
 * @param sessionId the session id
 * @param error the error text of the failed call
 */
export function recordTopicFailedCall(db: Database.Database, project: string, sessionId: string, error: string): number {
  const tx = db.transaction((): number => {
    db.prepare(
      `INSERT INTO topic_session (project, session_id, status, attempts, error) VALUES (?, ?, 'pending', 1, ?)
       ON CONFLICT (project, session_id) DO UPDATE SET attempts = attempts + 1, error = excluded.error`
    ).run(project, sessionId, error);
    const row = db
      .prepare('SELECT attempts FROM topic_session WHERE project = ? AND session_id = ?')
      .get(project, sessionId) as { attempts: number };
    return row.attempts;
  });
  return tx();
}

/**
 * Read a value of the topic meta table.
 *
 * @param db the open index database
 * @param key the key to read
 * @returns the value, or null when the key is not set
 */
export function getTopicMeta(db: Database.Database, key: string): string | null {
  const row = db.prepare('SELECT value FROM topic_meta WHERE key = ?').get(key) as { value: string } | undefined;
  return row ? row.value : null;
}

/**
 * Set a value of the topic meta table. The function replaces an earlier value.
 *
 * @param db the open index database
 * @param key the key to set
 * @param value the new value
 */
export function setTopicMeta(db: Database.Database, key: string, value: string): void {
  db.prepare(
    `INSERT INTO topic_meta (key, value) VALUES (?, ?)
     ON CONFLICT (key) DO UPDATE SET value = excluded.value`
  ).run(key, value);
}

type LinkRow = { slug: string; heading: string; unit_id: string; text: string; seq: number };

/** Map a link row to the public shape. */
function toLinked(row: LinkRow): TopicLinkedUnit {
  return { slug: row.slug, heading: row.heading, unitId: row.unit_id, text: row.text };
}

/** Write one session row, or update the status and error of an existing row. */
function markSession(
  db: Database.Database,
  project: string,
  sessionId: string,
  status: TopicSessionStatus,
  error: string | null
): void {
  db.prepare(
    `INSERT INTO topic_session (project, session_id, status, attempts, error) VALUES (?, ?, ?, 0, ?)
     ON CONFLICT (project, session_id) DO UPDATE SET status = excluded.status, error = excluded.error`
  ).run(project, sessionId, status, error);
}

/**
 * Rebuild the unit, link, event and full-text rows of one project from its documents.
 *
 * A kept unit keeps its `seq`. A new unit takes the next number after the largest old `seq`, in slug order,
 * then in document order. The function throws when a footnote cites a ref that is not a `#<exchange id>`. The function throws when a paragraph has no identifier, or when two paragraphs share one.
 */
function rebuildDerived(db: Database.Database, project: string): void {
  const docs = db.prepare('SELECT slug, text FROM topic_doc WHERE project = ? ORDER BY slug').all(project) as {
    slug: string;
    text: string;
  }[];

  const oldSeq = new Map<string, number>();
  let next = 0;
  for (const row of db.prepare('SELECT unit_id, seq FROM topic_unit WHERE project = ?').all(project) as {
    unit_id: string;
    seq: number;
  }[]) {
    oldSeq.set(row.unit_id, row.seq);
    next = Math.max(next, row.seq);
  }

  db.prepare('DELETE FROM topic_unit WHERE project = ?').run(project);
  db.prepare('DELETE FROM topic_link WHERE project = ?').run(project);
  db.prepare('DELETE FROM topic_event WHERE project = ?').run(project);
  db.prepare('DELETE FROM topic_unit_fts WHERE project = ?').run(project);

  const insertUnit = db.prepare('INSERT INTO topic_unit (project, unit_id, slug, heading, text, seq) VALUES (?, ?, ?, ?, ?, ?)');
  const insertFts = db.prepare('INSERT INTO topic_unit_fts (unit_id, project, text) VALUES (?, ?, ?)');
  const insertLink = db.prepare('INSERT INTO topic_link (project, from_unit, to_unit) VALUES (?, ?, ?)');
  const insertEvent = db.prepare(
    'INSERT INTO topic_event (project, unit_id, time, statement, sources) VALUES (?, ?, ?, ?, ?)'
  );

  for (const doc of docs) {
    for (const unit of parseTopicDoc(doc.slug, doc.text).units) {
      if (unit.unitId === null) throw new Error(`topic: a paragraph of ${doc.slug} has no identifier`);
      const seq = oldSeq.get(unit.unitId) ?? ++next;
      insertUnit.run(project, unit.unitId, doc.slug, unit.heading, unit.text, seq);
      insertFts.run(unit.unitId, project, unit.text);
      for (const link of unit.links) insertLink.run(project, unit.unitId, link.unitId);
      const statements = footnoteStatements(unit.text);
      for (const footnote of unit.footnotes) {
        const sources = footnote.refs.map(ref => {
          if (ref.length < 2 || !ref.startsWith('#')) {
            throw new Error(`topic: footnote [^${footnote.label}] of ${doc.slug} cites "${ref}", not a #<exchange id>`);
          }
          return ref.slice(1);
        });
        insertEvent.run(
          project,
          unit.unitId,
          footnote.time,
          statements.get(footnote.label) ?? unit.text,
          JSON.stringify(sources)
        );
      }
    }
  }
}

/** Tell whether the interval of a time overlaps the range. */
function overlaps(time: string, range: TopicRange): boolean {
  if (range.from !== undefined && endOf(time) < startOf(range.from)) return false;
  if (range.to !== undefined && startOf(time) > endOf(range.to)) return false;
  return true;
}

/** Order two times by the start of their interval, then by their text. */
function compareTimes(a: string, b: string): number {
  const byStart = startOf(a) < startOf(b) ? -1 : startOf(a) > startOf(b) ? 1 : 0;
  if (byStart !== 0) return byStart;
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Throw when a defined range bound is not a valid `YYYY`, `YYYY-MM` or `YYYY-MM-DD`. */
function assertRange(range: TopicRange): void {
  for (const bound of [range.from, range.to]) {
    if (bound !== undefined && !isValidTime(bound)) {
      throw new Error(`topic: range bound "${bound}" is not YYYY, YYYY-MM or YYYY-MM-DD`);
    }
  }
}
