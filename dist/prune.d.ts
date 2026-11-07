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
export declare function pruneProjects(db: Database.Database, projects: string[], options?: PruneOptions): PruneResult;
