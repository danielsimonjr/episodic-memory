import type Database from 'better-sqlite3';
export interface CompressOptions {
    model?: (prompt: string) => Promise<string>;
    now?: Date;
    /** Compress a past UTC day when it holds more than this many session entries. */
    dayCap?: number;
    /** Compress a finished UTC ISO week when it holds more than this many day entries. */
    weekCap?: number;
}
export interface CompressResult {
    created: number;
    failed: number;
}
/**
 * Merge many session entries of a past day into one day entry, and many day entries of a finished
 * week into one week entry. Originals are marked superseded, never deleted.
 */
export declare function compressDigest(db: Database.Database, opts?: CompressOptions): Promise<CompressResult>;
