import fs from 'fs';
import path from 'path';
import {
  MIN_CODEX_VERSION,
  parseCodexCliVersion,
  versionMeetsMinimum,
} from './codex-support.js';
import type { CodexHookTrustState } from './codex-hook-trust.js';
import { EMBEDDING_VERSION, countStale } from './embedding-migration.js';
import { initDatabase } from './db.js';
import {
  getArchiveDir,
  getDbPath,
  getIndexDir,
  getSuperpowersDir,
} from './paths.js';
import { getSyncErrorsLogPath, getSyncLogPath } from './logging.js';
import { nodeModulesIsHealthy } from './deps-health.js';
import { type LearnDoctorSection, collectLearnDoctorSection } from './doctor-learn.js';

export interface CodexDoctorInputs {
  codexVersionOutput: string;
  featuresOutput: string;
  mcpListOutput: string;
  codexHome: string;
  sessionsDirExists: boolean;
  logPath: string;
  dbPath: string;
  hookTrustState: CodexHookTrustState;
}

export interface DoctorReport {
  ok: boolean;
  text: string;
}

function parseFeatureState(featuresOutput: string, feature: string): boolean | undefined {
  const line = featuresOutput
    .split(/\r?\n/)
    .map(entry => entry.trim())
    .find(entry => entry.startsWith(`${feature} `));
  if (!line) {
    return undefined;
  }
  const lastColumn = line.split(/\s+/).at(-1);
  if (lastColumn === 'true') return true;
  if (lastColumn === 'false') return false;
  return undefined;
}

function parseMcpState(mcpListOutput: string): 'enabled' | 'disabled' | 'missing' {
  const line = mcpListOutput
    .split(/\r?\n/)
    .map(entry => entry.trim())
    .find(entry => entry.startsWith('episodic-memory '));
  if (!line) {
    return 'missing';
  }
  return line.includes(' enabled') ? 'enabled' : 'disabled';
}

