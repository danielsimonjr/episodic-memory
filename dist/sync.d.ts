/**
 * True when the conversation should be excluded from indexing / summarization.
 * Only scans the first SKIP_MARKER_SCAN_BYTES — markers are emitted early in
 * agent prompts, so a head scan is sufficient and vastly cheaper on huge JSONL.
 */
export declare function shouldSkipConversation(filePath: string): boolean;
export interface SyncResult {
    copied: number;
    skipped: number;
    indexed: number;
    summarized: number;
    summaryAttempts: number;
    pendingSummaries: number;
    /**
     * Zero-byte -summary.txt files seen this run, and how many of those carry NO recorded reason.
     *
     * WHY THIS EXISTS. An empty summary is written on three legitimate paths (oversized skip,
     * zero-exchange conversation, give-up after N attempts) and the needs-summary gate is a bare
     * existsSync - so an empty file reads as DONE forever. Until 1.5.2 the give-up path also
     * DELETED its failure record, making a permanently-failed summary byte-identical to a
     * legitimately-empty one. Measured on one machine 2026-09-02: 2,919 zero-byte summaries of
     * 6,762 (43%) and ZERO failure markers. pendingSummaries counts only files with no summary at
     * all, so it read 0 and the 1.5.1 honest banner - shipped precisely to catch a silent
     * summariser - could never fire for this mode.
     *
     * unexplainedEmptySummaries is therefore the honest number: empty, and nothing says why.
     */
    emptySummaries: number;
    unexplainedEmptySummaries: number;
    errors: Array<{
        file: string;
        error: string;
    }>;
}
export interface SyncOptions {
    skipIndex?: boolean;
    skipSummaries?: boolean;
    summaryLimit?: number;
}
export declare function extractSessionIdFromPath(filePath: string): string | null;
export declare function syncConversations(sourceDir: string, destDir: string, options?: SyncOptions): Promise<SyncResult>;
