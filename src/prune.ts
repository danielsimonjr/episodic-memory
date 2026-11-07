import Database from 'better-sqlite3';


/** The counts from one `pruneProjects` call. With `dryRun`, the counts show what a real run would remove. */
export interface PruneResult {
  projects: string[];
  exchangesDeleted: number;
  toolCallsDeleted: number;
  vectorsDeleted: number;
  /** Size of the user+assistant text removed. Not the on-disk saving — that needs VACUUM. */
  bytesFreed: number;
  dryRun: boolean;
}

/**
 * Options for `pruneProjects`.
 */
export interface PruneOptions {
  /** Count what a real run would remove, without changing the database. */
  dryRun?: boolean;
}

/**
 * Removes every indexed row that belongs to a set of projects.
 *
 * The exclude list stops indexing of new rows, but does not remove rows that are already in the index.
 *
 * An empty list returns at once and changes nothing. With `dryRun`, the function counts the rows and deletes nothing.
 * Otherwise, the function deletes the rows in one transaction from four tables: `tool_calls`, `vec_exchanges`, `exchanges_fts` and `exchanges`.
 * A database without an `exchanges_fts` table is pruned too. The function then skips that delete.
 * The connection must load the sqlite-vec extension, as `openDatabase` does.
 *
 * @param db The open database connection to change.
 * @param projects The project names to remove, as stored in the `project` column.
 * @param options Set `dryRun` to count the rows without deleting them.
 */
export function pruneProjects(
  db: Database.Database,
  projects: string[],
  options: PruneOptions = {}
): PruneResult {
  const dryRun = options.dryRun === true;
  const result: PruneResult = {
    projects,
    exchangesDeleted: 0,
    toolCallsDeleted: 0,
    vectorsDeleted: 0,
    bytesFreed: 0,
    dryRun,
  };

  // An empty list must be a no-op. Building an `IN ()` clause from it would either be a
  // syntax error or, worse, match everything — deleting the entire index on a caller's
  // typo. Bail before any SQL is constructed.
  if (projects.length === 0) return result;

  const placeholders = projects.map(() => '?').join(',');
  const idsStmt = db.prepare(`SELECT id FROM exchanges WHERE project IN (${placeholders})`);
  const ids = (idsStmt.all(...projects) as { id: string }[]).map((r) => r.id);
  if (ids.length === 0) return result;

  const sizeRow = db
    .prepare(
      `SELECT COALESCE(SUM(LENGTH(user_message) + LENGTH(assistant_message)), 0) AS bytes
       FROM exchanges WHERE project IN (${placeholders})`
    )
    .get(...projects) as { bytes: number };
  result.bytesFreed = sizeRow.bytes;

  const toolRow = db
    .prepare(
      `SELECT COUNT(*) AS n FROM tool_calls
       WHERE exchange_id IN (SELECT id FROM exchanges WHERE project IN (${placeholders}))`
    )
    .get(...projects) as { n: number };
  result.toolCallsDeleted = toolRow.n;
  result.exchangesDeleted = ids.length;
  result.vectorsDeleted = ids.length;

  if (dryRun) return result;

  const delTools = db.prepare(
    `DELETE FROM tool_calls
     WHERE exchange_id IN (SELECT id FROM exchanges WHERE project IN (${placeholders}))`
  );
  // vec0 virtual tables support neither JOIN nor subquery in DELETE, so vectors go one
  // id at a time. This requires the sqlite-vec extension to be loaded on the connection —
  // initDatabase() does that. A client without it (e.g. Python's stock sqlite3) silently
  // skips the vec table and leaves orphaned vectors behind.
  const delVec = db.prepare('DELETE FROM vec_exchanges WHERE id = ?');
  // Very old databases opened without migrate have no FTS table. Skip that delete then.
  const hasFts = db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'exchanges_fts'").get() !== undefined;
  const delFts = hasFts ? db.prepare('DELETE FROM exchanges_fts WHERE id = ?') : null;
  const delExchanges = db.prepare(
    `DELETE FROM exchanges WHERE project IN (${placeholders})`
  );

  // tool_calls first: it carries an FK to exchanges (see #81).
  const run = db.transaction(() => {
    delTools.run(...projects);
    for (const id of ids) {
      delVec.run(id);
      delFts?.run(id);
    }
    delExchanges.run(...projects);
  });
  run();

  return result;
}
