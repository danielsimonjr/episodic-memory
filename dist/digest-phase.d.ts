import type Database from 'better-sqlite3';
import { type DigestOptions, type DigestResult } from './digest-job.js';
/**
 * The digest step of a sync run. Never throws and never blocks the sync: with the flag off it does nothing,
 * and any failure is logged and swallowed so the next run retries.
 */
export declare function runDigestPhase(opts?: DigestOptions & {
    db?: Database.Database;
}): Promise<DigestResult | null>;
