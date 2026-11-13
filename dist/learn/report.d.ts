/**
 * `learn report`: what a run changed, what it cost, and what it refused.
 *
 * A report is built from the trace (`learning.sqlite`) and the store, and it is
 * deliberately blunt: the numbers a run is judged by (pass rate per split and
 * tier, before and after) sit beside the entries the run kept, the candidates a
 * human still has to approve, and every rejection with the gate that produced
 * it. A run that rejected everything is not a failure to hide — it is the
 * feature working, and the report says so in the same place it says how much
 * was spent.
 *
 * "Before" and "after" are the first and last snapshot of the run: the solver's
 * knowledge is `K^(t)`, and the two ends of the snapshot sequence are the only
 * comparison the trace can support without assuming which edit landed when. A
 * run with a single snapshot reports the same rate on both sides, because a
 * fabricated "before" of zero would read as a spectacular gain.
 */
import type { Database } from '../sqlite.js';
import { type LearningRun, type PassRate } from './learning-db.js';
import type { KnowledgeEntry, LearnDbs } from './types.js';
/** One merged entry, as `runLearn` recorded it on the run's metrics. */
export interface ReportMerge {
    key: string;
    merged: string;
    sources: string[];
    revertedTo: string | null;
    regressions: number[];
}
/** One split's rate at both ends of the run, with the per-kind-and-tier cells. */
export interface SplitReport {
    before: PassRate;
    after: PassRate;
    byKindTier: Record<string, {
        before: {
            passed: number;
            total: number;
        };
        after: {
            passed: number;
            total: number;
        };
    }>;
}
/**
 * The report of one learning run, as `buildReport` builds it.
 *
 * `kept` lists the active instructions and skills for the run's project. `pending` lists the candidates that wait for approval. `merges` lists the duplicate entries that the run merges, and any revert.
 */
export interface ReportModel {
    run: LearningRun;
    train: SplitReport;
    test: SplitReport;
    /** Active instructions and skills usable for the run's project. */
    kept: KnowledgeEntry[];
    /** Candidates still awaiting approval. */
    pending: KnowledgeEntry[];
    rejected: Array<{
        slug: string;
        reason: string;
    }>;
    budget: {
        maxCalls: number | null;
        usedCalls: number;
        maxUsd: number | null;
        usedUsd: number;
    };
    childRuns: LearningRun[];
    reflections: KnowledgeEntry[];
    /** Duplicate entries the run merged across children, and any revert. */
    merges: ReportMerge[];
}
/**
 * Build the report for one run.
 *
 * Async because the store-backed halves (`kept`, `pending`, `reflections`) come
 * from the knowledge store, whose methods return promises.
 */
export declare function buildReport(dbs: LearnDbs, runId: string): Promise<ReportModel>;
/** The latest run id, for a CLI that was given no `--run`. */
export declare function latestRunId(db: Database): string | null;
/** Render a model as a human report or as JSON. */
export declare function formatReport(model: ReportModel, json: boolean): string;
