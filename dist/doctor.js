import fs from 'fs';
import path from 'path';
import { MIN_CODEX_VERSION, parseCodexCliVersion, versionMeetsMinimum, } from './codex-support.js';
import { EMBEDDING_VERSION, countStale } from './embedding-migration.js';
import { initDatabase } from './db.js';
import { getArchiveDir, getDbPath, getIndexDir, getSuperpowersDir, } from './paths.js';
import { getSyncErrorsLogPath, getSyncLogPath } from './logging.js';
import { nodeModulesIsHealthy } from './deps-health.js';
import { assertNodeFloor } from './node-floor.js';
import { collectLearnDoctorSection } from './doctor-learn.js';
function parseFeatureState(featuresOutput, feature) {
    const line = featuresOutput
        .split(/\r?\n/)
        .map(entry => entry.trim())
        .find(entry => entry.startsWith(`${feature} `));
    if (!line) {
        return undefined;
    }
    const lastColumn = line.split(/\s+/).at(-1);
    if (lastColumn === 'true')
        return true;
    if (lastColumn === 'false')
        return false;
    return undefined;
}
function parseMcpState(mcpListOutput) {
    const line = mcpListOutput
        .split(/\r?\n/)
        .map(entry => entry.trim())
        .find(entry => entry.startsWith('episodic-memory '));
    if (!line) {
        return 'missing';
    }
    return line.includes(' enabled') ? 'enabled' : 'disabled';
}
function formatHookTrustState(hookTrustState) {
    switch (hookTrustState) {
        case 'trusted':
            return 'trusted';
        case 'untrusted':
            return 'untrusted; open /hooks in Codex, review the Episodic Memory hook, and press t to trust it.';
        case 'modified':
            return 'modified since it was trusted; open /hooks in Codex, review the Episodic Memory hook, and press t to trust it again.';
        case 'not_found':
            return 'not found; confirm the Episodic Memory plugin is installed and enabled.';
        case 'unknown':
            return 'unknown; could not inspect Codex hooks. Open /hooks in Codex to verify trust.';
    }
}
/**
 * Build the report that checks the Codex setup from the collected values.
 *
 * The function parses the Codex version, the feature flags and the MCP server list. The function reads no file and runs no command. `ok` is true when no issue was found.
 */
export function buildCodexDoctorReport(inputs) {
    const version = parseCodexCliVersion(inputs.codexVersionOutput);
    const versionOk = version !== undefined && versionMeetsMinimum(version);
    const pluginHooksEnabled = parseFeatureState(inputs.featuresOutput, 'plugin_hooks');
    const pluginsEnabled = parseFeatureState(inputs.featuresOutput, 'plugins');
    const mcpState = parseMcpState(inputs.mcpListOutput);
    const issues = [];
    if (!versionOk) {
        issues.push(`Codex must be upgraded with codex update (minimum ${MIN_CODEX_VERSION}).`);
    }
    if (pluginsEnabled === false) {
        issues.push('Codex plugins are disabled; run codex features enable plugins.');
    }
    if (pluginHooksEnabled !== true) {
        issues.push('Codex plugin hooks are not enabled; run codex features enable plugin_hooks.');
    }
    if (!inputs.sessionsDirExists) {
        issues.push('Codex sessions directory does not exist yet; start at least one Codex session.');
    }
    if (mcpState !== 'enabled') {
        issues.push('Episodic Memory MCP server is not enabled in codex mcp list.');
    }
    if (inputs.hookTrustState === 'untrusted' || inputs.hookTrustState === 'modified') {
        issues.push('Episodic Memory Codex hook is not trusted; open /hooks in Codex and press t to trust it.');
    }
    else if (inputs.hookTrustState === 'not_found') {
        issues.push('Episodic Memory Codex hook was not found; confirm the plugin is installed and enabled.');
    }
    else if (inputs.hookTrustState === 'unknown') {
        issues.push('Episodic Memory Codex hook trust could not be verified.');
    }
    const lines = [
        'Episodic Memory Codex Doctor',
        '================================',
        '',
        `Codex version: ${inputs.codexVersionOutput.trim() || '(not found)'} ${versionOk ? `(ok; minimum ${MIN_CODEX_VERSION})` : `(requires minimum ${MIN_CODEX_VERSION})`}`,
        `Codex home: ${inputs.codexHome}`,
        `Codex sessions: ${inputs.sessionsDirExists ? 'found' : 'missing'}`,
        `Plugins feature: ${pluginsEnabled === true ? 'enabled' : pluginsEnabled === false ? 'disabled' : 'unknown'}`,
        `Plugin hooks feature: ${pluginHooksEnabled === true ? 'enabled' : pluginHooksEnabled === false ? 'disabled' : 'unknown'}`,
        `Episodic Memory MCP: ${mcpState}`,
        `Index database: ${inputs.dbPath}`,
        `Hook/background sync log: ${inputs.logPath}`,
        '',
        `Hook trust: ${formatHookTrustState(inputs.hookTrustState)}`,
    ];
    if (issues.length > 0) {
        lines.push('', 'Issues:');
        for (const issue of issues) {
            lines.push(`- ${issue}`);
        }
    }
    return {
        ok: issues.length === 0,
        text: `${lines.join('\n')}\n`,
    };
}
/**
 * Return the last `limit` lines of a log file that contain `[error]`.
 *
 * Each line is trimmed before the match. The function returns an empty array when the file is missing or cannot be read. The default `limit` is 5.
 */
