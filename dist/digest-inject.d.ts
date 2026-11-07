import type Database from 'better-sqlite3';
/** The default digest character limit. `digestMaxChars` uses the default value when the environment value is not a positive integer. */
export declare const DEFAULT_DIGEST_MAX_CHARS = 6000;
/** The archive project key for a working directory: every non-alphanumeric character becomes a hyphen. */
export declare function projectKeyFromCwd(cwd: string): string;
/**
 * Returns the digest character limit from the `EPISODIC_MEMORY_DIGEST_MAX_CHARS` environment variable.
 *
 * Returns DEFAULT_DIGEST_MAX_CHARS when the variable is unset or is not a positive integer.
 */
export declare function digestMaxChars(): number;
/**
 * The digest for one project, within maxChars. Order: handoff notes first, then newest entries first.
 * The function stops before the first entry that does not fit.
 * So the oldest entries drop first, and the text ends on a whole entry. Returns an empty string when nothing fits.
 *
 * `opts.hideExchangeIds` drops every line citing one of those ids, and then
 * drops an entry whose lines are all gone. The learn solver passes a task's
 * source exchange ids here so the digest cannot hand back its answer.
 */
export declare function buildDigestText(db: Database.Database, project: string, maxChars: number, opts?: {
    hideExchangeIds?: string[];
}): string;
