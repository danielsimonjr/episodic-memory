import Database from 'better-sqlite3';
import { SearchResult, MultiConceptResult } from './types.js';
/** Default on. Set EPISODIC_MEMORY_INCLUDE_SUMMARY=0 to hide summaries. */
export declare function includeSearchSummaries(): boolean;
export declare function maxSummaryDisplayChars(): number;
export declare function formatSummaryForDisplay(summary: string): string;
export interface SearchOptions {
    limit?: number;
    mode?: 'vector' | 'text' | 'both';
    after?: string;
    before?: string;
    project?: string;
    session_id?: string;
    git_branch?: string;
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
 * Embeddings written by src/embeddings.ts are normalized at write time, so
 * the L2 distance returned by sqlite-vec satisfies the unit-vector identity.
 */
export declare function l2DistanceToCosineSimilarity(distance: number): number;
/**
 * Prepare an FTS5 MATCH query from user input.
 * Quote the whole string so punctuation / AND/OR tokens in the user query
 * don't become FTS operators; fall back to LIKE if FTS is unavailable.
 */
export declare function buildFtsMatchQuery(query: string): string;
export declare function searchConversations(query: string, options?: SearchOptions): Promise<SearchResult[]>;
export declare function formatResults(results: Array<SearchResult & {
    summary?: string;
}>): Promise<string>;
export declare function searchMultipleConcepts(concepts: string[], options?: Omit<SearchOptions, 'mode'>): Promise<MultiConceptResult[]>;
export declare function formatMultiConceptResults(results: MultiConceptResult[], concepts: string[]): Promise<string>;
