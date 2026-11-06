/**
 * Self-practice task generation and staleness checks (spec §4.4).
 *
 * A task is built from one held-out exchange: the solver never sees its address
 * or its assistant message, and the grade compares what the solver found with
 * the address the exchange actually has. The archive is therefore both the
 * corpus and the answer key, and no rubric author is needed.
 *
 * What this module guarantees:
 *
 * - **Redaction before any model sees text, and again before storage.** The
 *   paraphrase prompt carries redacted exchange text; the returned prompt is
 *   redacted and truth is redacted before the row is written.
 * - **Screening.** A prompt that fails the learned-text screen is not stored.
 *   A paraphrase is untrusted text from a model that just read the archive, and
 *   it becomes a learner prompt later.
 * - **A stratified 60/40 split** per `(project, tier)` from the seed stored on
 *   the run, so the held-out split is comparable across runs.
 * - **Truth is an address**, not a copied transcript, so a re-index that moves a
 *   line marks the task stale instead of silently wrong.
 */
import type Database from 'better-sqlite3';
import type { ConversationExchange } from '../types.js';
import type { LearningKind, LearningTier } from './types.js';
/** Default floors from spec §4.4. */
export declare const MIN_PER_PROJECT = 20;
export declare const MIN_USER_CHARS = 80;
export declare const MIN_ASSISTANT_CHARS = 200;
export interface SelectSourceOptions {
    perProject: number;
    seed: number;
    minPerProject?: number;
    minUser?: number;
    minAssistant?: number;
}
/**
 * Pick the exchanges tasks may be built from.
 *
 * Deterministic from the seed. Excludes sidechains, exchanges whose user or
 * assistant message is below the floor (a one-line exchange has nothing to
 * locate), and projects below `minPerProject` indexed exchanges (a project with
 * a dozen exchanges makes a task trivially findable).
 */
export declare function selectSourceExchanges(indexDb: Database.Database, options: SelectSourceOptions): ConversationExchange[];
/**
 * The paraphrase prompt.
 *
 * One call per source exchange returns all three tiers; the tiers differ only in
 * how much of the user's own vocabulary survives. Tier 3 deliberately adds a
 * wrong-but-plausible detail the solver has to reject.
 */
export declare function paraphrasePrompt(exchange: ConversationExchange): string;
/** One parsed tier: kind → prompt. */
type TierBlock = Partial<Record<LearningKind, string>>;
/**
 * A stored prompt is the solver's only view of the task. The archive path and
 * the session id are the answer key (spec §4.4), so a paraphrase that echoes
 * either of them is dropped rather than stored.
 *
 * The check is lexical: a `.jsonl` path (POSIX or Windows), the source
 * exchange's own path or session id, or a bare `session-<id>` token. The word
 * "session" on its own is a legitimate question and is kept.
 */
export declare function promptLeaksAnswerKey(prompt: string, exchange: ConversationExchange): boolean;
/** Parse the model's tagged blocks. A missing or malformed block yields no prompts. */
export declare function parseParaphrase(raw: string): Record<LearningTier, TierBlock>;
export interface GenerateTasksOptions {
    runId: string;
    seed: number;
    /** Text-only model. Default `callLearnModel`. */
    model?: (prompt: string) => Promise<string>;
    perProject?: number;
    maxTasks: number;
}
export interface GenerateTasksResult {
    created: number;
    byKindTier: Record<string, number>;
}
/**
 * Generate tasks from the archive, split them, and store them.
 *
 * One paraphrase call per source exchange. Each returned prompt is redacted and
 * screened; a prompt that fails either is dropped, and an exchange whose whole
 * answer is unusable simply contributes no tasks.
 */
export declare function generateTasks(learningDb: Database.Database, indexDb: Database.Database, options: GenerateTasksOptions): Promise<GenerateTasksResult>;
/**
 * Mark every task whose source address no longer resolves.
 *
 * A re-indexed session keeps its path but moves its lines (the last exchange of
 * a growing session grows, and later inserts shift nothing but a repair can
 * renumber); a pruned project loses the path entirely. Both are `stale`, which
 * excludes the task from reads and metrics rather than scoring it as a failure.
 */
export declare function checkTasks(learningDb: Database.Database, indexDb: Database.Database): {
    stale: number[];
};
export {};
