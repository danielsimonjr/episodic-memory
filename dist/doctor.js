import fs from 'fs';
import path from 'path';
import { MIN_CODEX_VERSION, parseCodexCliVersion, versionMeetsMinimum, } from './codex-support.js';
import { EMBEDDING_VERSION, countStale } from './embedding-migration.js';
import { initDatabase } from './db.js';
import { getArchiveDir, getDbPath, getIndexDir, getSuperpowersDir, } from './paths.js';
import { getSyncErrorsLogPath, getSyncLogPath } from './logging.js';
import { nodeModulesIsHealthy } from './deps-health.js';
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
export function collectDoctorSnapshot() {
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
    };
}
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
        issues.push(`Plugin node_modules is incomplete at ${inputs.pluginRoot}; run npm install in the plugin root.`);
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
    if (inputs.recentSyncErrors.length > 0) {
        lines.push('', 'Recent hook errors:');
        for (const err of inputs.recentSyncErrors) {
            lines.push(`- ${err}`);
        }
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
    return {
        ok: issues.length === 0,
        text: `${lines.join('\n')}\n`,
        json,
    };
}
