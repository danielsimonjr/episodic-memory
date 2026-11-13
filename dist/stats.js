import Database from 'better-sqlite3';
import { getDbPath } from './paths.js';
/**
 * Return true when the summary file exists and holds one byte or more.
 *
 * @param fs the `fs` module that the caller loaded
 * @param summaryPath the `-summary.txt` path of one conversation
 */
function hasSummaryText(fs, summaryPath) {
    try {
        return fs.statSync(summaryPath).size > 0;
    }
    catch {
        return false;
    }
}
/**
 * Read the counts and sizes of the conversation index.
 *
 * The function opens the database read-only and closes it before the function returns.
 * The function returns zero counts when the file does not exist or has no exchanges table.
 * The function counts a conversation as summarized when its `-summary.txt` file holds one byte or more.
 * An empty file is a sentinel of the sync. An empty file is not a summary.
 * The function throws when SQLite cannot open or query the file.
 *
 * @param dbPath the index file to read. When the caller gives no value or an empty value, the function uses getDbPath.
 */
export async function getIndexStats(dbPath) {
    const resolvedDbPath = dbPath || getDbPath();
    // Check if database exists
    const fs = await import('fs');
    if (!fs.existsSync(resolvedDbPath)) {
        return {
            totalConversations: 0,
            conversationsWithSummaries: 0,
            conversationsWithoutSummaries: 0,
            totalExchanges: 0,
            projectCount: 0,
        };
    }
    const db = new Database(resolvedDbPath, { readonly: true });
    try {
        // Check if tables exist
        const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
        const hasExchanges = tables.some(t => t.name === 'exchanges');
        if (!hasExchanges) {
            // Empty database
            return {
                totalConversations: 0,
                conversationsWithSummaries: 0,
                conversationsWithoutSummaries: 0,
                totalExchanges: 0,
                projectCount: 0,
            };
        }
        // Total conversations
        const totalConversations = db.prepare('SELECT COUNT(DISTINCT archive_path) as count FROM exchanges').get();
        // Summaries are files, not DB fields. An empty file is a sentinel of the sync: a conversation with no exchanges,
        // or a summary that the sync gave up on. Ported from upstream de11f90.
        const conversationPaths = db.prepare('SELECT DISTINCT archive_path FROM exchanges').all();
        let withSummariesCount = 0;
        for (const { archive_path } of conversationPaths) {
            const summaryPath = archive_path.replace('.jsonl', '-summary.txt');
            if (hasSummaryText(fs, summaryPath)) {
                withSummariesCount++;
            }
        }
        // Total exchanges
        const totalExchanges = db.prepare('SELECT COUNT(*) as count FROM exchanges').get();
        // Date range
        const dateRange = db.prepare('SELECT MIN(timestamp) as earliest, MAX(timestamp) as latest FROM exchanges').get();
        // Project counts
        const projectCount = db.prepare('SELECT COUNT(DISTINCT project) as count FROM exchanges').get();
        // Top 10 projects
        const topProjects = db.prepare(`
      SELECT project, COUNT(DISTINCT archive_path) as count
      FROM exchanges
      GROUP BY project
      ORDER BY count DESC
      LIMIT 10
    `).all();
        let databaseSize;
        try {
            const bytes = fs.statSync(resolvedDbPath).size;
            databaseSize = `${(bytes / 1024).toFixed(1)} KB`;
        }
        catch {
            databaseSize = undefined;
        }
        return {
            totalConversations: totalConversations.count,
            conversationsWithSummaries: withSummariesCount,
            conversationsWithoutSummaries: totalConversations.count - withSummariesCount,
            totalExchanges: totalExchanges.count,
            dateRange: dateRange?.earliest ? {
                earliest: dateRange.earliest,
                latest: dateRange.latest,
            } : undefined,
            projectCount: projectCount.count,
            topProjects,
            databaseSize,
        };
    }
    finally {
        db.close();
    }
}
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
export function formatStats(stats) {
    let output = 'Episodic Memory Index Statistics\n';
    output += '='.repeat(50) + '\n\n';
    output += `Total Conversations: ${stats.totalConversations.toLocaleString()}\n`;
    output += `Total Exchanges: ${stats.totalExchanges.toLocaleString()}\n\n`;
    output += `With Summaries: ${stats.conversationsWithSummaries.toLocaleString()}\n`;
    output += `Without Summaries: ${stats.conversationsWithoutSummaries.toLocaleString()}\n`;
    if (stats.conversationsWithoutSummaries > 0) {
        const percentage = ((stats.conversationsWithoutSummaries / stats.totalConversations) * 100).toFixed(1);
        output += `  (${percentage}% missing summaries)\n`;
    }
    output += '\n';
    if (stats.dateRange) {
        output += `Date Range:\n`;
        output += `  Earliest: ${new Date(stats.dateRange.earliest).toLocaleDateString()}\n`;
        output += `  Latest: ${new Date(stats.dateRange.latest).toLocaleDateString()}\n\n`;
    }
    output += `Unique Projects: ${stats.projectCount.toLocaleString()}\n\n`;
    if (stats.topProjects && stats.topProjects.length > 0) {
        output += `Top Projects by Conversation Count:\n`;
        for (const { project, count } of stats.topProjects) {
            const displayProject = project || '(unknown)';
            output += `  ${count.toString().padStart(4)} - ${displayProject}\n`;
        }
    }
    return output;
}
