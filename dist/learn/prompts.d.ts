/**
 * Prompts for every role a learning run uses.
 *
 * Task 5 added the solver's prompt. This module now carries the bootstrapper's
 * and the shapes the learner (Tasks 8 and 9) will consume: diagnose, edit,
 * split, merge and reflect. Defining the argument shapes here keeps one file as
 * the reviewable home of the rules a prompt must carry, even for a prompt whose
 * caller lands later.
 *
 * Every function is pure: text in, text out, no clock, no environment, no model.
 * Model-supplied text is re-redacted before it is quoted back into a prompt, so
 * a planted secret in the archive cannot ride along.
 */
import type { KnowledgeEntry, ProposedEntry, SourceRef, TraceStep } from './types.js';
import type { LearningKind } from './types.js';
/** The answer lines a solver must produce, in order. */
export declare const SOLVER_ANSWER_FORMAT: string[];
/**
 * The solver's system prompt.
 *
 * `instructions` are the active instruction entries (project rows then global),
 * and `skillsIndex` is the one-line-per-skill index the rendered block also
 * shows. Both are inserted as data: the prompt says so, because learned text was
 * written by a model reading untrusted archive content.
 */
export declare function solverSystemPrompt(instructions: KnowledgeEntry[], skillsIndex: string): string;
/** The two skills every bootstrapper proposes (spec §6.1 step 2). */
export declare const BOOTSTRAP_SKILL_SLUGS: readonly ["navigation", "exploration-notes"];
export interface BootstrapStats {
    exchanges: number;
    sessions: number;
    first: string;
    last: string;
}
/**
 * The bootstrapper's system prompt: map a project's corpus, propose two skills.
 *
 * The two skills are named by slug because the learner later matches on them;
 * everything else about them is the model's reading of the archive.
 */
export declare function bootstrapperSystemPrompt(): string;
/** The bootstrapper's user turn: the corpus's shape and what to propose. */
export declare function bootstrapperBrief(project: string, stats: BootstrapStats): string;
/**
 * Ask for the one global instruction the bootstrapped candidates support.
 *
 * The candidates are evidence, not text to concatenate: the answer must be a
 * small set of template lines that hold across projects, because an instruction
 * rides in every session's context.
 */
export declare function mergeInstructionPrompt(candidates: KnowledgeEntry[]): string;
/** One failed attempt as the diagnose prompt sees it: addresses, never transcripts. */
export interface DiagnosisFailure {
    taskId: number;
    kind: LearningKind;
    tier: number;
    prompt: string;
    answer: string;
    trace: TraceStep[];
}
export interface DiagnosePromptInput {
    project: string;
    failed: DiagnosisFailure[];
    active: KnowledgeEntry[];
    priorFailures: Array<{
        context: string;
        failure_mode?: string;
        root_cause?: string;
    }>;
    reflections: KnowledgeEntry[];
    /** `projectContextManager.forContext` output: learner prompts only, never rendered. */
    projectContext?: string;
    maxEdits?: number;
}
/**
 * The diagnose turn: what failed, by address, and what is already known.
 *
 * The failed traces carry tool names and addresses, not result text, so the
 * learner reasons about the search path rather than re-reading the archive.
 */
export declare function diagnosePrompt(input: DiagnosePromptInput): string;
export interface EditBriefInput {
    project: string;
    maxEdits: number;
    /** Task ids the proposals should fix. */
    targets: number[];
}
/** The edit turn's user message: how many proposals, aimed at which tasks. */
export declare function editBrief(input: EditBriefInput): string;
/** One failed task reduced to what the split decision needs. */
export interface SplitFailure {
    taskId: number;
    project: string;
    kind: LearningKind;
    answer: string;
}
export interface SplitPromptInput {
    failed: SplitFailure[];
    /** The failure categories the split may assign. */
    categories: string[];
}
/**
 * The split turn: partition the failed task ids into failure categories.
 *
 * The answer is validated as a partition; one that is not falls back to
 * by-project (spec §6.2 step 3).
 */
export declare function splitPrompt(input: SplitPromptInput): string;
export interface MergeEntriesPromptInput {
    entries: KnowledgeEntry[];
}
/**
 * The merge turn: one body citing the union of the duplicates' sources.
 *
 * Each entry is numbered so the answer can name which version it follows.
 */
export declare function mergeEntriesPrompt(input: KnowledgeEntry[] | MergeEntriesPromptInput): string;
export interface ReflectEvidence {
    attemptId: number;
    taskId: number;
    kind: LearningKind;
    passed: boolean;
}
export interface ReflectPromptInput {
    runId: string;
    project: string;
    kept: string[];
    rejected: Array<{
        slug: string;
        reason: string;
    }>;
    before: {
        passed: number;
        total: number;
    };
    after: {
        passed: number;
        total: number;
    };
    evidence: ReflectEvidence[];
    sources: SourceRef[];
}
/**
 * The reflect turn: what the round changed, with the ids to cite.
 *
 * Attempts are quoted as `[@n]` and exchanges as `[#id]` so the model copies an
 * exact mark group instead of inventing one.
 */
export declare function reflectPrompt(input: ReflectPromptInput): string;
/** Re-exported so a caller can build a proposal without importing types directly. */
export type { ProposedEntry };
