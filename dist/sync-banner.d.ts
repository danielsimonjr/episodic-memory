/**
 * The counts that `syncHeadline` reads from one finished sync run.
 */
export interface SyncHeadlineTotals {
    pendingSummaries: number;
    summarized: number;
    /** The reservation message when another agent held the shared GPU. Empty when it did not. */
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
