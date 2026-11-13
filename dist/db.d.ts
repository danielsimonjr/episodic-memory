import { Database } from './sqlite.js';
import { ConversationExchange } from './types.js';
/**
 * The options for `openDatabase`.
 */
export interface OpenDatabaseOptions {
    /**
     * Run CREATE TABLE / migrations / CREATE INDEX.
     * Default true. Pass false for hot-path readers that know the schema is current
     * (e.g. a long-lived MCP search connection after the first migrated open).
     */
    migrate?: boolean;
}
/**
 * Adds the `exchanges` columns that the database lacks, then runs the other schema migrations.
 *
 * The column step reports each added column on stderr. The function then runs `migrateToolCallsCascade`, `ensureFts`, and `ensureDigestSchema`.
 */
export declare function migrateSchema(db: Database): void;
/**
 * Earlier versions created `tool_calls` with a plain `FOREIGN KEY (exchange_id) REFERENCES exchanges(id)`.
 * Without ON DELETE CASCADE, deleting an exchange that had tool calls
 * raised SQLITE_CONSTRAINT_FOREIGNKEY (#81), and orphans accumulated.
 *
 * The migration does these steps:
 *   1. Detects the legacy schema by inspecting sqlite_master.sql.
 *   2. Drops orphaned tool_calls rows.
 *   3. Recreates the table with ON DELETE CASCADE and copies surviving rows.
 */
export declare function migrateToolCallsCascade(db: Database): void;
/**
 * Create (and backfill if empty) the FTS5 index used by text-mode search.
 * External-content style: we keep id + message copies and update them from
 * insertExchange / deleteExchange / prune.
 */
export declare function ensureFts(db: Database): void;
/**
 * Replaces the full-text row for one exchange.
 *
 * The function deletes any row with the same id, and then inserts the new row.
 */
export declare function upsertExchangeFts(db: Database, id: string, userMessage: string, assistantMessage: string): void;
/**
 * Removes the full-text row for one exchange.
 *
 * The call does nothing when no row has that id.
 */
export declare function deleteExchangeFts(db: Database, id: string): void;
/**
 * Registers the `vec_distance_l2(a, b)` SQL function on one connection.
 *
 * Exact vector search calls this function. Register it on every connection that searches vectors.
 */
export declare function registerVectorFunctions(db: Database): void;
/**
 * Creates the `exchange_vectors` table when the table is missing.
 *
 * The table holds one vector for each exchange. The database deletes a vector with its exchange.
 */
export declare function ensureVectorTable(db: Database): void;
/**
 * Copies the vectors of an earlier vec0 table into `exchange_vectors`, and returns the number of copied vectors.
 *
 * The copy runs when all three shadow tables of `vec_exchanges` exist. When only some of them exist, the function
 * writes one line to stderr and copies nothing. A read checks first. A database with nothing to copy takes no write lock.
 * The copy runs in one `BEGIN IMMEDIATE` transaction.
 * It copies a slot only when its validity bit is set and its exchange has no vector.
 * An exchange that gets no vector gets `embedding_version` 0, so the embedding migration embeds it again.
 *
 * @param db The open write connection. The `exchanges` table must hold `embedding_version`.
 */
export declare function migrateVec0Vectors(db: Database): number;
/**
 * Opens the index database and prepares the connection.
 *
 * The function creates the database directory when the directory is missing.
 * The function restricts the file mode of the database and its WAL files.
 * The function registers the `vec_distance_l2` SQL function and turns on WAL mode.
 * The busy timeout comes from `EPISODIC_MEMORY_DB_BUSY_TIMEOUT_MS`. The default timeout is 5000 milliseconds.
 * When `migrate` is true, the function also creates the tables and indexes, runs `migrateSchema`, and copies the vectors of an earlier vec0 table. When `migrate` is false, the function returns before the function changes the schema.
 *
 * @param options Set `migrate` to false to skip the schema changes. The default is true.
 */
export declare function openDatabase(options?: OpenDatabaseOptions): Database;
/**
 * Opens the existing index database for reading only.
 *
 * The function creates no file and no directory. It does not change the file mode, turn on WAL mode
 * or run a migration. It throws when the database file does not exist. The busy timeout is the same as in `openDatabase`.
 */
export declare function openDatabaseReadonly(): Database;
/** Open (and migrate) a database — the default writer / one-shot path. */
export declare function initDatabase(): Database;
/**
 * Returns the process-wide reader connection, and opens the connection on the first call.
 *
 * The first call opens the database with migrations. Later calls reuse the same connection.
 * A later call opens a new connection when the old connection fails a simple query, for example after a close.
 */
export declare function getSharedReaderDatabase(): Database;
/**
 * Closes the process-wide reader connection, if one is open.
 *
 * The function ignores errors from the close. A later call to `getSharedReaderDatabase` opens a new connection.
 */
export declare function closeSharedReaderDatabase(): void;
/**
 * Writes one exchange to the index, with its embedding, its full-text row, and its tool calls.
 *
 * The messages pass through `maybeRedactSecrets` and `truncateForIndex` before storage.
 * The stored row replaces any earlier row with the same id. The stored row also records the write time and `EMBEDDING_VERSION`.
 * The replace deletes the earlier tool-call rows of the exchange, so the call writes the tool calls of `exchange` again.
 *
 * @param db The open database connection.
 * @param exchange The exchange to store.
 * @param embedding The embedding vector. The vector must hold 384 numbers, the width of `exchange_vectors`.
 * The function throws a `RangeError` before it writes when the width is wrong. All writes run in one transaction.
 * @param toolNames Not read by this function.
 */
export declare function insertExchange(db: Database, exchange: ConversationExchange, embedding: number[], toolNames?: string[]): void;
/**
 * Returns the id and the archive path of every indexed exchange.
 */
export declare function getAllExchanges(db: Database): Array<{
    id: string;
    archivePath: string;
}>;
/**
 * Returns the newest `last_indexed` time for the rows of one archive file, or null when no row matches.
 *
 * The path must match the `archive_path` column exactly. The time is in milliseconds since the Unix epoch.
 */
export declare function getFileLastIndexed(db: Database, archivePath: string): number | null;
/** High-water mark for append-only incremental indexing of a transcript. */
export declare function getMaxIndexedLine(db: Database, archivePath: string): number;
/**
 * Returns the number of free pages and the page size of the database.
 *
 * A `VACUUM` run can reclaim the free pages.
 */
export declare function getFreelistInfo(db: Database): {
    freePages: number;
    pageSize: number;
};
/**
 * Runs `VACUUM` on the database, which rebuilds the file and reclaims its free pages.
 */
export declare function vacuumDatabase(db: Database): void;
/**
 * Deletes one exchange from the vector table, the full-text table, and the exchanges table.
 *
 * The database deletes the exchange's tool-call rows through `ON DELETE CASCADE`. Foreign-key enforcement must be on for the connection.
 */
export declare function deleteExchange(db: Database, id: string): void;
/**
 * Deletes every exchange of one archive file, in one transaction. Returns the ids of the deleted exchanges.
 *
 * The path must match the `archive_path` column exactly. Each exchange goes through `deleteExchange`, so the vector,
 * full-text and tool-call rows go too.
 *
 * @param db The open database connection to change.
 * @param archivePath The archive path of the conversation, as stored in the `archive_path` column.
 */
export declare function deleteExchangesForArchive(db: Database, archivePath: string): string[];
