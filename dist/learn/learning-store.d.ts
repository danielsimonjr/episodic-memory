/**
 * The learning trace database: `<configDir>/learned/learning.sqlite`.
 *
 * This is the plugin's own database, opened with `better-sqlite3` directly, so
 * a SessionStart hook can read the rendered learned block without loading
 * memoryjs (§6.3 of the Recursa spec). It sits beside `knowledge.db` under
 * `learned/`, a sibling of `conversation-index/`, so an index reset never
 * reaches it.
 *
 * Task 1 creates `knowledge_snapshot` and `learned_block`; the `learning_*`
 * tables (runs, tasks, attempts) are added with their code.
 */
import Database from 'better-sqlite3';
/** Tables this module owns today. Later tasks extend the list. */
export declare const LEARNING_TABLES: readonly ["knowledge_snapshot", "learned_block"];
export interface OpenLearningDbOptions {
    /** Open read-only. Implies `migrate: false`. */
    readonly?: boolean;
    /** Override the file path (tests, and the hook's explicit path). */
    path?: string;
    /**
     * Run the schema statements. Defaults to true for a writable handle and is
     * forced to false for a read-only one: `CREATE TABLE` against a read-only
     * handle raises SQLITE_READONLY.
     */
    migrate?: boolean;
}
/**
 * Create the learning tables. Idempotent.
 */
export declare function migrateLearningSchema(db: Database.Database): void;
/**
 * Open the learning trace database.
 *
 * Same pragmas and directory modes as `src/db.ts`. With `readonly`, the handle
 * never migrates — the hook opens it read-only on a file that may pre-date a
 * schema change, and SQLite refuses DDL on a read-only connection.
 */
export declare function openLearningDb(options?: OpenLearningDbOptions): Database.Database;