export function readRecentLogErrors(logPath, limit = 5) {
    if (!fs.existsSync(logPath))
        return [];
    try {
        const text = fs.readFileSync(logPath, 'utf-8');
        return text
            .split(/\r?\n/)
            .map((line) => line.trim())
            .filter((line) => line.includes('[error]'))
            .slice(-limit);
    }
    catch {
        return [];
    }
}
/**
 * Collect the inputs of `buildDoctorReport` from the file system, the index and the environment.
 *
 * When the index database file exists, the function opens it with `initDatabase`, which runs the migrations. The function reads the exchange and embedding counts from that handle. A count that cannot be read stays undefined. The function also reads the recent hook errors and the learn section.
 *
 * The plugin root is `CLAUDE_PLUGIN_ROOT`. When that variable is empty or unset, the function uses `PLUGIN_ROOT`.
 */
export async function collectDoctorSnapshot() {
    const configDir = getSuperpowersDir();
    const archiveDir = getArchiveDir();
    const indexDir = getIndexDir();
    const dbPath = getDbPath();
    const dbExists = fs.existsSync(dbPath);
    let dbSizeBytes;
    let exchangeCount;
    let conversationCount;
    let staleEmbeddingCount;
    if (dbExists) {
        try {
            dbSizeBytes = fs.statSync(dbPath).size;
            const db = initDatabase();
            try {
                exchangeCount = db.prepare('SELECT COUNT(*) as c FROM exchanges').get().c;
                conversationCount = db.prepare('SELECT COUNT(DISTINCT archive_path) as c FROM exchanges').get().c;
                staleEmbeddingCount = countStale(db);
            }
            finally {
                db.close();
            }
        }
        catch {
            // Best-effort: leave counts undefined if the DB can't be opened.
        }
    }
    const pluginRoot = process.env.CLAUDE_PLUGIN_ROOT || process.env.PLUGIN_ROOT;
    let nodeModulesHealthy = 'unknown';
    if (pluginRoot) {
        nodeModulesHealthy = nodeModulesIsHealthy(path.join(pluginRoot, 'node_modules'));
    }
    const syncErrorsLogPath = getSyncErrorsLogPath();
    return {
        configDir,
        archiveDir,
        archiveExists: fs.existsSync(archiveDir),
        indexDir,
        dbPath,
        dbExists,
        dbSizeBytes,
        exchangeCount,
        conversationCount,
        currentEmbeddingVersion: EMBEDDING_VERSION,
        staleEmbeddingCount,
        syncLogPath: getSyncLogPath(),
        syncErrorsLogPath,
        recentSyncErrors: readRecentLogErrors(syncErrorsLogPath, 5),
        nodeModulesHealthy,
        pluginRoot,
        learn: await collectLearnDoctorSection(),
    };
}
/** A byte count as `12.3 KB` / `4.1 MB`, or `n/a`. */
function formatBytes(bytes) {
    if (bytes === null)
        return 'n/a';
    if (bytes >= 1024 * 1024)
        return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    return `${(bytes / 1024).toFixed(1)} KB`;
}
/**
 * The learn section's text.
 *
 * The result is empty when doctor was not given the section.
 * A caller that cannot reach the learn modules does not give the section.
 * So the report shape stays the same either way.
 */
