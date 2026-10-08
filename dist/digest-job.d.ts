import type Database from 'better-sqlite3';
export interface DigestOptions {
    /** Model call. Defaults to the configured summarizer backend; tests pass a fake. */
    model?: (prompt: string) => Promise<string>;
    now?: Date;
}
export interface DigestResult {
    written: number;
    skipped: number;
    failed: number;
    /** Day and week entries created by compression (present only when the job ran). */
    compressed?: number;
}
export declare function digestEnabled(): boolean;
/** Write session digest entries, then compress old days and weeks. Does nothing unless EPISODIC_MEMORY_DIGEST=1 and the summarizer guard is unset. */
export declare function runDigest(db: Database.Database, opts?: DigestOptions): Promise<DigestResult>;
