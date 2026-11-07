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
 * - `listTasks` is the **only** read path for tasks, and its `split` argument is
 *   mandatory. The SQL predicate keeps the `test` split out of every learner
 *   prompt, never by convention (spec §7 rule 13).
 * - The reads and every metric skip a `stale` task. A task goes stale when its
 *   source address does not resolve (a re-indexed session, a pruned project).
 *   Scoring it as a failure punishes a solver for a moved file.
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
/** The input of createRun. */
export interface CreateRunInput {
    phase: 'bootstrap' | 'improve';
    /** The id of the parent run. Stored as NULL when omitted. */
    parentRunId?: string;
    /** The project that the run covers. Stored as NULL when omitted. */
    project?: string;
    seed: number;
    /** The budget of the run. Stored as JSON. */
    budget: Record<string, unknown>;
}
/** Options for listTasks. */
export interface ListTasksOptions {
    split: 'train' | 'test';
    project?: string;
    kinds?: LearningKind[];
    tiers?: LearningTier[];
    ids?: number[];
    /** Include rows `checkTasks` marked stale. Default false. */
    includeStale?: boolean;
}
/** Options for listAttempts. */
export interface ListAttemptsOptions {
    runId: string;
    /** Only the attempts of these tasks. An empty list returns no attempts. */
    taskIds?: number[];
    role?: AttemptRow['role'];
    /** Only this outcome. `'graded'` is the common case: only graded attempts count. */
    outcome?: AttemptOutcome;
}
/**
 * The pass counts and cost of one run on one snapshot.
 *
 * Each task counts once, from its latest graded attempt. `byKindTier` uses the key `kind:tier`.
 */
export interface PassRate {
    /** The number of counted tasks that passed. */
    passed: number;
    /** The number of counted tasks. */
    total: number;
    /** The mean number of turns per counted task. Zero when no task counts. */
    meanTurns: number;
    /** The sum of the recorded cost in US dollars. */
    usd: number;
    /** The pass counts for each `kind:tier` cell. */
    byKindTier: Record<string, {
        passed: number;
        total: number;
    }>;
}
/**
 * The task kinds that carry the learning signal (spec §4.4, §7 rule 5).
 * `passRate` uses them when the caller sets `signalOnly`. Callers of `listTasks` pass them to select the training tasks.
 */
export declare const SIGNAL_KINDS: LearningKind[];
/** The task tiers that carry the learning signal. `passRate` uses them when the caller sets `signalOnly`. Callers of `listTasks` pass them with `SIGNAL_KINDS`. */
export declare const SIGNAL_TIERS: LearningTier[];
/** Create the `learning_*` tables. Idempotent; called from `migrateLearningSchema`. */
export declare function ensureLearningSchema(db: Database.Database): void;
/**
 * Create a run in the `running` state and return its id.
 *
 * The function sets the start time to the current time and stores the budget as JSON.
 */
export declare function createRun(db: Database.Database, input: CreateRunInput): string;
/**
 * Set the status of a run, its finish time and its metrics.
 *
 * The function sets the finish time to the current time and stores the metrics as JSON.
 */
export declare function finishRun(db: Database.Database, id: string, status: LearningRun['status'], metrics?: Record<string, unknown>): void;
/**
 * Append one rejection to the rejections list of a run.
 *
 * The function does nothing when no run has the id.
 */
export declare function addRejection(db: Database.Database, runId: string, rejection: RunRejection): void;
/** Return the run with this id, or null when no run has the id. */
export declare function getRun(db: Database.Database, id: string): LearningRun | null;
/** The newest run by start time, or null when none exists. */
export declare function latestRun(db: Database.Database): LearningRun | null;
/** Insert one task row and return the new task id. */
export declare function insertTask(db: Database.Database, task: Omit<LearningTask, 'id'>): number;
/**
 * The only task read path.
 *
 * `split` is mandatory, so no caller can accidentally hand a learner the
 * held-out split. The function excludes stale rows unless the caller sets
 * `includeStale`. The `--check` command and `learn report` want to see them.
 */
export declare function listTasks(db: Database.Database, options: ListTasksOptions): LearningTask[];
/** Mark tasks stale. Additive: the row stays, and `includeStale` can still read it. */
export declare function markStale(db: Database.Database, ids: number[]): void;
/** `insertAttempt` redacts `learning_attempt.answer` and shortens it to `MAX_ANSWER_CHARS` characters, so one runaway answer cannot bloat the trace. */
export declare const MAX_ANSWER_CHARS = 4000;
/**
 * Insert one attempt row and return the new attempt id.
 *
 * The function redacts the answer, caps its length and stamps the creation time.
 */
export declare function insertAttempt(db: Database.Database, attempt: Omit<AttemptRow, 'id' | 'createdAt'>): number;
/**
 * Return the attempts of one run that match the options. An empty `taskIds` list returns no attempts.
 */
export declare function listAttempts(db: Database.Database, options: ListAttemptsOptions): AttemptRow[];
/** True only when every id names a stored attempt (and the list is non-empty). */
export declare function attemptsExist(db: Database.Database, ids: number[]): boolean;
/**
 * The pass rate of one snapshot of one run.
 *
 * Counts the **newest graded attempt per task**. So a task re-solved later in the round
 * supersedes its own earlier attempt rather than double-counting. Tasks from the other split and
 * stale tasks never contribute. `signalOnly` restricts the count to `locate`/`when`/`multi` at
 * tiers 2 and 3. The metric decides whether to keep an edit (spec §7 rule 5).
 */
export declare function passRate(db: Database.Database, runId: string, snapshotId: number, options: {
    split: 'train' | 'test';
    signalOnly: boolean;
}): PassRate;
