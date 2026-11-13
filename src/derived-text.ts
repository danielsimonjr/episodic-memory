import type { Database } from './sqlite.js';
import { citedExchangeIds } from './digest-db.js';

/** The counts of one call of `removeDerivedText`. */
export interface DerivedTextResult {
  /** Digest lines removed, in entries that stay and in entries that go. */
  digestLinesRemoved: number;
  /** Digest entries deleted because no line stayed. */
  digestEntriesDeleted: number;
}

interface DigestRow {
  id: number;
  text: string;
  sources: string;
}

/**
 * Remove the stored digest lines that cite a removed exchange.
 *
 * The function reads the mark groups of each line with `citedExchangeIds`, the reader of the digest search.
 * The function drops a whole line when the line cites an id in `removed`. A line without its marks states a claim
 * that no exchange supports. The function keeps the other lines in order. The function rebuilds the sources from the
 * kept lines, deduplicated, in first-seen order.
 *
 * @param text the stored text of a digest entry, one line for each statement
 * @param removed the ids of the exchanges that are no longer in the index
 */
export function dropLinesCiting(
  text: string,
  removed: ReadonlySet<string>
): { text: string; sources: string[]; dropped: number } {
  const lines: string[] = [];
  const sources: string[] = [];
  let dropped = 0;
  for (const line of text.split('\n')) {
    const ids = citedExchangeIds(line);
    if (ids.some(id => removed.has(id))) {
      dropped++;
      continue;
    }
    lines.push(line);
    for (const id of ids) if (!sources.includes(id)) sources.push(id);
  }
  return { text: lines.join('\n'), sources, dropped };
}

/** Tell whether the database holds a table or a virtual table of this name. */
function hasTable(db: Database, name: string): boolean {
  return db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) !== undefined;
}

/**
 * Remove the digest text that cites deleted exchanges.
 *
 * A digest line cites the exchanges that the line comes from. After the index deletes an exchange, a line that cites
 * the exchange can still repeat the deleted conversation. The function drops each matching line from every digest
 * entry, active or superseded. An entry that keeps a line gets the new text, the new sources and a new full-text row. The function
 * deletes an entry with no line left and its full-text row. The entries that a deleted entry superseded become active
 * again. The next compression step can merge these entries again.
 *
 * The function calls no model and runs in one transaction. A database without the digest tables returns zero counts.
 * Call the function after the index deletes the exchanges. Pass the ids of the deleted exchanges.
 *
 * @param db The open database connection to change.
 * @param ids The ids of the exchanges that the index deleted.
 */
export function removeDerivedText(db: Database, ids: readonly string[]): DerivedTextResult {
  const result: DerivedTextResult = { digestLinesRemoved: 0, digestEntriesDeleted: 0 };
  if (ids.length === 0 || !hasTable(db, 'digest_entry')) return result;
  const removed = new Set(ids);
  const hasFts = hasTable(db, 'digest_fts');

  const rows = db.prepare('SELECT id, text, sources FROM digest_entry').all() as DigestRow[];
  const update = db.prepare('UPDATE digest_entry SET text = ?, sources = ? WHERE id = ?');
  const remove = db.prepare('DELETE FROM digest_entry WHERE id = ?');
  const release = db.prepare('UPDATE digest_entry SET superseded_by = NULL WHERE superseded_by = ?');
  const ftsDelete = hasFts ? db.prepare('DELETE FROM digest_fts WHERE id = ?') : null;
  const ftsInsert = hasFts ? db.prepare('INSERT INTO digest_fts (id, text) VALUES (?, ?)') : null;

  db.transaction(() => {
    for (const row of rows) {
      const cited = JSON.parse(row.sources) as string[];
      if (!cited.some(id => removed.has(id))) continue;
      const kept = dropLinesCiting(row.text, removed);
      if (kept.dropped === 0) continue;
      result.digestLinesRemoved += kept.dropped;
      ftsDelete?.run(row.id);
      if (kept.text === '') {
        remove.run(row.id);
        release.run(row.id);
        result.digestEntriesDeleted++;
      } else {
        update.run(kept.text, JSON.stringify(kept.sources), row.id);
        ftsInsert?.run(row.id, kept.text);
      }
    }
  })();
  return result;
}
