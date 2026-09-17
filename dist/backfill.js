/**
 * Archive backfill: summarize conversations that sync can never reach.
 *
 * WHY THIS EXISTS. Sync walks the SOURCE projects directory, so it only ever queues conversations
 * whose source .jsonl still exists. Once Claude Code prunes a transcript, its archived copy is never
 * revisited. Measured 2026-09-17: the ZBOOK archive held 8,987 conversations, 2,154 with NO summary
 * file and 2,921 with an unexplained empty one; the EVO 5,575, 3,157 and 1,199. Sync reported 27.
 *
 * Candidates are exactly what sync would retry if it could see them: no summary file, or an empty
 * summary with no marker or a non-terminal (retrying) marker. Explained empties are final.
 * Each candidate goes through summarizeOneFile, so the evidence it leaves is identical to sync's.
 * Use a local backend (EPISODIC_MEMORY_SUMMARIZER_BACKEND=ollama) for bulk runs.
 */
import fs from 'fs';
import path from 'path';
import { getExcludedProjects } from './paths.js';
import { extractSessionIdFromPath, isTerminalFailRecord, shouldSkipConversation, summarizeOneFile, } from './sync.js';
function needsSummary(filePath) {
    const summaryPath = filePath.replace(/\.jsonl$/, '-summary.txt');
    let size;
    try {
        size = fs.statSync(summaryPath).size;
    }
    catch {
        return true; // no summary file at all
    }
    if (size > 0)
        return false;
    const failPath = filePath.replace(/\.jsonl$/, '-summary.failed');
    if (!fs.existsSync(failPath))
        return true; // legacy empty, nothing explains it
    return !isTerminalFailRecord(filePath); // mid-retry, keep going
}
export function selectBackfillCandidates(archiveDir, opts = {}) {
    const excluded = new Set(opts.excludedProjects ?? getExcludedProjects());
    const out = [];
    let projects;
    try {
        projects = fs.readdirSync(archiveDir, { withFileTypes: true });
    }
    catch {
        return out;
    }
    for (const project of projects) {
        if (!project.isDirectory() || excluded.has(project.name))
            continue;
        const dir = path.join(archiveDir, project.name);
        for (const name of fs.readdirSync(dir).sort()) {
            if (!name.endsWith('.jsonl'))
                continue;
            const filePath = path.join(dir, name);
            const sessionId = extractSessionIdFromPath(filePath);
            if (!sessionId || !needsSummary(filePath) || shouldSkipConversation(filePath))
                continue;
            out.push({ path: filePath, sessionId });
        }
    }
    return out;
}
export async function backfillArchive(archiveDir, opts) {
    const candidates = selectBackfillCandidates(archiveDir);
    const result = { candidates: candidates.length, processed: 0, summarized: 0, summaryAttempts: 0, errors: [] };
    if (opts.dryRun)
        return result;
    const { summarizeConversation } = await import('./summarizer.js');
    const limit = opts.limit && opts.limit > 0 ? opts.limit : candidates.length;
    for (const c of candidates.slice(0, limit)) {
        await summarizeOneFile(c.path, c.sessionId, result, summarizeConversation);
        result.processed++;
    }
    return result;
}
/**
 * Decide what the batch loop does next. `prevRemaining` is what the PREVIOUS batch left
 * (candidates - processed); undefined on the first batch. A batch always STARTS at the previous
 * remainder, so progress is measured on what THIS batch leaves, never on where it starts.
 */
export function batchVerdict(prevRemaining, r) {
    if (r.processed === 0)
        return 'done';
    // Three or more real attempts and not one success: the backend is down, not one bad transcript.
    if (r.summaryAttempts >= 3 && r.summarized === 0)
        return 'backend-down';
    const remaining = r.candidates - r.processed;
    if (prevRemaining !== undefined && remaining >= prevRemaining)
        return 'no-progress';
    return 'continue';
}
