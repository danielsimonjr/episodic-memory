import type Database from 'better-sqlite3';
/**
 * Options for `compressDigest`. Each field is optional and replaces its default.
 */
export interface CompressOptions {
    /** Sends a prompt to the text model and returns the reply. Defaults to `callDigestModel`. */
    model?: (prompt: string) => Promise<string>;
    /** The time that the run treats as the present. Defaults to the current time. */
    now?: Date;
    /** Compress a past UTC day when the day holds more than this many session entries. */
    dayCap?: number;
    /** Compress a finished UTC ISO week when the week holds more than this many day entries. */
    weekCap?: number;
}
/**
 * The counts from one `compressDigest` run.
 *
 * `created` counts the merged entries that the run stored. `failed` counts the model calls that threw an error, except a deferral (a GPU reservation or an unusable Claude Code executable).
 */
export interface CompressResult {
    created: number;
    failed: number;
    /** Set when the run stopped for a deferral (`src/deferral.ts` lists the causes). Not a failure. */
    deferred?: string;
}
/**
 * Merge many session entries of a past day into one day entry.
 * Merge many day entries of a finished week into one week entry.
 * The compression step marks the originals as superseded and never deletes them.
 */
export declare function compressDigest(db: Database.Database, opts?: CompressOptions): Promise<CompressResult>;