function formatHookTrustState(hookTrustState: CodexHookTrustState): string {
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

export function buildCodexDoctorReport(inputs: CodexDoctorInputs): DoctorReport {
  const version = parseCodexCliVersion(inputs.codexVersionOutput);
  const versionOk = version !== undefined && versionMeetsMinimum(version);
  const pluginHooksEnabled = parseFeatureState(inputs.featuresOutput, 'plugin_hooks');
  const pluginsEnabled = parseFeatureState(inputs.featuresOutput, 'plugins');
  const mcpState = parseMcpState(inputs.mcpListOutput);

  const issues: string[] = [];
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
  } else if (inputs.hookTrustState === 'not_found') {
    issues.push('Episodic Memory Codex hook was not found; confirm the plugin is installed and enabled.');
  } else if (inputs.hookTrustState === 'unknown') {
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

export interface DoctorInputs {
  configDir: string;
  archiveDir: string;
  archiveExists: boolean;
  indexDir: string;
  dbPath: string;
  dbExists: boolean;
  dbSizeBytes?: number;
  exchangeCount?: number;
  conversationCount?: number;
  currentEmbeddingVersion: number;
  staleEmbeddingCount?: number;
  syncLogPath: string;
  syncErrorsLogPath: string;
  recentSyncErrors: string[];
  nodeModulesHealthy?: boolean | 'unknown';
  pluginRoot?: string;
  /** The Recursa `learn` section. Absent means "not collected". */
  learn?: LearnDoctorSection;
}

export interface StructuredDoctorReport extends DoctorReport {
  json: Record<string, unknown>;
}

export function readRecentLogErrors(logPath: string, limit = 5): string[] {
  if (!fs.existsSync(logPath)) return [];
  try {
    const text = fs.readFileSync(logPath, 'utf-8');
    return text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.includes('[error]'))
      .slice(-limit);
  } catch {
    return [];
  }
}

export async function collectDoctorSnapshot(): Promise<DoctorInputs> {
  const configDir = getSuperpowersDir();
  const archiveDir = getArchiveDir();
  const indexDir = getIndexDir();
  const dbPath = getDbPath();
  const dbExists = fs.existsSync(dbPath);

  let dbSizeBytes: number | undefined;
  let exchangeCount: number | undefined;
  let conversationCount: number | undefined;
  let staleEmbeddingCount: number | undefined;

  if (dbExists) {
    try {
      dbSizeBytes = fs.statSync(dbPath).size;
      const db = initDatabase();
      try {
        exchangeCount = (db.prepare('SELECT COUNT(*) as c FROM exchanges').get() as { c: number }).c;
        conversationCount = (
          db.prepare('SELECT COUNT(DISTINCT archive_path) as c FROM exchanges').get() as { c: number }
        ).c;
        staleEmbeddingCount = countStale(db);
      } finally {
        db.close();
      }
    } catch {
      // Best-effort: leave counts undefined if the DB can't be opened.
    }
  }

  const pluginRoot = process.env.CLAUDE_PLUGIN_ROOT || process.env.PLUGIN_ROOT;
  let nodeModulesHealthy: boolean | 'unknown' = 'unknown';
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
function formatBytes(bytes: number | null): string {
  if (bytes === null) return 'n/a';
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / 1024).toFixed(1)} KB`;
}

/**
 * The learn section's text.
 *
 * Empty when doctor was not given the section (a caller that cannot reach the
 * learn modules), so the report shape stays the same either way.
 */
function learnTextLines(learn: LearnDoctorSection | undefined): string[] {
  if (learn === undefined) return [];

  const lines: string[] = ['Learn (Recursa):'];
  lines.push(`  learned dir: ${learn.learnedDir} (${learn.present ? 'found' : 'absent'})`);
  if (learn.present) {
    lines.push(`  knowledge.db: ${formatBytes(learn.knowledgeDbSizeBytes)}`);
    lines.push(`  learning.sqlite: ${formatBytes(learn.learningDbSizeBytes)}`);
  }

  const total = Object.values(learn.entryCounts).reduce(
    (sum, statuses) =>
      sum + Object.values(statuses as Record<string, number>).reduce((a, b) => a + b, 0),
    0
  );
  lines.push(`  entries: ${total}`);
  for (const kind of ['instruction', 'skill', 'reflection'] as const) {
    const counts = learn.entryCounts[kind];
    lines.push(
      `    ${kind}: ${counts.active} active, ${counts.candidate} candidate, ${counts.retired} retired`
    );
  }

  lines.push(`  candidates awaiting approval: ${learn.candidatesAwaitingApproval}`);
  lines.push(
    learn.latestRun === null
      ? '  latest run: none'
      : `  latest run: ${learn.latestRun.id} (${learn.latestRun.phase}, ${learn.latestRun.status})` +
          ` · ${learn.latestRun.metrics}`
  );

  lines.push(`  unresolved sources: ${learn.unresolvedSources.length}`);
  for (const entry of learn.unresolvedSources) {
    lines.push(`    ${entry.id}: ${entry.sources} missing exchange id(s)`);
  }

  lines.push(
    `  learned-skills: ${learn.exportTree.present ? 'found' : 'absent'} (${learn.exportTree.files} file(s), ${formatBytes(learn.exportTree.bytes)})`
  );
  lines.push(`  better-sqlite3: ${learn.betterSqlite3TopLevel ?? 'unresolved'}`);
  return lines;
}

export function buildDoctorReport(inputs: DoctorInputs): StructuredDoctorReport {
  const issues: string[] = [];
  const warnings: string[] = [];

  if (!inputs.archiveExists) {
    issues.push('Conversation archive directory is missing; run episodic-memory sync.');
  }
  if (!inputs.dbExists) {
    issues.push('Index database not found; run episodic-memory sync.');
  }
  if (inputs.staleEmbeddingCount !== undefined && inputs.staleEmbeddingCount > 0) {
    warnings.push(
      `${inputs.staleEmbeddingCount} exchange(s) still on an old embedding version (current ${inputs.currentEmbeddingVersion}); next sync will migrate a batch.`
    );
  }
  if (inputs.recentSyncErrors.length > 0) {
    issues.push(
      `${inputs.recentSyncErrors.length} recent SessionStart hook error(s) in ${inputs.syncErrorsLogPath}.`
    );
  }
  if (inputs.nodeModulesHealthy === false) {
    issues.push(
      `Plugin node_modules is incomplete at ${inputs.pluginRoot}; run npm install in the plugin root.`
    );
  }

  const learn = inputs.learn;
  if (learn !== undefined && learn.present) {
    if (learn.unresolvedSources.length > 0) {
      warnings.push(
        `${learn.unresolvedSources.length} learned entr${learn.unresolvedSources.length === 1 ? 'y cites' : 'ies cite'} exchange id(s) the index no longer has; re-run \`learn tasks --check\` or retire it.`
      );
    }
  }

  const dbSize =
    inputs.dbSizeBytes !== undefined
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
    `node_modules: ${
      inputs.nodeModulesHealthy === true
        ? 'healthy'
        : inputs.nodeModulesHealthy === false
          ? 'unhealthy'
          : 'unknown'
    }`,
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

  const json: Record<string, unknown> = {
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
  if (learn !== undefined) json.learn = learn;

  return {
    ok: issues.length === 0,
    text: `${lines.join('\n')}\n`,
    json,
  };
}
