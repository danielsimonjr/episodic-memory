/**
 * The leaf learner: diagnose a subset's failures, propose edits, validate them.
 *
 * Spec §6.2 step 4. One leaf owns one subset of the `train` signal tasks and
 * runs up to `rounds` of the same four moves:
 *
 * 1. **Solve** the subset with the current snapshot (`K^(t)`) and keep the
 *    `graded` failures. An `aborted`, `killed` or `error` attempt is evidence
 *    the run was cut short, not evidence the solver failed, so it never enters
 *    diagnosis or a validation set.
 * 2. **Suspect.** A task two solvers fail while each commits to a different
 *    address is task noise, not a retrieval failure; it is marked `suspect` and
 *    excluded from every validation set (the paper's §6.1 criterion revision in
 *    programmatic form).
 * 3. **Diagnose and edit** with one learner subprocess that sees the failed
 *    traces by address, the active entries, the failures earlier runs recorded,
 *    and the reflections they wrote — and proposes through `propose_entry`.
 * 4. **Gate and validate.** Every proposal passes `gateEntry`, is stored as a
 *    candidate, and is measured by `validateCandidate`; only a `keep` counts.
 *
 * The loop stops when a round validates candidates and keeps none, when the
 * learner proposes nothing, or at the cap. Nothing here deletes an entry: a
 * dropped edit keeps its row and its validation record.
 */
import { runAgent } from './agent-runner.js';
import { CallBudget, type PidRegistry } from './solver.js';
import { validateCandidate } from './validate.js';
import type { AttemptRow, LearnDbs } from './types.js';
/** The score a stored procedure must reach to be offered to the learner. */
export declare const PROCEDURE_MATCH_THRESHOLD = 0.3;
/** The skill every learner is offered regardless of the match score. */
export declare const NAVIGATION_SLUG = "navigation";
/** What one leaf learner produced. */
export interface LeafResult {
    /** Entry names the run kept (and, for a skill, activated). */
    kept: string[];
    /** Proposals that never reached validation, with the gate's reason. */
    rejected: Array<{
        slug: string;
        reason: string;
    }>;
    /** Task ids excluded from validation as task noise. */
    suspect: number[];
    /** Per-round solve results, `passed` of `total` graded attempts. */
    rounds: Array<{
        passed: number;
        total: number;
    }>;
}
export interface LeafLearnerOptions {
    runId: string;
    project: string;
    /** The subset's task ids. Read through `listTasks`, so `test` rows never appear. */
    taskIds: number[];
    rounds: number;
    editsPerRound: number;
    /** Test seam: defaults to `runAgent`. */
    runAgent?: typeof runAgent;
    /** Test seam: defaults to `solveTask`. */
    solve?: Parameters<typeof validateCandidate>[2]['solve'];
    model?: string;
    budget: CallBudget;
    pids?: PidRegistry;
    judge?: (prompt: string) => Promise<string>;
}
/**
 * Tasks whose solvers disagreed about where the answer lives.
 *
 * Two `graded` attempts from this round, each committing to an address, with
 * different addresses: the task's truth is unreliable for this round, so it
 * cannot be part of a validation set. One attempt, or two attempts naming the
 * same file, is a normal failure and stays in.
 */
export declare function suspectTaskIds(attempts: AttemptRow[]): number[];
/**
 * Run one leaf learner over a subset of the train signal tasks.
 *
 * Everything a model or a subprocess would touch is injected, so a test drives
 * the whole loop with fakes and never reaches a model, a GPU or a subprocess.
 */
export declare function runLeafLearner(dbs: LearnDbs, options: LeafLearnerOptions): Promise<LeafResult>;
