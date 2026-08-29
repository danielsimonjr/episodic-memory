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
