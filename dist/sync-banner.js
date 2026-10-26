// Dependency-free, so sync-cli can use it and a test can import it without the native stack.
/**
 * The first lines a finished sync prints. A success line over a stalled queue reads as health from
 * outside, so a run that summarised nothing while a backlog waited says so. A run that waited for the
 * shared GPU says that instead, because a deliberate wait is not a fault.
 */
export function syncHeadline(totals) {
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
