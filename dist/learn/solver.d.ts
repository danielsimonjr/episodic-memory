/**
 * The solver: answer one task with the knowledge a snapshot held.
 *
 * `solveTask` is the unit both the evaluation harness and the learner loops use.
 * Its three jobs, in order:
 *
 * 1. Build the in-process `episodic-learn` server with the task's source
 *    exchange ids hidden, so neither a search result nor a digest line can hand
 *    the solver the address it is being asked to find (spec §4.4 leak rule).
 * 2. Run the agent under the one global subprocess semaphore, inside the caller's
 *    call budget, and grade the answer with Task 4's graders.
 * 3. Store the attempt — always, including the failures: an `aborted`, `killed`
 *    or `error` attempt is evidence that the run was cut short, and the learner
 *    excludes those from diagnosis rather than scoring them as solver failures.
 *
 * The system prompt is built from the snapshot, not from the store's live view:
 * a snapshot is `K^(t)`, and a solver that saw an entry added between snapshots
 * would make the before/after comparison meaningless.
 */
import { type LearningTask } from './learning-db.js';
import type { AttemptRow, KnowledgeEntry, LearnDbs } from './types.js';
import { runAgent, type PidRegistry } from './agent-runner.js';
/**
 * Where a run records the PIDs it owns.
 *
 * Task 6 supplies the real implementation, which also writes `.learn.pids` so the
 * SessionStart orphan reaper leaves a live run's subprocesses alone. Declared
 * here because the solver is the first consumer.
 */
export type { PidRegistry };
/** The call budget is spent: the run stops and keeps everything validated so far. */
export declare class BudgetExhausted extends Error {
    readonly max: number;
    constructor(max: number);
}
/**
 * A shared counter of subprocess calls across a whole run.
 *
 * Not a semaphore: this bounds total spend, while the semaphore bounds
 * concurrency. A run needs both — one task at a time still costs a call each.
 */
export declare class CallBudget {
    readonly max: number;
    used: number;
    constructor(max: number);
    /** Take one call, or throw when the cap is already reached. */
    spend(): void;
    remaining(): number;
}
/** What `solveTask` needs beyond the task itself. */
export interface SolveOptions {
    snapshotId: number;
    runId: string;
    role: 'solve' | 'validate' | 'merge-check';
    /** Model for the solver subprocess. */
    model: string;
    pids: PidRegistry;
    /** Test seam: defaults to `runAgent`. */
    runAgent?: typeof runAgent;
    /** Judge for `recall`. Defaults to `callLearnModel`. */
    judge?: (prompt: string) => Promise<string>;
    maxTurns?: number;
    maxBudgetUsd?: number;
    timeoutMs?: number;
    /** A budget to spend one call from, when the caller keeps one. */
    budget?: CallBudget;
}
/** The instruction entries and skills index a snapshot renders into a prompt. */
export declare function promptInputsForSnapshot(dbs: LearnDbs, snapshotId: number): Promise<{
    instructions: KnowledgeEntry[];
    skillsIndex: string;
}>;
/**
 * Answer and grade one task.
 *
 * The server hides exactly `task.truth.exchanges` — the sources this task was
 * built from — and nothing else: the solver is meant to search the rest of the
 * archive, which is what makes finding the right file the task.
 */
export declare function solveTask(dbs: LearnDbs, task: LearningTask, options: SolveOptions): Promise<AttemptRow>;
export interface SolveManyOptions extends Omit<SolveOptions, 'snapshotId'> {
    snapshotId: number;
    /** The run's shared call budget. A batch stops with `BudgetExhausted` at the cap. */
    budget: CallBudget;
    /** Test seam: defaults to `solveTask`, so a leaf learner can be driven by a fake. */
    solve?: typeof solveTask;
}
/**
 * Solve a batch of tasks.
 *
 * Every task goes through the single global semaphore, so the batch's own
 * parallelism is bounded by `learnConfig().concurrency` no matter how many tasks
 * the caller hands over. The budget is shared, so a batch stops with
 * `BudgetExhausted` at the cap and the caller keeps the attempts already stored.
 */
export declare function solveMany(dbs: LearnDbs, tasks: LearningTask[], options: SolveManyOptions): Promise<AttemptRow[]>;
