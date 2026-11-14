import type { CodexHookTrustState } from './codex-hook-trust.js';
import { type LearnDoctorSection } from './doctor-learn.js';
/**
 * The values that `buildCodexDoctorReport` checks.
 *
 * The caller collects these values. The function uses them as given and reads no file.
 */
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
/**
 * The printable result of a doctor check.
 *
 * `ok` is true when the check found no issue. `text` is the report that people read.
 */
export interface DoctorReport {
    ok: boolean;
    text: string;
}
/**
 * Build the report that checks the Codex setup from the collected values.
 *
 * The function parses the Codex version, the feature flags and the MCP server list. The function reads no file and runs no command. `ok` is true when no issue was found.
 */
export declare function buildCodexDoctorReport(inputs: CodexDoctorInputs): DoctorReport;
/** The embedding model section of the doctor report: the folder, its state and the failed-download marker. */
export interface ModelDoctorSection {
    dir: string;
    state: 'ready' | 'missing';
    bad: string[];
    fetchFailed: boolean;
}
/**
 * The values that `buildDoctorReport` checks.
 *
 * `collectDoctorSnapshot` collects these values. Optional values stay undefined when they cannot be read. The `learn` and `model` sections stay absent when they were not collected.
 */
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
    /** The embedding model section. Absent means "not collected". */
    model?: ModelDoctorSection;
}
/**
 * A doctor report with its findings as text and as structured data.
 *
 * `json` holds the findings as data for scripts. Its `ok` field has the same value as the `ok` field of the report.
 */
export interface StructuredDoctorReport extends DoctorReport {
    json: Record<string, unknown>;
}
/**
 * Return the last `limit` lines of a log file that contain `[error]`.
 *
 * Each line is trimmed before the match. The function returns an empty array when the file is missing or cannot be read. The default `limit` is 5.
 */
export declare function readRecentLogErrors(logPath: string, limit?: number): string[];
/**
 * Collect the inputs of `buildDoctorReport` from the file system, the index and the environment.
 *
 * When the index database file exists, the function opens it with `initDatabase`, which runs the migrations. The function reads the exchange and embedding counts from that handle. A count that cannot be read stays undefined. The function also reads the recent hook errors and the learn section.
 *
 * The plugin root is `CLAUDE_PLUGIN_ROOT`. When that variable is empty or unset, the function uses `PLUGIN_ROOT`.
 */
export declare function collectDoctorSnapshot(): Promise<DoctorInputs>;
/**
 * Format the node:sqlite line of the doctor report.
 *
 * Below the Node floor the line starts with FAIL and names the floor, because the adapter refuses to open a database there.
 *
 * @param sqliteVersion The SQLite version that node:sqlite reports, or null when no database opened.
 * @param nodeVersion The Node version, as `process.version` gives it.
 */
export declare function formatSqliteLine(sqliteVersion: string | null, nodeVersion: string): string;
/**
 * Build the doctor report from a snapshot of the installation.
 *
 * A missing archive or index database, a recent hook error and an incomplete `node_modules` folder are issues. A stale embedding version and an unresolved learned source are warnings. `ok` is true when no issue was found. Warnings do not change `ok`.
 */
export declare function buildDoctorReport(inputs: DoctorInputs): StructuredDoctorReport;
