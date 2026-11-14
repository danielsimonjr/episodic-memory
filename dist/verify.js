import fs from 'fs';
import path from 'path';
import { parseConversation } from './parser.js';
import { initDatabase, getAllExchanges, getFileLastIndexed } from './db.js';
import { getArchiveDir, getExcludedProjects, findJsonlFiles, statIfExists } from './paths.js';
import { scanExclusionMarkers, shouldSkipConversation } from './exclusion-marker.js';
import { writeNoExchangeSummary } from './summary-sentinel.js';
/**
 * Compare the conversation archive with the index and list the differences.
 *
 * The function checks each archived conversation in a project that is not excluded. The function skips a conversation with an exclusion marker, so the index rows of that conversation count as orphaned. The function then checks each indexed exchange for an archive file. The function opens the index with `initDatabase`, which runs its migrations, and prints progress lines to standard output.
 *
 * The function returns an empty result when the archive folder does not exist. The function repairs nothing.
 */
export async function verifyIndex() {
    const result = {
        missing: [],
        orphaned: [],
        outdated: [],
        corrupted: []
    };
    const archiveDir = getArchiveDir();
    // Track all files we find
    const foundFiles = new Set();
    // Find all conversation files
    if (!fs.existsSync(archiveDir)) {
        return result;
    }
    // Initialize database once for all checks
    const db = initDatabase();
    const projects = fs.readdirSync(archiveDir);
    const excludedProjects = getExcludedProjects();
    const excludedDirSet = new Set(excludedProjects);
    let totalChecked = 0;
    for (const project of projects) {
        if (excludedProjects.includes(project)) {
            console.log("\nSkipping excluded project: " + project);
            continue;
        }
        const projectPath = path.join(archiveDir, project);
        if (!statIfExists(projectPath)?.isDirectory())
            continue;
        const files = findJsonlFiles(projectPath, excludedDirSet);
        for (const file of files) {
            totalChecked++;
            if (totalChecked % 100 === 0) {
                console.log(`  Checked ${totalChecked} conversations...`);
            }
            const conversationPath = path.join(projectPath, file);
            // An excluded conversation stays out of the index. The file of the excluded conversation does not go into
            // foundFiles. As a result, any index rows of the file count as orphaned, and a repair deletes the rows. A file
            // that the scan cannot read keeps its rows. verifyIndex lists that file as corrupted, for manual review.
            const markerScan = scanExclusionMarkers(conversationPath);
            if (markerScan === 'marker')
                continue;
            foundFiles.add(conversationPath);
            if (markerScan === 'unreadable') {
                result.corrupted.push({ path: conversationPath, error: 'the exclusion-marker scan could not read the file' });
                continue;
            }
            const summaryPath = conversationPath.replace('.jsonl', '-summary.txt');
            // Check for missing summary
            if (!fs.existsSync(summaryPath)) {
                result.missing.push({ path: conversationPath, reason: 'No summary file' });
                continue;
            }
            // Check if file is outdated (modified after last_indexed)
            const lastIndexed = getFileLastIndexed(db, conversationPath);
            if (lastIndexed !== null) {
                const fileStat = fs.statSync(conversationPath);
                // last_indexed is stored as integer ms (Date.now()); mtimeMs is a float with
                // sub-millisecond precision. Floor to the storage granularity so a re-index that
                // lands in the same ms as the file's mtime is NOT falsely reported as outdated
                // (sub-ms changes are undetectable at integer-ms resolution anyway).
                if (Math.floor(fileStat.mtimeMs) > lastIndexed) {
                    result.outdated.push({
                        path: conversationPath,
                        fileTime: fileStat.mtimeMs,
                        dbTime: lastIndexed
                    });
                }
            }
            // Try parsing to detect corruption
            try {
                await parseConversation(conversationPath, project, conversationPath);
            }
            catch (error) {
                result.corrupted.push({
                    path: conversationPath,
                    error: error instanceof Error ? error.message : String(error)
                });
            }
        }
    }
    console.log(`Verified ${totalChecked} conversations.`);
    // Check for orphaned database entries
    const dbExchanges = getAllExchanges(db);
    db.close();
    for (const exchange of dbExchanges) {
        if (!foundFiles.has(exchange.archivePath)) {
            result.orphaned.push({
                uuid: exchange.id,
                path: exchange.archivePath
            });
        }
    }
    return result;
}
/**
 * Repair the problems that `verifyIndex` found.
 *
 * The function deletes the index rows of orphaned exchanges. The function skips a listed conversation with an exclusion marker, so that conversation gets no summary call. For each other missing or outdated conversation, the function parses the conversation again. The function then writes the summary file when the summary succeeds, and indexes the exchanges with new embeddings. A conversation that fails is logged and skipped, and the other conversations still run.
 *
 * The function does not repair corrupted conversations. The function prints them for manual review.
 *
 * The function throws when the index database or the embedding model cannot start.
 */