function learnTextLines(learn) {
    if (learn === undefined)
        return [];
    const lines = ['Learn (Recursa):'];
    lines.push(`  learned dir: ${learn.learnedDir} (${learn.present ? 'found' : 'absent'})`);
    if (learn.present) {
        lines.push(`  knowledge.db: ${formatBytes(learn.knowledgeDbSizeBytes)}`);
        lines.push(`  learning.sqlite: ${formatBytes(learn.learningDbSizeBytes)}`);
    }
    const total = Object.values(learn.entryCounts).reduce((sum, statuses) => sum + Object.values(statuses).reduce((a, b) => a + b, 0), 0);
    lines.push(`  entries: ${total}`);
    for (const kind of ['instruction', 'skill', 'reflection']) {
        const counts = learn.entryCounts[kind];
        lines.push(`    ${kind}: ${counts.active} active, ${counts.candidate} candidate, ${counts.retired} retired`);
    }
    lines.push(`  candidates awaiting approval: ${learn.candidatesAwaitingApproval}`);
    lines.push(learn.latestRun === null
        ? '  latest run: none'
        : `  latest run: ${learn.latestRun.id} (${learn.latestRun.phase}, ${learn.latestRun.status})` +
            ` · ${learn.latestRun.metrics}`);
    lines.push(`  unresolved sources: ${learn.unresolvedSources.length}`);
    for (const entry of learn.unresolvedSources) {
        lines.push(`    ${entry.id}: ${entry.sources} missing exchange id(s)`);
    }
    lines.push(`  learned-skills: ${learn.exportTree.present ? 'found' : 'absent'} (${learn.exportTree.files} file(s), ${formatBytes(learn.exportTree.bytes)})`);
    lines.push(formatSqliteLine(learn.sqliteVersion, process.version));
    return lines;
}
/**
 * Format the node:sqlite line of the doctor report.
 *
 * Below the Node floor the line starts with FAIL and names the floor, because the adapter refuses to open a database there.
 *
 * @param sqliteVersion The SQLite version that node:sqlite reports, or null when no database opened.
 * @param nodeVersion The Node version, as `process.version` gives it.
 */
export function formatSqliteLine(sqliteVersion, nodeVersion) {
    const floor = assertNodeFloor(nodeVersion.replace(/^v/, ''));
    if (floor)
        return `  node:sqlite: FAIL ${floor}`;
    return `  node:sqlite: SQLite ${sqliteVersion ?? 'unavailable'}, Node ${nodeVersion}`;
}
/**
 * Build the doctor report from a snapshot of the installation.
 *
 * A missing archive or index database, a recent hook error and an incomplete `node_modules` folder are issues. A stale embedding version and an unresolved learned source are warnings. `ok` is true when no issue was found. Warnings do not change `ok`.
 */
