// Dependency-free, so sync-cli can use it and a test can import it without the native stack.

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
export function syncHeadline(totals: SyncHeadlineTotals): string[] {
  if ((totals.errorCount ?? 0) > 0) {
    return [`\n⚠️  Sync finished; ${totals.errorCount} file(s) not indexed. The error lines are on stderr.`];
  }
  const stalled = totals.pendingSummaries > 0 && totals.summarized === 0;
  if (stalled && totals.summariesDeferred) {
    return [
      `\n⏸  Sync finished; summaries deferred (${totals.summariesDeferred}). ${totals.pendingSummaries} conversation(s) stay queued.`,
    ];
  }
  if (stalled) {
    return [
      `\n⚠️  Sync finished WITHOUT SUMMARISING ANYTHING - ${totals.pendingSummaries} conversation(s) still need summaries.`,
      `  This is NOT a healthy run; copy and index results below are still valid.`,
    ];
  }
  return [`\n✅ Sync complete!`];
}
