import type { ConversationExchange } from './types.js';
import { shouldSkipConversation } from './exclusion-marker.js';
export { shouldSkipConversation };
/**
 * The counts and errors of one `syncConversations` run.
 *
 * `copied` counts the copied files, and `skipped` counts the files that the run leaves unchanged. `indexed` counts the conversations that the index step handles, and `summarized` counts the summaries that the run writes. `errors` lists each failed file with its error text.
 */
export interface SyncResult {
    copied: number;
    skipped: number;
    indexed: number;
    summarized: number;
    summaryAttempts: number;
    pendingSummaries: number;
    /** Set when this run deferred the summaries (`src/deferral.ts` lists the causes). */
    summariesDeferred?: string;
    /**
     * Zero-byte -summary.txt files seen this run, and how many of those carry NO recorded reason.
     *
     * WHY THIS EXISTS. An empty summary is written on three legitimate paths (oversized skip,
     * zero-exchange conversation, give-up after N attempts) and the needs-summary gate is a bare
     * existsSync - so an empty file reads as DONE forever. A give-up path that deleted its
     * failure record would make a permanently-failed summary byte-identical to a
     * legitimately-empty one. pendingSummaries counts only files with no summary at
     * all, so it reads 0 for this mode and the banner that catches a silent summariser
     * cannot fire.
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
/**
 * The options of `syncConversations`.
 *
 * `skipIndex` leaves the copied files out of the index. `skipSummaries` writes no summary. `summaryLimit` caps the summaries that one run writes, and its default is 10.
 */
export interface SyncOptions {
    skipIndex?: boolean;
    skipSummaries?: boolean;
    summaryLimit?: number;
}
/**
 * Read the sync options that the environment sets.
 *
 * `EPISODIC_MEMORY_SKIP_SUMMARIES=1` sets `skipSummaries`. Only the exact value 1 sets the option.
 * An unset variable, `0`, `true` and every other value leave the summaries on.
 * A stray value therefore never turns off a step that the user expects.
 * A summary only decorates a search result. The index never embeds or searches a summary, so the option does not
 * change what a search finds. Each summary is a model call. Ported from upstream c8d0e3f.
 *
 * @param env the environment to read, usually `process.env`
 */
export declare function buildSyncOptionsFromEnv(env: NodeJS.ProcessEnv): SyncOptions;
/**
 * A failure record is TERMINAL when it explains an empty summary for good.
 * The record holds a recorded reason (for example no-exchanges), a give-up, or an oversize skip.
 * A bare {attempts, lastError} is a retry in progress.
 * Unreadable records count as terminal, so corruption never causes a retry storm.
 */
export declare function isTerminalFailRecord(filePath: string): boolean;
/**
 * Attempts of the rename that replaces an archive copy. The waits are 20 ms to 1.28 s, 2.54 s in total.
 *
 * On Windows an open handle on the archive copy stops the rename. A reader such as the `read` tool or a search
 * can hold the copy for longer than the 300 ms of the default attempts.
 */
export declare const ARCHIVE_RENAME_ATTEMPTS = 8;
/**
 * Return the session id from a transcript file name, or `null` when the name has none.
 *
 * The session id is the last UUID in the file name, without the `.jsonl` extension. The match ignores case.
 */
export declare function extractSessionIdFromPath(filePath: string): string | null;
/**
 * Copy the changed transcripts from `sourceDir` to `destDir`, then index them and write their summaries.
 *
 * Use `skipIndex` and `skipSummaries` to turn off the two later steps. The function skips the excluded projects. The function records an error for each file that fails and continues with the next file.
 *
 * When the Ollama summarizer is in use and another agent holds the shared GPU, the function writes no summary. When no usable Claude Code executable exists or the Claude Code login fails, the summaries stop at the first call. In both cases the reason is reported in `summariesDeferred`, and no attempt is counted. The function returns an empty result when `sourceDir` does not exist.
 */
export declare function syncConversations(sourceDir: string, destDir: string, options?: SyncOptions): Promise<SyncResult>;
/**
 * Summarize ONE archived conversation and record the outcome on disk.
 * The outcome is one of: a summary, a no-exchanges sentinel, an oversized skip,
 * a retry record, or a give-up.
 * Sync and the archive backfill both call this function, so they leave identical evidence.
 * Never throws; failures are recorded in result.errors.
 *
 * Returns the reservation message when another agent holds the shared GPU. The hold is a wait,
 * not a failure.
 * Nothing is recorded on disk, the attempt is not counted, and the caller should stop asking for
 * summaries.
 * Returns `undefined` in every other case.
 */
export declare function summarizeOneFile(filePath: string, sessionId: string, result: Pick<SyncResult, 'errors' | 'summaryAttempts' | 'summarized'>, summarize: (exchanges: ConversationExchange[], sessionId: string) => Promise<string>): Promise<string | undefined>;
