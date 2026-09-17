import type { ConversationExchange } from './types.js';
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
/**
 * A failure record is TERMINAL when it explains an empty summary for good: a recorded reason
 * (e.g. no-exchanges), a give-up, or an oversize skip. A bare {attempts, lastError} is a retry in
 * progress. Unreadable records count as terminal, so corruption never causes a retry storm.
 */
export declare function isTerminalFailRecord(filePath: string): boolean;
export declare function extractSessionIdFromPath(filePath: string): string | null;
export declare function syncConversations(sourceDir: string, destDir: string, options?: SyncOptions): Promise<SyncResult>;
/**
 * Summarize ONE archived conversation and record the outcome on disk: a summary, a no-exchanges
 * sentinel, an oversized skip, a retry record, or a give-up. Shared by sync and the archive backfill
 * so both leave identical evidence. Never throws; failures are recorded in result.errors.
 */
export declare function summarizeOneFile(filePath: string, sessionId: string, result: Pick<SyncResult, 'errors' | 'summaryAttempts' | 'summarized'>, summarize: (exchanges: ConversationExchange[], sessionId: string) => Promise<string>): Promise<void>;
