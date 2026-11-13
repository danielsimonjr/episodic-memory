import type { Database } from './sqlite.js';
/** The tier of a digest entry: `session`, `day` or `week`. */
export type DigestTier = 'session' | 'day' | 'week';
/**
 * One digest entry describes one project for one period.
 */
export interface DigestEntry {
    id: number;
    tier: DigestTier;
    project: string;
    periodStart: string;
    periodEnd: string;
    text: string;
    /** The exchange ids that the text cites. A handoff note has none. */
    sources: string[];
    /** The model that wrote the text, or `handoff` for a handoff note. */
    model: string;
    createdAt: string;
    /** The id of the entry that replaces this entry, or null while this entry is active. */
    supersededBy: number | null;
    /** True for a one-line note that a session stores for the next session. */
    handoff: boolean;
}
type NewDigestEntry = Omit<DigestEntry, 'id' | 'createdAt' | 'supersededBy'>;
/**
 * Create the digest tables and the full-text index when they do not exist.
 *
 * Running the function again has no effect. The module never deletes an entry.
 * The supersede function marks a replaced entry instead.
 */
export declare function ensureDigestSchema(db: Database): void;
/**
 * Insert one digest entry and its full-text row in one transaction.
 *
 * The function sets created_at to the current time and returns the new id.
 * The function returns null, and writes nothing, when an entry with the same tier, project and periodStart already exists.
 */
export declare function insertDigestEntry(db: Database, e: NewDigestEntry): number | null;
/**
 * List the active entries of one project, newest period first.
 *
 * An entry is active while no other entry supersedes it. The list includes handoff notes.
 */
export declare function listActiveEntries(db: Database, project: string): DigestEntry[];
/**
 * List the active entries of one tier for all projects. The compression step reads this list.
 *
 * The list excludes handoff notes and sorts by project, then by period start, oldest first.
 */
export declare function listActiveByTier(db: Database, tier: DigestTier): DigestEntry[];
/**
 * Mark entries as replaced by another entry. The rows stay in the table.
 *
 * The function sets superseded_by only on entries that have no replacement yet.
 * An entry that already has a replacement keeps its first one.
 *
 * @param ids the entries to mark
 * @param byId the id of the replacing entry
 */
export declare function supersede(db: Database, ids: number[], byId: number): void;
/**
 * List the exchange ids that the mark groups of a digest line cite.
 *
 * A mark group has the form `[#a,#b]`. A line can hold one mark group for each statement, so the
 * function reads every bracket group of the line, not only the last group. The function ignores each
 * part that does not start with `#`. The function returns an empty list when the line has no mark group.
 *
 * @param line the digest line to check
 */
export declare function citedExchangeIds(line: string): string[];
/**
 * Remove every line that cites a hidden exchange, and keep the other lines unchanged.
 *
 * The learn solver must not see a digest line that names a source exchange of its task.
 * The function removes whole lines only. A line with its marks removed would state a claim
 * that no exchange supports.
 *
 * @param text the digest text, one line for each statement
 * @param hideExchangeIds the exchange ids to hide. The function returns `text` unchanged when this list is empty or missing.
 */
export declare function hideCitedLines(text: string, hideExchangeIds?: string[]): string;
/**
 * Search the active digest entries for a query.
 *
 * The function keeps only letters, digits and underscores from the query, and matches every remaining word.
 * A query with no such characters returns an empty list. When the caller omits `project`, the search covers all projects.
 * The SQL query returns at most `limit` entries, ordered by full-text rank.
 *
 * @param db the open index database
 * @param query the words to search for
 * @param project the project key to search. The search covers all projects when the caller omits `project`.
 * @param limit the maximum number of entries to fetch. Hidden lines can make the result shorter.
 * @param opts `hideExchangeIds` lists exchange ids. The function removes the lines that cite them and drops each entry with no line left.
 */
export declare function searchDigest(db: Database, query: string, project?: string, limit?: number, opts?: {
    hideExchangeIds?: string[];
}): DigestEntry[];
export {};
