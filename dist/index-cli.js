#!/usr/bin/env node
import { verifyIndex, repairIndex } from './verify.js';
import { indexSession, indexUnprocessed, indexConversations } from './indexer.js';
import { initDatabase, getFreelistInfo, vacuumDatabase } from './db.js';
import { getDbPath, getArchiveDir, getExcludedProjects, statIfExists } from './paths.js';
import { pruneProjects } from './prune.js';
import { acquireRefreshedLock, releaseLock } from './lockfile.js';
import { getSyncLockPath } from './logging.js';
import fs from 'fs';
import path from 'path';
const COMMANDS = new Set(['index-all', 'index-session', 'index-cleanup', 'verify', 'repair', 'rebuild', 'prune', 'vacuum']);
const VALUE_OPTIONS = new Set(['--concurrency', '-c', '--project']);
const INDEX_OPTIONS = ['--concurrency', '-c', '--no-summaries'];
/** The options that each command accepts. A call without a command runs index-all. */
const OPTIONS_BY_COMMAND = {
    'index-all': INDEX_OPTIONS,
    'index-session': INDEX_OPTIONS,
    'index-cleanup': INDEX_OPTIONS,
    rebuild: [...INDEX_OPTIONS, '--yes'],
    prune: ['--excluded', '--project', '--dry-run'],
    verify: [],
    repair: [],
    vacuum: [],
};
const KNOWN_OPTIONS = new Set(Object.values(OPTIONS_BY_COMMAND).flat());
const USAGE = `Usage: index-cli [command] [options]

Commands: index-all (the default), index-session <session-id>, index-cleanup, verify, repair, rebuild, prune, vacuum
Options:  --concurrency N or -c N (an integer from 1 to 16), --no-summaries (index-all, index-session, index-cleanup, rebuild)
          --yes (rebuild; the command deletes the index database and every summary file)
          --excluded or --project <name>, --dry-run (prune)
Exit 75: a sync or another index command holds the index lock. The command does no work. Run the command again later.

Run 'episodic-memory index --help' for the full help.`;
/**
 * Check the arguments before any work.
 *
 * Without the check, an unknown command or option fell to the default branch. That branch indexes every
 * source with summaries. A value option consumes the next argument. Only index-session takes a second
 * positional argument, the session id. Each option must belong
 * to the command, so `--dry-run` without `prune` cannot start a real index. `rebuild` needs `--yes`, because
 * an option before the command hides the command from the confirmation of the wrapper.
 */
