import Database from 'better-sqlite3';
import { ConversationExchange } from './types.js';
export interface OpenDatabaseOptions {
    /**
     * Run CREATE TABLE / migrations / CREATE INDEX.
     * Default true. Pass false for hot-path readers that know the schema is current
     * (e.g. a long-lived MCP search connection after the first migrated open).
     */
    migrate?: boolean;
}
export declare function migrateSchema(db: Database.Database): void;
/**
 * Earlier versions created `tool_calls` with a plain
 * `FOREIGN KEY (exchange_id) REFERENCES exchanges(id)`.
 * Without ON DELETE CASCADE, deleting an exchange that had tool calls
 * raised SQLITE_CONSTRAINT_FOREIGNKEY (#81), and orphans accumulated.
 *
 * This migration:
 *   1. Detects the legacy schema by inspecting sqlite_master.sql.
 *   2. Drops orphaned tool_calls rows.
 *   3. Recreates the table with ON DELETE CASCADE and copies surviving rows.
 */
export declare function migrateToolCallsCascade(db: Database.Database): void;
/**
 * Create (and backfill if empty) the FTS5 index used by text-mode search.
 * External-content style: we keep id + message copies and update them from
 * insertExchange / deleteExchange / prune.
 */
export declare function ensureFts(db: Database.Database): void;
export declare function upsertExchangeFts(db: Database.Database, id: string, userMessage: string, assistantMessage: string): void;
export declare function deleteExchangeFts(db: Database.Database, id: string): void;
export declare function openDatabase(options?: OpenDatabaseOptions): Database.Database;
/** Open (and migrate) a database — the default writer / one-shot path. */
export declare function initDatabase(): Database.Database;
export declare function getSharedReaderDatabase(): Database.Database;
export declare function closeSharedReaderDatabase(): void;
export declare function insertExchange(db: Database.Database, exchange: ConversationExchange, embedding: number[], toolNames?: string[]): void;
export declare function getAllExchanges(db: Database.Database): Array<{
    id: string;
    archivePath: string;
}>;
export declare function getFileLastIndexed(db: Database.Database, archivePath: string): number | null;
/** High-water mark for append-only incremental indexing of a transcript. */
export declare function getMaxIndexedLine(db: Database.Database, archivePath: string): number;
export declare function deleteExchange(db: Database.Database, id: string): void;
