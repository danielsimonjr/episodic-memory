/**
 * Validation: does a candidate edit actually earn its place?
 *
 * The decision is made in Node, never in the model (spec §6.2 step 4, §7 rule 5).
 * A candidate is kept only when at least one task it targeted now passes **and**
 * no task that passed before starts failing. Anything else — no gain, a
 * regression, an unmeasurable run — leaves the row a candidate: it is written
 * down, never deleted, and `learn status` lists it as awaiting approval.
 *
 * The evaluation snapshot is `K^(t)` with the candidate applied: every currently
 * active not-superseded entry, minus the version this candidate supersedes, plus
 * the candidate. Without the subtraction a revision would be scored against
 * itself.
 *
 * Additive only: nothing here deletes an entry or an attempt.
 */
import type { LearnDbs, ValidationRecord } from './types.js';
import type { CallBudget, solveTask } from './solver.js';
import type { PidRegistry } from './agent-runner.js';
/**
 * The options for `validateCandidate`.
 */
export interface ValidateOptions {
    /** Task ids the edit was proposed to fix (the round's failures). */
    targeted: number[];
    /** Task ids that passed before; a seeded sample of them is re-solved. */
    sampleFrom: number[];
    sampleSize: number;
    seed: number;
    solve: typeof solveTask;
    runId: string;
    budget: CallBudget;
    /** Model for the validation solves. Defaults to the learn model. */
    model?: string;
    /** Test seam: the solver's agent runner. */
    runAgent?: Parameters<typeof solveTask>[2]['runAgent'];
    judge?: (prompt: string) => Promise<string>;
    pids?: PidRegistry;
}
/** A validation verdict, stored on the entry whatever it says. */
export type ValidationResult = ValidationRecord & {
    keep: boolean;
};
/**
 * A seeded sample of `ids`, without replacement, in a stable order.
 *
 * Sorting first makes the sample a function of `(ids, size, seed)` alone.
 * So a rerun with the same seed validates the same tasks.
 */
export declare function sampleIds(ids: number[], size: number, seed: number): number[];
/**
 * Validate one candidate and act on the verdict.
 *
 * On a keep, the entry is activated (`verified`) when its kind can activate itself.
 * A skill can activate itself, and so can an instruction under `approve: none`.
 * Otherwise, the entry stays a candidate, with its record.
 * On a drop, the record is written.
 * The instruction's heuristics take a contradiction.
 * A procedure's success rate falls, and the edit's decision is rejected with the reason.
 */
export declare function validateCandidate(dbs: LearnDbs, candidateName: string, opts: ValidateOptions): Promise<ValidationResult>;
