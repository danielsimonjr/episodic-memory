/**
 * The `learn` section of `episodic-memory doctor`.
 *
 * Kept apart from `doctor.ts` because collecting it needs a read-only peek at
 * the learning trace and the knowledge store, while `doctor.ts` stays importable
 * from a context with neither. `collectLearnDoctorSection()` is best-effort
 * throughout: a missing or half-written `learned/` is something to *report*,
 * never a reason for doctor itself to fail.
 */
import type { KnowledgeKind, KnowledgeStatus } from './learn/types.js';
/** Counts per `<kind>:<status>`, in a stable order. */
export interface LearnEntryCounts {
    instruction: Record<KnowledgeStatus, number>;
    skill: Record<KnowledgeStatus, number>;
    reflection: Record<KnowledgeStatus, number>;
}
/**
 * The most recent learning run, as the doctor report shows that run.
 */
export interface LearnLatestRunSummary {
    id: string;
    phase: string;
    status: string;
    /** `train: 3/5 → 4/5, test: 1/2` or similar; absent metrics read as `n/a`. */
    metrics: string;
}
/**
 * The `learn` section of the doctor report.
 *
 * `collectLearnDoctorSection` fills this section. `emptyLearnSection` builds one that reports nothing found.
 */
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
    /** The SQLite version that node:sqlite reports, or null when the probe fails. */
    sqliteVersion: string | null;
}
/**
 * Returns a section that reports nothing found. The `learnedDir` field contains the given path.
 *
 * `collectLearnDoctorSection` starts from this section and fills in each value that the function finds.
 *
 * @param learnedDir The `learned` directory to report. Empty when `collectLearnDoctorSection` finds no value.
 */
export declare function emptyLearnSection(learnedDir?: string): LearnDoctorSection;
/**
 * Collect the learn section.
 *
 * Never throws: every probe is wrapped, and a failure leaves that field at its
 * empty value. The caller decides whether `present` or a resolution mismatch is
 * a warning.
 */
export declare function collectLearnDoctorSection(): Promise<LearnDoctorSection>;
