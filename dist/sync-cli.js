// Only light, dependency-free imports at the top. The heavy native stack
// (better-sqlite3 via ./db.js, transformers via ./embeddings.js and
// ./embedding-migration.js) is imported lazily AFTER the early-exit checks
// below, so a guarded reentrant subprocess — or a `--help`/`--background`
// invocation — exits without paying the multi-second module load. (#87)
import { getArchiveDir, getConversationSourceDirs, getIndexDir } from './paths.js';
import { shouldSkipReentrantSync } from './reentrancy.js';
import { acquireLock, releaseLock } from './lockfile.js';
import { BACKGROUND_WORKER_ENV, lowerPriorityIfBackgroundWorker } from './priority.js';
import { spawn } from 'child_process';
import fs from 'fs';
import { formatLogLine, getSyncLogPath, getSyncLockPath, rotateSyncLogIfNeeded } from './logging.js';
const args = process.argv.slice(2);
// Reentrancy guard (#87): if this sync was triggered by a SessionStart hook
// inside a Claude subprocess that the summarizer just spawned, exit silently.
// Without this, summarization spawns a Claude subprocess which fires
// SessionStart which runs sync which spawns more summarization — cascading
// fanout that pegs CPU and burns API quota.
if (shouldSkipReentrantSync()) {
    // stderr keeps the message out of any stdout consumers (e.g., MCP)
    // while still being visible in hook logs.
    console.error('episodic-memory: skipping sync inside summarizer-spawned subprocess (#87)');
    process.exit(0);
}
if (args.includes('--help') || args.includes('-h')) {
    console.log(`
Usage: episodic-memory sync [--background]

Sync conversations from Claude Code and Codex transcript directories to archive and index them.

This command:
1. Copies new or updated .jsonl files to conversation archive
2. Generates embeddings for semantic search
3. Updates the search index

Only processes files that are new or have been modified since last sync.
Safe to run multiple times - subsequent runs are fast no-ops.

OPTIONS:
  --background    Run sync in background (for hooks, returns immediately)

EXAMPLES:
  # Sync all new conversations
  episodic-memory sync

  # Sync in background (for hooks)
  episodic-memory sync --background

  # Use in Claude Code hook
  # In .claude/hooks/session-end:
  episodic-memory sync --background
`);
    process.exit(0);
}
// Check if running in background mode
const isBackground = args.includes('--background');
// If background mode, fork the process and exit immediately
if (isBackground) {
    const filteredArgs = args.filter(arg => arg !== '--background');
    rotateSyncLogIfNeeded(); // keep the shared log from growing without bound (F4)
    const logPath = getSyncLogPath();
    const logFd = fs.openSync(logPath, 'a');
    try {
        fs.writeSync(logFd, formatLogLine('info', `Starting background sync from pid ${process.pid}`));
        // Spawn a detached process. The child dup's the fd via stdio, so the parent
        // closes its own copy below rather than leaking it (F3).
        //
        // Tag the child as the background worker so it drops itself to below-normal
        // priority before booting transformers. Without this the detached worker
        // embeds at NORMAL priority and starves the interactive session that spawned
        // it — including MCP servers, which then blow their 30s handshake budget.
        const child = spawn(process.execPath, [
            process.argv[1], // This script
            ...filteredArgs
        ], {
            detached: true,
            stdio: ['ignore', logFd, logFd],
            env: { ...process.env, [BACKGROUND_WORKER_ENV]: '1' }
        });
        child.unref(); // Allow parent to exit
    }
    finally {
        fs.closeSync(logFd);
    }
    console.log(`Sync started in background. Log: ${logPath}`);
    process.exit(0);
}
// Worker path. Serialize syncs: only one worker runs the heavy embedding +
// summarization at a time. Independent SessionStart hooks (multiple Claude
// sessions, compactions) otherwise stack overlapping syncs that each boot the
// transformer and fan out summarizer subprocesses, pegging the CPU — the storm
// behind the wedged orphans. Checked here, before the heavy imports below, so a
// locked-out worker bails instantly.
const syncLock = acquireLock(getSyncLockPath());
if (!syncLock) {
    console.error('episodic-memory: another sync is already running; skipping');
    process.exit(0);
}
process.on('exit', () => releaseLock(syncLock));
// Detached background worker: get out of the foreground's way BEFORE loading the
// transformer stack below, so the embedding work never runs at normal priority.
if (lowerPriorityIfBackgroundWorker()) {
    console.error('episodic-memory: background worker running at below-normal priority');
}
// Past the early-exit checks: now load the heavy native-dep modules. Doing this
// lazily (rather than as top-level static imports) keeps the guard/help/background
// paths above fast — they never load transformers or better-sqlite3.
const { syncConversations } = await import('./sync.js');
const { initDatabase } = await import('./db.js');
const { generateExchangeEmbedding, initEmbeddings } = await import('./embeddings.js');
const { runMigrationBatch, countStale } = await import('./embedding-migration.js');
const sourceDirs = getConversationSourceDirs();
const destDir = getArchiveDir();
if (sourceDirs.length === 0) {
    console.log('⚠️  No conversation source directories found.');
    console.log('  Checked: ~/.claude/projects, ~/.claude/transcripts, and ~/.codex/sessions');
    if (process.env.CLAUDE_CONFIG_DIR) {
        console.log(`  CLAUDE_CONFIG_DIR is set to: ${process.env.CLAUDE_CONFIG_DIR}`);
    }
    process.exit(0);
}
console.log('Syncing conversations...');
console.log(`Sources: ${sourceDirs.join(', ')}`);
console.log(`Destination: ${destDir}\n`);
async function syncAll() {
    const totals = { copied: 0, skipped: 0, indexed: 0, summarized: 0, errors: [], pendingSummaries: 0 };
    // Global per-sync summary budget shared across ALL source dirs (F2). Previously
    // the 10-summary cap applied per source dir, so the real cap was 10 × dirs and
    // was not configurable. Now it's one configurable budget decremented as each
    // dir consumes attempts.
    const configuredLimit = parseInt(process.env.EPISODIC_MEMORY_SUMMARY_LIMIT || '10', 10);
    // Guard against a garbage env value (NaN would slice(0, NaN) → silently summarize
    // nothing forever, with no error).
    let summaryBudget = Number.isFinite(configuredLimit) && configuredLimit > 0 ? configuredLimit : 10;
    for (const sourceDir of sourceDirs) {
        const result = await syncConversations(sourceDir, destDir, { summaryLimit: Math.max(0, summaryBudget) });
        totals.copied += result.copied;
        totals.skipped += result.skipped;
        totals.indexed += result.indexed;
        totals.summarized += result.summarized;
        totals.pendingSummaries += result.pendingSummaries;
        totals.errors.push(...result.errors);
        summaryBudget -= result.summaryAttempts;
    }
    // HONEST BANNER (2026-08-29). This printed the success line UNCONDITIONALLY - including on the
    // 87-of-140 runs that summarised nothing while a backlog waited. A success banner over a stalled
    // queue is the exact failure this tool exists to prevent: it reads as health from outside, so the
    // real alarm (archive lag) only arrives days later and downstream of the cause.
    const summaryStalled = totals.pendingSummaries > 0 && totals.summarized === 0;
    if (summaryStalled) {
        console.log(`\n⚠️  Sync finished WITHOUT SUMMARISING ANYTHING - ${totals.pendingSummaries} conversation(s) still need summaries.`);
        console.log(`  This is NOT a healthy run; copy and index results below are still valid.`);
    }
    else {
        console.log(`\n✅ Sync complete!`);
    }
    console.log(`  Copied: ${totals.copied}`);
    console.log(`  Skipped: ${totals.skipped}`);
    console.log(`  Indexed: ${totals.indexed}`);
    console.log(`  Summarized: ${totals.summarized}${totals.pendingSummaries > 0 ? ` (${totals.pendingSummaries} still pending)` : ''}`);
    if (totals.errors.length > 0) {
        console.log(`\n⚠️  Errors: ${totals.errors.length}`);
        totals.errors.forEach(err => console.log(`  ${err.file}: ${err.error}`));
        // Help diagnose silent summarization failures (#70)
        const summaryErrors = totals.errors.filter(e => e.error.startsWith('Summary generation failed'));
        if (summaryErrors.length > 0 && totals.summarized === 0) {
            console.log(`\n💡 All ${summaryErrors.length} summarization attempts failed.`);
            console.log(`  Check your API configuration (EPISODIC_MEMORY_API_BASE_URL / ANTHROPIC_API_KEY).`);
        }
    }
    // After regular sync, do a batch of embedding migration if any rows are
    // still on the old encoder. Lock-protected; if another process is already
    // migrating, this is a no-op.
    await runEmbeddingMigrationPhase();
}
const MIGRATION_BATCH_SIZE = parseInt(process.env.EPISODIC_MEMORY_MIGRATION_BATCH || '500', 10);
async function runEmbeddingMigrationPhase() {
    const db = initDatabase();
    try {
        const stale = countStale(db);
        if (stale === 0)
            return;
        console.error(`\nepisodic-memory: ${stale} exchange(s) on the old embedding model — migrating up to ${MIGRATION_BATCH_SIZE} this run`);
        await initEmbeddings();
        const indexDir = getIndexDir();
        const done = await runMigrationBatch(db, indexDir, MIGRATION_BATCH_SIZE, generateExchangeEmbedding);
        if (done > 0) {
            const after = countStale(db);
            console.error(`episodic-memory: re-embedded ${done} (${after} still stale; will resume on next sync)`);
        }
    }
    catch (err) {
        console.error('episodic-memory: migration phase error:', err instanceof Error ? err.message : err);
    }
    finally {
        db.close();
    }
}
syncAll().catch(error => {
    console.error('Error syncing:', error);
    process.exit(1);
});
