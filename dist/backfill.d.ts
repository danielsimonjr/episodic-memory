/**
 * Archive backfill: summarize conversations that sync can never reach.
 *
 * WHY THIS EXISTS. Sync walks the SOURCE projects directory, so it only ever queues conversations
 * whose source .jsonl still exists. Once Claude Code prunes a transcript, its archived copy is never
 * revisited. Measured 2026-09-17: the ZBOOK archive held 8,987 conversations, 2,154 with NO summary
 * file and 2,921 with an unexplained empty one; the EVO 5,575, 3,157 and 1,199. Sync reported 27.
 *
 * Candidates are exactly what sync would retry if it could see them: no summary file, or an empty
 * summary with no marker or a non-terminal (retrying) marker. Explained empties are final.
 * Each candidate goes through summarizeOneFile, so the evidence it leaves is identical to sync's.
 * Use a local backend (EPISODIC_MEMORY_SUMMARIZER_BACKEND=ollama) for bulk runs.
 */
export interface BackfillCandidate {
    path: string;
    sessionId: string;
}
export interface BackfillOptions {
    limit?: number;
    dryRun?: boolean;
}
export interface BackfillResult {
    candidates: number;
    processed: number;
    summarized: number;
    summaryAttempts: number;
    errors: Array<{
        file: string;
        error: string;
    }>;
}
export declare function selectBackfillCandidates(archiveDir: string, opts?: {
    excludedProjects?: string[];
}): BackfillCandidate[];
export declare function backfillArchive(archiveDir: string, opts: BackfillOptions): Promise<BackfillResult>;