function parseArgs(argv) {
    const positionals = [];
    const options = [];
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === '--help' || arg === '-h') {
            console.log(USAGE);
            process.exit(0);
        }
        if (VALUE_OPTIONS.has(arg)) {
            const value = argv[++i];
            if (value === undefined)
                refuse(`option ${arg} needs a value`);
            options.push({ name: arg, value });
            continue;
        }
        if (KNOWN_OPTIONS.has(arg)) {
            options.push({ name: arg });
            continue;
        }
        if (arg.startsWith('-'))
            refuse(`unknown option ${arg}`);
        if (positionals.length === 0 && !COMMANDS.has(arg))
            refuse(`unknown command ${arg}`);
        if (positionals.length === 1 && positionals[0] !== 'index-session')
            refuse(`unknown argument ${arg}`);
        if (positionals.length === 2)
            refuse(`unknown argument ${arg}`);
        positionals.push(arg);
    }
    const command = positionals[0] ?? 'index-all';
    for (const option of options) {
        if (!OPTIONS_BY_COMMAND[command].includes(option.name))
            refuse(`option ${option.name} does not apply to ${command}`);
        if ((option.name === '--concurrency' || option.name === '-c') && !/^([1-9]|1[0-6])$/.test(option.value ?? '')) {
            refuse(`option ${option.name} needs an integer from 1 to 16`);
        }
    }
    if (command === 'rebuild' && !options.some(o => o.name === '--yes')) {
        refuse("rebuild deletes the index database and every summary file and needs --yes. 'episodic-memory index --rebuild' asks first");
    }
    return { command: positionals[0], positionals };
}
function refuse(reason) {
    console.error(`episodic-memory index: ${reason}. Run 'episodic-memory index --help'.`);
    process.exit(2);
}
const { command, positionals } = parseArgs(process.argv.slice(2));
/** The exit code of a run that another sync or index command blocks (EX_TEMPFAIL). The caller can try again later. */
const LOCK_BUSY_EXIT = 75;
// Every command opens the index, and the open can migrate the database. rebuild also deletes the database and the
// summaries. The sync worker writes the same files, so each command takes the lock of the sync worker first.
// Ported from upstream f1bcef6. index-cli checks the arguments before the lock, so a refusal never waits on a sync.
const syncLockPath = getSyncLockPath();
const syncLock = acquireRefreshedLock(syncLockPath);
if (!syncLock) {
    let holder = 'unknown pid';
    try {
        const pid = fs.readFileSync(syncLockPath, 'utf-8').trim();
        if (/^[1-9][0-9]*$/.test(pid))
            holder = `pid ${pid}`;
    }
    catch {
        // The holder can release the lock between the acquire and this read. The message then names no PID.
    }
    console.error(`episodic-memory index: another sync or index command is running (${holder}); try again when it ends`);
    process.exit(LOCK_BUSY_EXIT);
}
process.on('exit', () => releaseLock(syncLock));
// Parse --concurrency flag from remaining args
function getConcurrency() {
    const concurrencyIndex = process.argv.findIndex(arg => arg === '--concurrency' || arg === '-c');
    if (concurrencyIndex !== -1 && process.argv[concurrencyIndex + 1]) {
        const value = parseInt(process.argv[concurrencyIndex + 1], 10);
        if (value >= 1 && value <= 16)
            return value;
    }
    return 1; // default
}
// Parse --no-summaries flag
function getNoSummaries() {
    return process.argv.includes('--no-summaries');
}
const concurrency = getConcurrency();
const noSummaries = getNoSummaries();
async function main() {
    try {
        switch (command) {
            case 'index-session':
                const sessionId = positionals[1];
                if (!sessionId) {
                    console.error('Usage: index-cli index-session <session-id>');
                    process.exit(1);
                }
                await indexSession(sessionId, concurrency, noSummaries);
                break;
            case 'index-cleanup':
                await indexUnprocessed(concurrency, noSummaries);
                break;
            case 'verify':
                console.log('Verifying conversation index...');
                const issues = await verifyIndex();
                console.log('\n=== Verification Results ===');
                console.log(`Missing summaries: ${issues.missing.length}`);
                console.log(`Orphaned entries: ${issues.orphaned.length}`);
                console.log(`Outdated files: ${issues.outdated.length}`);
                console.log(`Corrupted files: ${issues.corrupted.length}`);
                if (issues.missing.length > 0) {
                    console.log('\nMissing summaries:');
                    issues.missing.forEach(m => console.log(`  ${m.path}`));
                }
                if (issues.missing.length + issues.orphaned.length + issues.outdated.length + issues.corrupted.length > 0) {
                    console.log('\nRun with --repair to fix these issues.');
                    process.exit(1);
                }
                else {
                    console.log('\n✅ Index is healthy!');
                }
                break;
            case 'repair':
                console.log('Verifying conversation index...');
                const repairIssues = await verifyIndex();
                if (repairIssues.missing.length + repairIssues.orphaned.length + repairIssues.outdated.length > 0) {
                    await repairIndex(repairIssues);
                }
                else {
                    console.log('✅ No issues to repair!');
                }
                break;
            case 'rebuild':
                console.log('Rebuilding entire index...');
                // Delete database
                const dbPath = getDbPath();
                if (fs.existsSync(dbPath)) {
                    fs.unlinkSync(dbPath);
                    console.log('Deleted existing database');
                }
                // Delete all summary files
                const archiveDir = getArchiveDir();
                if (fs.existsSync(archiveDir)) {
                    const projects = fs.readdirSync(archiveDir);
                    for (const project of projects) {
                        const projectPath = path.join(archiveDir, project);
                        if (!statIfExists(projectPath)?.isDirectory())
                            continue;
                        const summaries = fs.readdirSync(projectPath).filter(f => f.endsWith('-summary.txt'));
                        for (const summary of summaries) {
                            fs.unlinkSync(path.join(projectPath, summary));
                        }
                    }
                    console.log('Deleted all summary files');
                }
                // Re-index everything
                console.log('Re-indexing all conversations...');
                await indexConversations(undefined, undefined, concurrency, noSummaries);
                break;
            case 'prune': {
                // exclude.txt only stops *future* indexing (indexer.ts:62-63). Without this,
                // removing an already-indexed project meant hand-written SQL. See issue #4.
                const dryRun = process.argv.includes('--dry-run');
                const projectIdx = process.argv.findIndex(a => a === '--project');
                let targets;
                if (process.argv.includes('--excluded')) {
                    targets = getExcludedProjects();
                    if (targets.length === 0) {
                        console.log('No excluded projects configured — nothing to prune.');
                        console.log('Set CONVERSATION_SEARCH_EXCLUDE_PROJECTS or add entries to exclude.txt.');
                        break;
                    }
                }
                else if (projectIdx !== -1 && process.argv[projectIdx + 1]) {
                    targets = [process.argv[projectIdx + 1]];
                }
                else {
                    console.error('Usage: index-cli prune (--excluded | --project <name>) [--dry-run]');
                    process.exit(1);
                }
                console.log(`Pruning ${targets.length} project(s): ${targets.join(', ')}`);
                const pdb = initDatabase();
                const res = pruneProjects(pdb, targets, { dryRun });
                pdb.close();
                console.log(`  exchanges  : ${res.exchangesDeleted}`);
                console.log(`  tool_calls : ${res.toolCallsDeleted}`);
                console.log(`  vectors    : ${res.vectorsDeleted}`);
                console.log(`  text freed : ${(res.bytesFreed / 1024 ** 2).toFixed(1)} MB`);
                if (dryRun) {
                    console.log('\nDry run — nothing was deleted. Re-run without --dry-run to apply.');
                }
                else if (res.exchangesDeleted > 0) {
                    // Deleting rows alone reclaims no disk space; SQLite keeps the freed pages.
                    console.log('\nRows removed. Run `index vacuum` to return the freed pages to disk.');
                }
                break;
            }
            case 'vacuum': {
                // SQLite never returns freed pages to the filesystem on its own, and nothing
                // else in this codebase runs VACUUM. Deleting rows therefore reclaims no disk
                // space, which reads to users as "deleting didn't work". See issue #3.
                const dbPath = getDbPath();
                // Open first: initDatabase() creates the file and runs migrations, so measuring
                // before that reports 0 on a fresh DB and a negative "reclaimed" figure.
                const db = initDatabase();
                const before = fs.existsSync(dbPath) ? fs.statSync(dbPath).size : 0;
                const { freePages, pageSize } = getFreelistInfo(db);
                console.log(`Database: ${dbPath}`);
                console.log(`  size before : ${(before / 1024 ** 2).toFixed(1)} MB`);
                console.log(`  free pages  : ${freePages} (~${((freePages * pageSize) / 1024 ** 2).toFixed(1)} MB reclaimable)`);
                console.log('Running VACUUM (needs temporary free space ~= database size)...');
                const started = Date.now();
                vacuumDatabase(db);
                db.close();
                const after = fs.statSync(dbPath).size;
                const freed = before - after;
                const elapsed = ((Date.now() - started) / 1000).toFixed(1);
                console.log(`  size after  : ${(after / 1024 ** 2).toFixed(1)} MB`);
                if (freed > 0) {
                    console.log(`  reclaimed   : ${(freed / 1024 ** 2).toFixed(1)} MB` +
                        (before > 0 ? ` (${((freed / before) * 100).toFixed(1)}%)` : '') +
                        ` in ${elapsed}s`);
                }
                else {
                    // VACUUM also checkpoints the WAL into the main file, so a database with
                    // little or no free space can legitimately end up slightly larger. Reporting
                    // that as a negative "reclaimed" figure reads like a failure; it isn't.
                    console.log(`  nothing to reclaim — file grew ${(Math.abs(freed) / 1024 ** 2).toFixed(1)} MB ` +
                        `as VACUUM checkpointed the WAL into it (${elapsed}s)`);
                }
                break;
            }
            // parseArgs refuses every other command, so index-cli reaches the default branch only without a command.
            case 'index-all':
            default:
                await indexConversations(undefined, undefined, concurrency, noSummaries);
                break;
        }
    }
    catch (error) {
        console.error('Error:', error);
        process.exit(1);
    }
}
main();