export function buildDoctorReport(inputs) {
    const issues = [];
    const warnings = [];
    if (!inputs.archiveExists) {
        issues.push('Conversation archive directory is missing; run episodic-memory sync.');
    }
    if (!inputs.dbExists) {
        issues.push('Index database not found; run episodic-memory sync.');
    }
    if (inputs.staleEmbeddingCount !== undefined && inputs.staleEmbeddingCount > 0) {
        warnings.push(`${inputs.staleEmbeddingCount} exchange(s) still on an old embedding version (current ${inputs.currentEmbeddingVersion}); next sync will migrate a batch.`);
    }
    if (inputs.recentSyncErrors.length > 0) {
        issues.push(`${inputs.recentSyncErrors.length} recent SessionStart hook error(s) in ${inputs.syncErrorsLogPath}.`);
    }
    if (inputs.nodeModulesHealthy === false) {
        issues.push(`Plugin node_modules is incomplete at ${inputs.pluginRoot}. Run npm install --omit=dev --no-audit --no-fund in the plugin root. When the onnxruntime-node binding is missing, delete node_modules/onnxruntime-node first.`);
    }
    const learn = inputs.learn;
    if (learn !== undefined && learn.present) {
        if (learn.unresolvedSources.length > 0) {
            warnings.push(`${learn.unresolvedSources.length} learned entr${learn.unresolvedSources.length === 1 ? 'y cites' : 'ies cite'} exchange id(s) the index no longer has; re-run \`learn tasks --check\` or retire it.`);
        }
    }
    const dbSize = inputs.dbSizeBytes !== undefined
        ? `${(inputs.dbSizeBytes / 1024).toFixed(1)} KB`
        : 'n/a';
    const lines = [
        'Episodic Memory Doctor',
        '======================',
        '',
        `Config dir: ${inputs.configDir}`,
        `Archive: ${inputs.archiveDir} (${inputs.archiveExists ? 'found' : 'missing'})`,
        `Index dir: ${inputs.indexDir}`,
        `Database: ${inputs.dbPath} (${inputs.dbExists ? 'found' : 'missing'}; ${dbSize})`,
        `Exchanges: ${inputs.exchangeCount ?? 'n/a'}`,
        `Conversations: ${inputs.conversationCount ?? 'n/a'}`,
        `Embedding version: ${inputs.currentEmbeddingVersion}` +
            (inputs.staleEmbeddingCount !== undefined
                ? ` (${inputs.staleEmbeddingCount} stale)`
                : ''),
        `Sync log: ${inputs.syncLogPath}`,
        `Hook errors log: ${inputs.syncErrorsLogPath}`,
        `Plugin root: ${inputs.pluginRoot || '(unknown)'}`,
        `node_modules: ${inputs.nodeModulesHealthy === true
            ? 'healthy'
            : inputs.nodeModulesHealthy === false
                ? 'unhealthy'
                : 'unknown'}`,
    ];
    const learnLines = learnTextLines(learn);
    if (inputs.recentSyncErrors.length > 0) {
        lines.push('', 'Recent hook errors:');
        for (const err of inputs.recentSyncErrors) {
            lines.push(`- ${err}`);
        }
    }
    if (learnLines.length > 0) {
        lines.push('', ...learnLines);
    }
    if (warnings.length > 0) {
        lines.push('', 'Warnings:');
        for (const warning of warnings) {
            lines.push(`- ${warning}`);
        }
    }
    if (issues.length > 0) {
        lines.push('', 'Issues:');
        for (const issue of issues) {
            lines.push(`- ${issue}`);
        }
    }
    const json = {
        ok: issues.length === 0,
        configDir: inputs.configDir,
        archiveDir: inputs.archiveDir,
        archiveExists: inputs.archiveExists,
        indexDir: inputs.indexDir,
        dbPath: inputs.dbPath,
        dbExists: inputs.dbExists,
        dbSizeBytes: inputs.dbSizeBytes,
        exchangeCount: inputs.exchangeCount,
        conversationCount: inputs.conversationCount,
        currentEmbeddingVersion: inputs.currentEmbeddingVersion,
        staleEmbeddingCount: inputs.staleEmbeddingCount,
        syncLogPath: inputs.syncLogPath,
        syncErrorsLogPath: inputs.syncErrorsLogPath,
        recentSyncErrors: inputs.recentSyncErrors,
        nodeModulesHealthy: inputs.nodeModulesHealthy,
        pluginRoot: inputs.pluginRoot,
        warnings,
        issues,
    };
    if (learn !== undefined)
        json.learn = learn;
    return {
        ok: issues.length === 0,
        text: `${lines.join('\n')}\n`,
        json,
    };
}