export async function repairIndex(issues) {
    console.log('Repairing index...');
    // To avoid circular dependencies, we import the indexer functions dynamically
    const { initDatabase, insertExchange, deleteExchange } = await import('./db.js');
    const { parseConversation } = await import('./parser.js');
    const { initEmbeddings, generateExchangeEmbedding } = await import('./embeddings.js');
    const { summarizeConversation } = await import('./summarizer.js');
    const db = initDatabase();
    await initEmbeddings();
    // Remove orphaned entries first, then the digest lines that cite them
    for (const orphan of issues.orphaned) {
        console.log(`Removing orphaned entry: ${orphan.uuid}`);
        deleteExchange(db, orphan.uuid);
    }
    const { removeDerivedText } = await import('./derived-text.js');
    const derived = removeDerivedText(db, issues.orphaned.map(orphan => orphan.uuid));
    if (derived.digestLinesRemoved > 0)
        console.log(`Removed ${derived.digestLinesRemoved} digest line(s) of the orphaned entries`);
    // Re-index missing and outdated conversations
    const toReindex = [
        ...issues.missing.map(m => m.path),
        ...issues.outdated.map(o => o.path)
    ];
    for (const conversationPath of toReindex) {
        // The file can gain a marker between the verify run and the repair. An excluded file gets no summary call.
        if (shouldSkipConversation(conversationPath)) {
            console.log(`Skipped (exclusion marker, or the marker scan could not read the file): ${conversationPath}`);
            continue;
        }
        console.log(`Re-indexing: ${conversationPath}`);
        try {
            // Extract project name from path
            const archiveDir = getArchiveDir();
            const relativePath = conversationPath.replace(archiveDir + path.sep, '');
            const project = relativePath.split(path.sep)[0];
            // Parse conversation
            const exchanges = await parseConversation(conversationPath, project, conversationPath);
            if (exchanges.length === 0) {
                // A repair writes the record that sync writes, so the summary of the transcript stops being missing.
                writeNoExchangeSummary(conversationPath);
                console.log(`  Skipped (no exchanges)`);
                continue;
            }
            // Generate/update summary — best-effort. A summarizer failure (e.g. the Claude
            // Agent SDK is unauthenticated or times out) must NOT abort re-indexing: the
            // exchanges + embeddings below are the core of the repair, the summary is auxiliary.
            // Previously a throw here fell through to the outer catch, so the file was never
            // re-indexed and stayed permanently "outdated" (re-attempted every run).
            try {
                const summaryPath = conversationPath.replace('.jsonl', '-summary.txt');
                const summary = await summarizeConversation(exchanges);
                fs.writeFileSync(summaryPath, summary, 'utf-8');
                console.log(`  Created summary: ${summary.split(/\s+/).length} words`);
            }
            catch (summaryError) {
                console.error(`  Summary generation failed (indexing continues): ${summaryError instanceof Error ? summaryError.message : summaryError}`);
            }
            // Index exchanges
            for (const exchange of exchanges) {
                const toolNames = exchange.toolCalls?.map(tc => tc.toolName);
                const embedding = await generateExchangeEmbedding(exchange.userMessage, exchange.assistantMessage, toolNames);
                insertExchange(db, exchange, embedding, toolNames);
            }
            console.log(`  Indexed ${exchanges.length} exchanges`);
        }
        catch (error) {
            console.error(`Failed to re-index ${conversationPath}:`, error);
        }
    }
    db.close();
    // Report corrupted files (manual intervention needed)
    if (issues.corrupted.length > 0) {
        console.log('\n⚠️  Corrupted files (manual review needed):');
        issues.corrupted.forEach(c => console.log(`  ${c.path}: ${c.error}`));
    }
    console.log('✅ Repair complete.');
}
