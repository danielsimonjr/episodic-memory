// Dependency-free, so sync-cli can use it and a test can import it without the native stack.
/**
 * The first lines a finished sync prints.
 * A success line over a stalled queue reads as health from outside. So a run that summarised nothing
 * while a backlog waited says so. A run that waited for the shared GPU says that instead, because a
 * deliberate wait is not a fault.
 */
export function syncHeadline(totals) {
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
/**
 * The warn line that a sync writes to `sync-errors.log` when an Ollama outage deferred its summaries.
 * The line names the endpoint and the number of conversations that stay queued.
 * Returns null when the deferral was not an outage (`host` is null). The line does not change the exit code.
 *
 * @param host - The endpoint from `ollamaOutageHost`, or null.
 * @param pending - The number of conversations that still need a summary.
 */
export function outageWarningLine(host, pending) {
    if (!host)
        return null;
    return `sync deferred summaries: Ollama endpoint ${host} is unreachable; ${pending} conversation(s) stay queued`;
}
