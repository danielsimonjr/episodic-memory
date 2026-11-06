/**
 * Archive backfill: summarize conversations that sync can never reach.
 *
 * Purpose: sync walks the SOURCE projects directory, so sync only queues conversations
 * whose source .jsonl still exists. Once Claude Code prunes a transcript, sync never revisits its archived copy.
 *
 * Candidates are exactly what sync would retry if sync could see them.
 * A candidate has no summary file. A candidate also has an empty summary with no marker, or with a non-terminal (retrying) marker.
 * Explained empties are final.
 * Each candidate goes through summarizeOneFile. The evidence that summarizeOneFile leaves is identical to the evidence that sync leaves.
 * Use a local backend (EPISODIC_MEMORY_SUMMARIZER_BACKEND=ollama) for bulk runs.
 */
/**
 * One archived conversation that the backfill still has to summarize.
 */
export interface BackfillCandidate {
    path: string;
    sessionId: string;
}
/**
 * Options for `backfillArchive`.
 *
 * `limit` caps the number of candidates that one run handles. `dryRun` counts the candidates and summarizes nothing.
 */
export interface BackfillOptions {
    limit?: number;
    dryRun?: boolean;
}
/**
 * The counts from one `backfillArchive` run.
 */
export interface BackfillResult {
    candidates: number;
    processed: number;
    summarized: number;
    summaryAttempts: number;
    errors: Array<{
        file: string;
        error: string;
    }>;
    /** Set when the run stopped because another agent holds the shared GPU. Not a failure. */
    deferred?: string;
}
/**
 * Lists the archived conversations that still need a summary.
 *
 * The function skips excluded projects and any conversation that `shouldSkipConversation` rejects.
 * The function returns an empty list when the function cannot read the archive directory.
 * A missing summary file makes a conversation a candidate. An empty summary also makes a conversation a candidate, unless a terminal failure record explains the empty summary.
 *
 * @param archiveDir The archive directory, with one subdirectory per project.
 * @param opts Set `excludedProjects` to replace the configured exclude list.
 */
export declare function selectBackfillCandidates(archiveDir: string, opts?: {
    excludedProjects?: string[];
}): BackfillCandidate[];
/**
 * Summarizes the archived conversations that sync cannot reach, and returns the counts.
 *
 * Each candidate goes through `summarizeOneFile`. The evidence matches the evidence from a sync.
 * With `dryRun`, the function counts the candidates and summarizes nothing.
 * With the Ollama backend, the function stops at once when another agent holds the shared GPU. The result then sets `deferred`.
 * A reservation that appears during the run also stops the loop and sets `deferred`.
 *
 * @param archiveDir The archive directory, with one subdirectory per project.
 * @param opts The limit and dry-run settings. See `BackfillOptions`.
 */
export declare function backfillArchive(archiveDir: string, opts: BackfillOptions): Promise<BackfillResult>;
/**
 * Decide what the batch loop does next. `prevRemaining` is the remainder that the previous batch left
 * (candidates - processed); undefined on the first batch. Each batch starts at the previous remainder.
 * The function measures progress on the remainder that this batch leaves, not on where the batch starts.
 */
export declare function batchVerdict(prevRemaining: number | undefined, r: Pick<BackfillResult, 'candidates' | 'processed' | 'summarized' | 'summaryAttempts' | 'deferred'>): 'continue' | 'done' | 'backend-down' | 'no-progress' | 'deferred';
