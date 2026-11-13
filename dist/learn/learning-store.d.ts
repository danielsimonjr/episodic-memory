/**
 * The learning trace database: `<configDir>/learned/learning.sqlite`.
 *
 * The file is the plugin's own database. The module opens the file directly with
 * the node:sqlite adapter. A SessionStart hook can then read the rendered learned block
 * without opening the
 * knowledge store (§6.3 of the Recursa spec). The file sits beside `knowledge.db` under
 * `learned/`, a sibling of `conversation-index/`, so an index reset never
 * reaches the file.
 *
 * The module creates `knowledge_snapshot` and `learned_block`. The function
 * `ensureLearningSchema` in `learning-db.ts` creates the `learning_*` tables (runs,
 * tasks and attempts).
 */
import { Database } from '../sqlite.js';
/** The tables of the learning trace database, in the order that migrateLearningSchema creates them. */
export declare const LEARNING_TABLES: readonly ["knowledge_snapshot", "learned_block", "learning_run", "learning_task", "learning_attempt"];
/** Options for openLearningDb. */
export interface OpenLearningDbOptions {
    /** Open read-only. Implies `migrate: false`. */
    readonly?: boolean;
    /** Override the file path (tests, and the hook's explicit path). */
    path?: string;
    /**
     * `openLearningDb` runs the schema statements when this value is true, which is the
     * default for a writable handle. A read-only handle always skips them, because
     * `CREATE TABLE` against a read-only handle raises SQLITE_READONLY.
     */
    migrate?: boolean;
}
/**
 * Create the learning tables if they do not exist.
 *
 * The function creates `knowledge_snapshot` and `learned_block`, and then the `learning_*` tables.
 * Running the function again has no effect.
 */
export declare function migrateLearningSchema(db: Database): void;
/**
 * Open the learning trace database.
 *
 * Same pragmas and directory modes as `src/db.ts`. With `readonly`, the handle
 * never migrates. The hook opens the file read-only, and the file may pre-date a
 * schema change. SQLite refuses DDL on a read-only connection.
 */
export declare function openLearningDb(options?: OpenLearningDbOptions): Database;
