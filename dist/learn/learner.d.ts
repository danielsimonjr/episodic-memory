/**
 * The recursive learner (spec §6.2, Algorithm 1).
 *
 * One `learn improve` run is a loop of rounds. A round is five moves:
 *
 * 1. **Solve.** Every `train` signal task is solved with the snapshot `K^(t)`.
 *    That is both the round's measurement and its failure set.
 * 2. **Split.** A single project whose failures fit `leafMax` gets one leaf
 *    learner. Otherwise the failures are cut by project, and a project still
 *    over `leafMax` is cut again by failure category — one model call whose
 *    answer is validated as a partition of exactly the failed task ids. An
 *    answer that is not a partition is discarded and the cut stays by project.
 *    Every subset becomes a child run with `parent_run_id`.
 * 3. **Learn.** The leaf learners run in parallel, bounded by `concurrency`
 *    (and by the one global subprocess semaphore underneath).
 * 4. **Merge.** The same `(kind, project, slug)` kept by two children is one
 *    entry, not two: one model call writes the merged body, which passes the
 *    same gates as any other proposal. A seeded sample of every child's signal
 *    tasks is then re-solved against the merged snapshot (`merge-check`); a
 *    child whose gains regress gets its own text back and the merged version is
 *    retired. `detectHeuristicConflicts()` names instruction lines that now
 *    contradict each other; one more model call may resolve them, and lines it
 *    cannot resolve are retired with the conflict written into the reflection.
 * 5. **Reflect.** One screened reflection per round, citing the round's attempt
 *    ids and exchange ids.
 *
 * The loop stops when a round keeps nothing, when `rounds` is reached, or when
 * the call budget is spent (`stopped`, with every validated entry kept). Only
 * then is the `test` split solved — once, with the final snapshot. No learner
 * prompt can hold a `test` task: `listTasks` is the only task read path and its
 * `split` predicate is mandatory.
 *
 * Additive only: nothing here deletes an entry, a task or an attempt. A revert
 * retires the merged version and writes the child's body again; the merged row
 * stays readable.
 */
import { type LearningTask, type PassRate } from './learning-db.js';
import { runAgent, type PidRegistry } from './agent-runner.js';
import { CallBudget, type solveTask } from './solver.js';
import type { LearnDbs } from './types.js';
/** The failure categories the split call may assign (spec §6.2 step 3). */
export declare const FAILURE_CATEGORIES: string[];
/** The slug prefix of a round's reflection. */
export declare const REFLECTION_SLUG_PREFIX = "reflection-round";
/** What one merged entry did, for the report and the reflection. */
export interface MergeRecord {
    /** `kind|project|slug`. */
    key: string;
    /** The name of the merged version. */
    merged: string;
    /** Every cited exchange id the merge unions. */
    sources: string[];
    /** The version restored when the merge regressed a child, or null. */
    revertedTo: string | null;
    /** Task ids that regressed under the merged snapshot. */
    regressions: number[];
}
/**
 * The result of one `runLearn` call.
 *
 * `status` is `done` when the run ends normally. The status is `stopped` when the call budget is used up before the run ends. A run that throws returns no result, and its run record is marked `failed` before the error reaches the caller.
 */
export interface LearnResult {
    runId: string;
    status: 'done' | 'stopped' | 'failed';
    /** Projects a child run was created for, in first-seen order. */
    projects: string[];
    /** Child run ids, in creation order. */
    children: string[];
    /** Entry names this run kept (and activated, when its kind may). */
    kept: string[];
    rejected: Array<{
        slug: string;
        reason: string;
    }>;
    merges: MergeRecord[];
    /** Names of the reflections the run wrote. */
    reflections: string[];
    /** The signal train rate before the first round and after the last. */
    before: PassRate;
    after: PassRate;
    test: PassRate;
    rounds: number;
}
/**
 * The options of `runLearn`. The learn command builds them from `learnConfig` and its arguments.
 *
 * `runAgent`, `solve` and `textModel` are test seams. `judge` scores recall answers. `leafMax` is the largest number of failed tasks that one leaf learner receives. `dryRun` starts no learner round. `seed` is recorded on each run, and its default is 1.
 */
export interface LearnOptions {
    /** Test seam: defaults to `runAgent`. */
    runAgent?: typeof runAgent;
    model?: string;
    judge?: (prompt: string) => Promise<string>;
    /** Test seam: defaults to `solveTask`. */
    solve?: typeof solveTask;
    concurrency: number;
    rounds: number;
    leafMax: number;
    project?: string;
    dryRun?: boolean;
    budget: CallBudget;
    /** Test seam: the text-only model for split, merge and reflect. */
    textModel?: (prompt: string) => Promise<string>;
    pids?: PidRegistry;
    seed?: number;
}
/** One subset of failures that becomes a leaf learner. */
export interface LearnSubset {
    project: string;
    taskIds: number[];
    category?: string;
}
/** A failed task, reduced to what the split decision needs. */
interface Failure {
    taskId: number;
    project: string;
    answer: string;
    kind: LearningTask['kind'];
}
/**
 * The category each failed task was assigned, or null when the answer is not a partition.
 *
 * A partition means every failed id appears exactly once. No id that the run did not fail on
 * appears at all. A duplicate assignment is not a partition either: a task in two subsets
 * would be solved and edited twice.
 */
export declare function parseAssignment(raw: string, failedIds: number[]): Map<number, string> | null;
/**
 * Cut the round's failures into leaf subsets.
 *
 * By project first, because a project's vocabulary is what an instruction is
 * scoped to. A project over the leaf cap is then cut by failure category, which
 * needs one model call. If that answer is not a partition, the project stays whole.
 * The reason: a bad split is worse than a big subset.
 */
export declare function splitFailures(failures: Failure[], leafMax: number, textModel: (prompt: string) => Promise<string>): Promise<LearnSubset[]>;
/**
 * Run one `learn improve`.
 *
 * Everything that would reach a model, a subprocess or a GPU is injected.
 * So a test drives the whole recursion with fakes and never leaves the process.
 */
export declare function runLearn(dbs: LearnDbs, options: LearnOptions): Promise<LearnResult>;
export {};
