/**
 * Embedding migration.
 *
 * Each exchange row records the EMBEDDING_VERSION that embedded its vector, in
 * embedding_version. Rows with an older version are stale. This module provides
 * the parts of a lock-protected, resumable migration. The sync step runs the
 * migration in batches and re-embeds the stale rows.
 *
 *   EMBEDDING_VERSION    — increase when the embedding pipeline changes
 *   acquire/release lock — file-based lock with PID and age checks
 *   pickStaleBatch       — find rows whose embedding_version is behind
 *   recordReembedded     — replace one vector and stamp its version
 */
import { Database } from './sqlite.js';
import { LockHandle } from './lockfile.js';
/**
 * The version of the embedding pipeline. New rows carry this value. Rows with a lower value are stale.
 * Increase the value when the pipeline changes, for example the model, the dtype or the prefix.
 */
export declare const EMBEDDING_VERSION = 1;
/**
 * The handle of a held migration lock. The type is the generic lock handle from lockfile.js.
 */
export type MigrationLockHandle = LockHandle;
/**
 * Try to take the migration lock at `lockPath`.
 *
 * The function returns a handle, or null when a live process holds a fresh lock. The function does not wait.
 * The function creates the lock folder when the folder is missing.
 * The function takes over a stale lock. A lock is stale when its file is older than one hour.
 * A lock is also stale when the file does not name a live process.
 *
 * @param lockPath the lock file path. Use getMigrationLockPath to build it.
 */
export declare function acquireMigrationLock(lockPath: string): MigrationLockHandle | null;
/**
 * Release a lock that acquireMigrationLock returned.
 *
 * The function closes the lock file and removes it only while the file still records this process's PID.
 * A lock that another process took over stays in place. The function does not throw.
 *
 * @param handle the handle that acquireMigrationLock returned
 */
export declare function releaseMigrationLock(handle: MigrationLockHandle): void;
/**
 * One exchange row whose embedding is older than EMBEDDING_VERSION.
 *
 * `tools` lists the distinct tool names of the exchange, separated by commas. The value is null when the exchange has no tool calls.
 */
export interface StaleRow {
    id: string;
    user_message: string;
    assistant_message: string;
    tools: string | null;
}
/**
 * The function returns up to `limit` rows whose embedding_version is older than EMBEDDING_VERSION.
 * The function also returns a row that has no stored vector, whatever its version.
 *
 * Each row carries its tool names, so the caller can reproduce the production exchange-text format.
 */
export declare function pickStaleBatch(db: Database, limit: number): StaleRow[];
/**
 * Replace the vector of one exchange and stamp the current EMBEDDING_VERSION on the row.
 *
 * The function runs two statements in order. The statements replace the vector and update embedding_version.
 * The function does not start a transaction. The caller must wrap the call in a transaction to make the change atomic.
 *
 * @param db the open index database
 * @param id the exchange id
 * @param embedding the new vector. The function stores it as 32-bit floats.
 */
export declare function recordReembedded(db: Database, id: string, embedding: number[]): void;
/**
 * Count rows whose embedding is older than the current version, or missing.
 * Used to decide whether migration is needed and to report progress.
 */
export declare function countStale(db: Database): number;
/** Path of the migration lock under the index directory. */
export declare function getMigrationLockPath(indexDir: string): string;
/**
 * Re-embed one batch of stale rows while the function holds the migration lock.
 *
 * The function re-embeds up to `batchSize` rows whose embedding_version is behind.
 * The function first calls the batched embedding function. If that call throws, the function embeds each row with `embedFn`.
 * The function writes the new vectors in one transaction and writes progress messages to stderr.
 * When another live process holds the lock, the function writes a message to stderr and does not wait.
 * The function releases the lock before the function returns, even when an error occurs.
 *
 * The function returns the number of rows that the batch re-embedded. The function returns 0 when no row is stale,
 * and returns 0 when another live process holds the lock.
 *
 * @param db the open index database
 * @param indexDir the index folder that holds the lock file
 * @param batchSize the maximum number of rows to re-embed in this batch
 * @param embedFn computes one vector from the user text, the assistant text and the tool names. The function calls it only when the batched call fails.
 */
export declare function runMigrationBatch(db: Database, indexDir: string, batchSize: number, embedFn: (user: string, assistant: string, toolNames?: string[]) => Promise<number[]>): Promise<number>;
