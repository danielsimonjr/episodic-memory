import Database from 'better-sqlite3';
import { SearchResult, MultiConceptResult } from './types.js';
/** Default on. Set EPISODIC_MEMORY_INCLUDE_SUMMARY=0 to hide summaries. */
export declare function includeSearchSummaries(): boolean;
/**
 * Returns the longest summary, in characters, that the results display.
 *
 * The function reads `EPISODIC_MEMORY_MAX_SUMMARY_DISPLAY_CHARS`. The function returns 2000 when the variable is unset or does not start with a positive integer.
 */
export declare function maxSummaryDisplayChars(): number;
/**
 * Cuts a summary to the display limit from `maxSummaryDisplayChars`.
 *
 * A summary within the limit comes back unchanged. The function cuts a longer summary at the limit. An ellipsis character follows the cut text.
 */
export declare function formatSummaryForDisplay(summary: string): string;
/**
 * The options for `searchConversations`. Every field is optional.
 */
export interface SearchOptions {
    limit?: number;
    mode?: 'vector' | 'text' | 'both';
    after?: string;
    before?: string;
    project?: string;
    session_id?: string;
    git_branch?: string;
    /**
     * Exchange ids to leave out of the result set entirely.
     *
     * The learn solver passes a task's source exchange ids here so neither the
     * vector nor the text path can hand back the answer it is looking for
     * (spec §4.4 leak rule).
     */
    excludeIds?: string[];
    /**
     * Show per-file summaries on the results.
     *
     * Overrides `EPISODIC_MEMORY_INCLUDE_SUMMARY` when set: the solver's search
     * turns summaries off even on an install that has them on by default.
     */
    includeSummaries?: boolean;
    /**
     * Reuse an open DB handle (MCP hot path). When omitted, opens and closes
     * a one-shot connection (CLI behavior).
     */
    db?: Database.Database;
    /** When true with no `db`, use the process-wide shared reader. */
    useSharedReader?: boolean;
}
/**
 * Convert an L2 (Euclidean) distance between two unit-normalized vectors
 * into a cosine similarity in [-1, 1].
 *
 * For unit vectors u, v:  ||u - v||^2 = 2 - 2 * cos(u, v)
 * Therefore:               cos(u, v) = 1 - d^2 / 2
 *
 * `src/embeddings.ts` normalizes embeddings at write time, so
 * the L2 distance returned by sqlite-vec satisfies the unit-vector identity.
 */
export declare function l2DistanceToCosineSimilarity(distance: number): number;
/**
 * Prepare an FTS5 MATCH query from user input.
 * Quote the whole string so punctuation / AND/OR tokens in the user query
 * don't become FTS operators; fall back to LIKE if FTS is unavailable.
 */
export declare function buildFtsMatchQuery(query: string): string;
/**
 * Searches the indexed conversations for a query, and returns the matching exchanges.
 *
 * The `mode` option picks the search path. `vector` uses embeddings. `text` uses full-text search, with a `LIKE` search when full-text search fails. `both` merges the two result lists and removes duplicates.
 * Sidechain exchanges never match. The function throws when `after` or `before` is not in `YYYY-MM-DD` format.
 * The function closes a connection that the function opens. The function leaves a connection from `options.db` or the shared reader open.
 *
 * @param query The text to search for.
 * @param options The filters, the limit, and the connection settings. See `SearchOptions`.
 */
export declare function searchConversations(query: string, options?: SearchOptions): Promise<SearchResult[]>;
/**
 * Formats search results as plain text.
 *
 * Returns `No results found.` when the list is empty.
 * Each result shows its project, its date, its snippet, and the lines that the result covers in the archive file.
 * The match percentage and the tool usage appear only when they exist. The summary appears only when summaries are on.
 */
export declare function formatResults(results: Array<SearchResult & {
    summary?: string;
}>): Promise<string>;
/**
 * Finds the conversations that match every concept, using vector search.
 *
 * Each concept runs its own vector search with five times the limit. A conversation counts only when every concept finds the conversation.
 * The results sort by average similarity, highest first. The list holds at most `limit` entries.
 * Returns an empty list when `concepts` is empty.
 *
 * @param concepts The concepts to match. Every concept must match.
 * @param options The search options, without `mode`. `limit` sets the result count.
 */
export declare function searchMultipleConcepts(concepts: string[], options?: Omit<SearchOptions, 'mode'>): Promise<MultiConceptResult[]>;
/**
 * Formats multi-concept search results as plain text.
 *
 * Returns a message that names every concept when the list is empty.
 *
 * @param results The results from `searchMultipleConcepts`.
 * @param concepts The concepts that the search used, in the same order.
 */
export declare function formatMultiConceptResults(results: MultiConceptResult[], concepts: string[]): Promise<string>;
