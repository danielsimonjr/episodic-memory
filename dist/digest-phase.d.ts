import type Database from 'better-sqlite3';
import { type DigestOptions, type DigestResult } from './digest-job.js';
/**
 * The digest step of a sync run.
 *
 * Never throws, so a failure cannot stop the sync. With the flag off, the digest step does nothing.
 * The digest step logs and swallows any failure, so the next run retries.
 */
export declare function runDigestPhase(opts?: DigestOptions & {
    db?: Database.Database;
}): Promise<DigestResult | null>;
