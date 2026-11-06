/**
 * The learning trace: runs, tasks and attempts, in `learning.sqlite`.
 *
 * `learning.sqlite` is the plugin's own database (spec §5.3), beside the
 * knowledge store (`knowledge.db`) under `learned/`. This module owns the three
 * `learning_*` tables; `learning-store.ts` owns the file and calls
 * `ensureLearningSchema` from `migrateLearningSchema`.
 *
 * Two invariants shape the read paths:
 *
 * - `listTasks` is the **only** way tasks are read, and its `split` argument is
 *   mandatory. The `test` split is excluded from every learner prompt by this
 *   SQL predicate, never by convention (spec §7 rule 13).
 * - A `stale` task is excluded from reads and from every metric. A task going
 *   stale means its source address no longer resolves (a re-indexed session, a
 *   pruned project); scoring it as a failure would punish a solver for a moved
 *   file.
 *
 * Additive only: nothing here deletes a run, task or attempt.
 */
import type Database from 'better-sqlite3';
import type { AttemptOutcome, AttemptRow, LearningKind, LearningTier, TaskStatus, TaskTruth } from './types.js';
/** One generated task, as `learning_task` stores it. */
export interface LearningTask {
    id: number;
    runId: string;
    kind: LearningKind;
    tier: LearningTier;
    split: 'train' | 'test';
    project: string;
    prompt: string;
    truth: TaskTruth;
    status: TaskStatus;
}
/** One run's rejection, as `learn report` prints it. */
export interface RunRejection {
    slug: string;
    reason: string;
}
/** `learning_run`, as read back. */
export interface LearningRun {
    id: string;
    phase: 'bootstrap' | 'improve';
    parentRunId: string | null;
    project: string | null;
    status: 'running' | 'done' | 'stopped' | 'failed' | 'deferred';
    startedAt: string;
    finishedAt: string | null;
    budget: Record<string, unknown>;
    metrics: Record<string, unknown>;
    seed: number | null;
    rejections: RunRejection[];
}
export interface CreateRunInput {
    phase: 'bootstrap' | 'improve';
    parentRunId?: string;
    project?: string;
    seed: number;
    budget: Record<string, unknown>;
}
export interface ListTasksOptions {
    split: 'train' | 'test';
    project?: string;
    kinds?: LearningKind[];
    tiers?: LearningTier[];
    ids?: number[];
    /** Include rows `checkTasks` marked stale. Default false. */
    includeStale?: boolean;
}
export interface ListAttemptsOptions {
    runId: string;
    taskIds?: number[];
    role?: AttemptRow['role'];
    /** Only this outcome. `'graded'` is the common case: only graded attempts count. */
    outcome?: AttemptOutcome;
}
export interface PassRate {
    passed: number;
    total: number;
    meanTurns: number;
    usd: number;
    byKindTier: Record<string, {
        passed: number;
        total: number;
    }>;
}
/** The kinds and tiers that carry the learning signal (spec §4.4, §7 rule 5). */
export declare const SIGNAL_KINDS: LearningKind[];
export declare const SIGNAL_TIERS: LearningTier[];
/** Create the `learning_*` tables. Idempotent; called from `migrateLearningSchema`. */
export declare function ensureLearningSchema(db: Database.Database): void;
export declare function createRun(db: Database.Database, input: CreateRunInput): string;
export declare function finishRun(db: Database.Database, id: string, status: LearningRun['status'], metrics?: Record<string, unknown>): void;
export declare function addRejection(db: Database.Database, runId: string, rejection: RunRejection): void;
export declare function getRun(db: Database.Database, id: string): LearningRun | null;
/** The newest run by start time, or null when none exists. */
export declare function latestRun(db: Database.Database): LearningRun | null;
export declare function insertTask(db: Database.Database, task: Omit<LearningTask, 'id'>): number;
/**
 * The only task read path.
 *
 * `split` is mandatory, so no caller can accidentally hand a learner the
 * held-out split. Stale rows are excluded unless `includeStale` is set (the
 * `--check` command and `learn report` want to see them).
 */
export declare function listTasks(db: Database.Database, options: ListTasksOptions): LearningTask[];
/** Mark tasks stale. Additive: the row stays, and `includeStale` can still read it. */
export declare function markStale(db: Database.Database, ids: number[]): void;
/** `learning_attempt.answer` is redacted and capped, so one runaway answer cannot bloat the trace. */
export declare const MAX_ANSWER_CHARS = 4000;
export declare function insertAttempt(db: Database.Database, attempt: Omit<AttemptRow, 'id' | 'createdAt'>): number;
export declare function listAttempts(db: Database.Database, options: ListAttemptsOptions): AttemptRow[];
/** True only when every id names a stored attempt (and the list is non-empty). */
export declare function attemptsExist(db: Database.Database, ids: number[]): boolean;
/**
 * The pass rate of one snapshot of one run.
 *
 * Counts the **newest graded attempt per task**, so a task re-solved later in the
 * round supersedes its own earlier attempt rather than double-counting. Tasks
 * from the other split and stale tasks never contribute. `signalOnly` restricts
 * the count to `locate`/`when`/`multi` at tiers 2 and 3 — the metric that
 * decides whether an edit is kept (spec §7 rule 5).
 */
export declare function passRate(db: Database.Database, runId: string, snapshotId: number, options: {
    split: 'train' | 'test';
    signalOnly: boolean;
}): PassRate;
