/**
 * The counts that `syncHeadline` reads from one finished sync run.
 */
export interface SyncHeadlineTotals {
    pendingSummaries: number;
    summarized: number;
    /** The deferral detail when the run deferred its summaries (`src/deferral.ts` lists the causes). Empty when it did not. */
    summariesDeferred: string;
    /** The number of files whose index write failed. A run with such a failure does not print the success line. */
    errorCount?: number;
}
/**
 * The first lines a finished sync prints.
 * A success line over a stalled queue reads as health from outside. So a run that summarised nothing
 * while a backlog waited says so. A run that waited for the shared GPU says that instead, because a
 * deliberate wait is not a fault.
 */
export declare function syncHeadline(totals: SyncHeadlineTotals): string[];
/**
 * The warn line that a sync writes to `sync-errors.log` when an Ollama outage deferred its summaries.
 * The line names the endpoint and the number of conversations that stay queued.
 * Returns null when the deferral was not an outage (`host` is null). The line does not change the exit code.
 *
 * @param host - The endpoint from `ollamaOutageHost`, or null.
 * @param pending - The number of conversations that still need a summary.
 */
export declare function outageWarningLine(host: string | null, pending: number): string | null;
