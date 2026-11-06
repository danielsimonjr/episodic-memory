/**
 * Self-practice task generation and staleness checks (spec §4.4).
 *
 * The module builds each task from one held-out exchange. The solver never sees
 * the address or the assistant message of that exchange. The grade compares what
 * the solver found with the address the exchange actually has. The archive is
 * therefore both the
 * corpus and the answer key, and no rubric author is needed.
 *
 * What this module guarantees:
 *
 * - **Redaction before any model sees text, and again before storage.** The
 *   paraphrase prompt carries redacted exchange text. The module redacts the returned
 *   prompt and the assistant message in the truth before the module writes the row.
 * - **Screening.** The module does not store a prompt that fails the learned-text screen.
 *   A paraphrase is untrusted text from a model that just read the archive.
 *   The learned-text screen applies to every paraphrase before storage.
 * - **A stratified 60/40 split** per `(project, tier)` from the seed stored on
 *   the run, so the held-out split is comparable across runs.
 * - **Truth is an address**, not a copied transcript, so a re-index that moves a
 *   line marks the task stale instead of silently wrong.
 */
import type Database from 'better-sqlite3';
import type { ConversationExchange } from '../types.js';
import type { LearningKind, LearningTier } from './types.js';
/**
 * The default minimum number of non-sidechain exchanges that a project needs before selectSourceExchanges uses it. The defaults come from spec §4.4.
 */
export declare const MIN_PER_PROJECT = 20;
/** The default minimum length, in characters, of a user message. selectSourceExchanges skips exchanges with a shorter user message. */
export declare const MIN_USER_CHARS = 80;
/** The default minimum length, in characters, of an assistant message. selectSourceExchanges skips exchanges with a shorter assistant message. */
export declare const MIN_ASSISTANT_CHARS = 200;
/** Options for selectSourceExchanges. */
export interface SelectSourceOptions {
    /** The maximum number of exchanges to pick from each project. */
    perProject: number;
    /** The seed of the shuffle. The same seed gives the same choice. The project name also feeds the shuffle. */
    seed: number;
    /** The number of exchanges that a project needs before the function uses it. Default: MIN_PER_PROJECT. */
    minPerProject?: number;
    /** The minimum length of the user message. Default: MIN_USER_CHARS. */
    minUser?: number;
    /** The minimum length of the assistant message. Default: MIN_ASSISTANT_CHARS. */
    minAssistant?: number;
}
/**
 * Select the exchanges that the module may build tasks from.
 *
 * Deterministic from the seed. The function excludes sidechains, exchanges whose
 * user or assistant message is below the floor, and projects with fewer than
 * `minPerProject` indexed exchanges. A one-line exchange has nothing to locate,
 * and a project with a dozen exchanges makes a task trivially findable.
 */
export declare function selectSourceExchanges(indexDb: Database.Database, options: SelectSourceOptions): ConversationExchange[];
/**
 * The paraphrase prompt.
 *
 * One call per source exchange returns all three tiers; the tiers differ only in
 * how much of the source user message's vocabulary survives. Tier 3 deliberately adds a
 * wrong-but-plausible detail the solver has to reject.
 */
export declare function paraphrasePrompt(exchange: ConversationExchange): string;
/** One parsed tier: kind → prompt. */
type TierBlock = Partial<Record<LearningKind, string>>;
/**
 * A stored prompt is the solver's only view of the task. The archive path and
 * the session id are the answer key (spec §4.4). The function returns true for a
 * paraphrase that echoes either of them, and the caller then drops that paraphrase.
 *
 * The check is lexical: a `.jsonl` path (POSIX or Windows), the source
 * exchange's own path or session id, or a bare `session-<id>` token. The word
 * "session" on its own is a legitimate question, so the check does not flag it.
 */
export declare function promptLeaksAnswerKey(prompt: string, exchange: ConversationExchange): boolean;
/** Parse the model's tagged blocks. A missing or malformed block yields no prompts. */
export declare function parseParaphrase(raw: string): Record<LearningTier, TierBlock>;
/**
 * Options for generateTasks. The function creates at most `maxTasks` tasks and stores each task under `runId`.
 */
export interface GenerateTasksOptions {
    /** The learning run that owns the new tasks. */
    runId: string;
    /** The seed of the source selection and of the sampling inside each stratum. The same seed gives the same result. */
    seed: number;
    /** Text-only model call. The default is `callLearnModel`. */
    model?: (prompt: string) => Promise<string>;
    /** The maximum number of source exchanges for each project. The default is 8. */
    perProject?: number;
    /** The maximum number of tasks. The function divides this cap among the (project, tier) strata. */
    maxTasks: number;
}
/** The counts that generateTasks returns. */
export interface GenerateTasksResult {
    /** The number of tasks that the function inserted. */
    created: number;
    /** The number of inserted tasks for each cell. A cell key has the form `kind:tier`, such as `locate:1`. */
    byKindTier: Record<string, number>;
}
/**
 * Generate tasks from the archive, split them, and store them.
 *
 * The module makes one paraphrase call per source exchange. The module redacts
 * each returned prompt. The module drops a prompt that leaks the answer key or
 * fails the learned-text screen. An exchange whose whole answer is unusable
 * contributes no tasks.
 */
export declare function generateTasks(learningDb: Database.Database, indexDb: Database.Database, options: GenerateTasksOptions): Promise<GenerateTasksResult>;
/**
 * Mark every task whose source address does not resolve.
 *
 * A re-indexed session keeps its path but moves its lines. The last exchange of a
 * growing session grows. Later inserts shift nothing, but a repair can renumber
 * lines. A pruned project loses the path entirely. The function marks both cases
 * `stale`, which excludes the task from reads and metrics rather than scoring it
 * as a failure.
 */
export declare function checkTasks(learningDb: Database.Database, indexDb: Database.Database): {
    stale: number[];
};
export {};
