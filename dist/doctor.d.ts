import type { CodexHookTrustState } from './codex-hook-trust.js';
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
export declare function buildCodexDoctorReport(inputs: CodexDoctorInputs): DoctorReport;
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
}
export interface StructuredDoctorReport extends DoctorReport {
    json: Record<string, unknown>;
}
export declare function readRecentLogErrors(logPath: string, limit?: number): string[];
export declare function collectDoctorSnapshot(): DoctorInputs;
export declare function buildDoctorReport(inputs: DoctorInputs): StructuredDoctorReport;
