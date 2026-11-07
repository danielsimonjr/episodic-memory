/**
 * The counts and sizes that describe the conversation index.
 *
 * An optional field is absent when the index has no data for it.
 */
export interface IndexStats {
    /** Distinct archive files that hold indexed exchanges. */
    totalConversations: number;
    /** Conversations whose `-summary.txt` file exists beside the archived `.jsonl` file. */
    conversationsWithSummaries: number;
    conversationsWithoutSummaries: number;
    totalExchanges: number;
    /** Timestamps of the earliest and latest indexed exchanges. */
    dateRange?: {
        earliest: string;
        latest: string;
    };
    projectCount: number;
    /** Up to 10 projects, highest conversation count first. */
    topProjects?: Array<{
        project: string;
        count: number;
    }>;
    /** The index file size in kilobytes, such as `1234.5 KB`. */
    databaseSize?: string;
}
/**
 * Read the counts and sizes of the conversation index.
 *
 * The function opens the database read-only and closes it before the function returns.
 * The function returns zero counts when the file does not exist or has no exchanges table.
 * The function counts a conversation as summarized when its `-summary.txt` file exists.
 * The function throws when SQLite cannot open or query the file.
 *
 * @param dbPath the index file to read. When the caller gives no value or an empty value, the function uses getDbPath.
 */
export declare function getIndexStats(dbPath?: string): Promise<IndexStats>;
/**
 * Format the index statistics as a plain-text report for a terminal.
 *
 * The report always shows the conversation and exchange counts.
 * The function adds the share of conversations without summaries when that share is above zero.
 * The function adds the date range when `stats` has one. The function also adds the top projects when `stats` has at least one project.
 * Dates use the locale of the host.
 *
 * @param stats the statistics to format, as getIndexStats returns them
 */
export declare function formatStats(stats: IndexStats): string;
