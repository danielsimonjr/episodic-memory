/**
 * The `learn` section of `episodic-memory doctor`.
 *
 * Kept apart from `doctor.ts` because collecting it needs a read-only peek at
 * the learning trace and the memoryjs store, while `doctor.ts` stays importable
 * from a context with neither. `collectLearnDoctorSection()` is best-effort
 * throughout: a missing or half-written `learned/` is something to *report*,
 * never a reason for doctor itself to fail.
 *
 * Deliberately no audit-chain item: memoryjs records its governance chain only
 * under `MEMORY_GOVERNANCE_ENABLED=true`, which this plugin never sets, so an
 * empty chain would read as a defect when it is the normal state.
 */
import type { KnowledgeKind, KnowledgeStatus } from './learn/types.js';
/** Counts per `<kind>:<status>`, in a stable order. */
export interface LearnEntryCounts {
    instruction: Record<KnowledgeStatus, number>;
    skill: Record<KnowledgeStatus, number>;
    reflection: Record<KnowledgeStatus, number>;
}
export interface LearnLatestRunSummary {
    id: string;
    phase: string;
    status: string;
    /** `train: 3/5 → 4/5, test: 1/2` or similar; absent metrics read as `n/a`. */
    metrics: string;
}
export interface LearnDoctorSection {
    /** `learned/` exists and holds the two databases. */
    present: boolean;
    learnedDir: string;
    knowledgeDbSizeBytes: number | null;
    learningDbSizeBytes: number | null;
    entryCounts: LearnEntryCounts;
    /** Candidate instructions and skills a human still has to review. */
    candidatesAwaitingApproval: number;
    latestRun: LearnLatestRunSummary | null;
    /** Entries whose every cited exchange id is absent from the index. */
    unresolvedSources: Array<{
        id: string;
        kind: KnowledgeKind;
        sources: number;
    }>;
    /** `learned-skills/` presence and size of the exported tree. */
    exportTree: {
        present: boolean;
        files: number;
        bytes: number;
    };
    /** The top-level `better-sqlite3` copy the plugin would load. */
    betterSqlite3TopLevel: string | null;
    /**
     * The copy memoryjs would resolve to. Equal to the top-level copy when the
     * `overrides` pin did its job; a different path means a nested duplicate.
     */
    betterSqlite3FromMemoryjs: string | null;
    /** True when both resolve paths agree (or neither resolves). */
    betterSqlite3Shared: boolean;
}
export declare function emptyLearnSection(learnedDir?: string): LearnDoctorSection;
/**
 * Collect the learn section.
 *
 * Never throws: every probe is wrapped, and a failure leaves that field at its
 * empty value. The caller decides whether `present` or a resolution mismatch is
 * a warning.
 */
export declare function collectLearnDoctorSection(): Promise<LearnDoctorSection>;
