/**
 * Prompts for every role a learning run uses.
 *
 * The module builds a prompt for each role of a learning run. The roles are the
 * solver, the bootstrapper, and the learner steps diagnose, edit, split, merge and reflect.
 * Keeping them in one file keeps the rules that each prompt must carry easy to review.
 *
 * Every function is pure: text in, text out, no clock, no environment, no model.
 * The code re-redacts model-supplied text before it quotes that text back into
 * a prompt, so
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
/** The slugs of the two skills that the bootstrap brief asks for (spec §6.1 step 2). */
export declare const BOOTSTRAP_SKILL_SLUGS: readonly ["navigation", "exploration-notes"];
/** What the bootstrapper knows about the corpus of one project. */
export interface BootstrapStats {
    /** The number of exchanges in the project. */
    exchanges: number;
    /** The number of sessions in the project. */
    sessions: number;
    /** The earliest exchange timestamp, or an empty string. */
    first: string;
    /** The latest exchange timestamp, or an empty string. */
    last: string;
}
/**
 * The bootstrapper's system prompt: map a project's corpus, propose two skills.
 *
 * The prompt names the two skills by slug, because the learner later matches on
 * them. The model's reading of the archive supplies everything else about them.
 */
export declare function bootstrapperSystemPrompt(): string;
/** The bootstrapper's user turn: the corpus's shape and what to propose. */
export declare function bootstrapperBrief(project: string, stats: BootstrapStats): string;
/**
 * Ask for the one global instruction the bootstrapped candidates support.
 *
 * The candidates are evidence, not text to concatenate. The answer must be a
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
/** The input of diagnosePrompt. */
export interface DiagnosePromptInput {
    project: string;
    /** The failed attempts to diagnose. */
    failed: DiagnosisFailure[];
    /** The entries that are active. */
    active: KnowledgeEntry[];
    /** Failures from earlier runs, each with a context and, when known, a failure mode and a root cause. */
    priorFailures: Array<{
        context: string;
        failure_mode?: string;
        root_cause?: string;
    }>;
    /** The reflection entries that the prompt shows. */
    reflections: KnowledgeEntry[];
    /** `projectContextManager.forContext` output: learner prompts only, never rendered. */
    projectContext?: string;
    /** The maximum number of proposed edits. The default is 3. */
    maxEdits?: number;
}
/**
 * The diagnose turn: what failed, by address, and what is already known.
 *
 * The failed traces carry tool names and addresses, not result text, so the
 * learner reasons about the search path rather than re-reading the archive.
 */
export declare function diagnosePrompt(input: DiagnosePromptInput): string;
/** The input of editBrief. */
export interface EditBriefInput {
    project: string;
    /** The maximum number of entries to propose. */
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
/** The input of splitPrompt. */
export interface SplitPromptInput {
    /** The failed tasks to assign to categories. */
    failed: SplitFailure[];
    /** The failure categories the split may assign. */
    categories: string[];
}
/**
 * The split turn: partition the failed task ids into failure categories.
 *
 * The learner validates the answer as a partition. An answer that is not a
 * partition leaves the cut by project (spec §6.2 step 3).
 */
export declare function splitPrompt(input: SplitPromptInput): string;
/** The input of mergeEntriesPrompt when the caller passes an object. */
export interface MergeEntriesPromptInput {
    /** The duplicate entries to merge. */
    entries: KnowledgeEntry[];
}
/**
 * The merge turn: one body citing the union of the duplicates' sources.
 *
 * Each entry carries a number so the answer can name the version that the entry follows.
 */
export declare function mergeEntriesPrompt(input: KnowledgeEntry[] | MergeEntriesPromptInput): string;
/** One attempt that the reflection prompt may cite. */
export interface ReflectEvidence {
    attemptId: number;
    taskId: number;
    /** The task's real kind. Omitted when the attempt has no task row to read. */
    kind?: LearningKind;
    /** True when the attempt passed. */
    passed: boolean;
}
/** The input of reflectPrompt: what one learning round kept and rejected, and the evidence that the reflection may cite. */
export interface ReflectPromptInput {
    runId: string;
    project: string;
    /** The names of the entries that the round kept. */
    kept: string[];
    /** The entries that the round rejected, with the reason for each. */
    rejected: Array<{
        slug: string;
        reason: string;
    }>;
    /** The signal pass count before the round. `total` is the number of signals. */
    before: {
        passed: number;
        total: number;
    };
    /** The signal pass count after the round. */
    after: {
        passed: number;
        total: number;
    };
    /** The attempts that the reflection may cite. */
    evidence: ReflectEvidence[];
    /** The exchanges that the reflection may cite, with their line ranges. */
    sources: SourceRef[];
}
/**
 * The reflect turn: what the round changed, with the ids to cite.
 *
 * The prompt quotes attempts as `[@n]` and exchanges as `[#id]`, so the model
 * copies an
 * exact mark group instead of inventing one.
 */
export declare function reflectPrompt(input: ReflectPromptInput): string;
/** Re-exported so a caller can build a proposal without importing types directly. */
export type { ProposedEntry };
