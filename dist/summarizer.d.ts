import { ConversationExchange } from './types.js';
import { shouldSkipReentrantSync } from './reentrancy.js';
export interface CodexSummarizerCommand {
    command: string;
    args: string[];
    prompt: string;
    sessionId: string;
    model?: string;
    versionArgs?: string[];
    skipVersionCheck?: boolean;
}
/**
 * Get API environment overrides for summarization calls.
 * Returns full env merged with process.env so subprocess inherits PATH, HOME, etc.
 *
 * Env vars (all optional):
 * - EPISODIC_MEMORY_API_MODEL: Model to use (default: haiku)
 * - EPISODIC_MEMORY_API_MODEL_FALLBACK: Fallback model on error (default: sonnet)
 * - EPISODIC_MEMORY_API_BASE_URL: Custom API endpoint
 * - EPISODIC_MEMORY_API_TOKEN: Auth token for custom endpoint
 * - EPISODIC_MEMORY_API_TIMEOUT_MS: Timeout for API calls (default: SDK default)
 */
export declare function getApiEnv(): Record<string, string | undefined> | undefined;
export { shouldSkipReentrantSync };
export declare function formatConversationText(exchanges: ConversationExchange[]): string;
export declare function extractSummary(text: string): string;
/**
 * Build the options object passed to the Claude Agent SDK's query() for a
 * summarization call.
 *
 * persistSession: false keeps the SDK from writing its session transcript to
 * ~/.claude/projects/ (#83). Without it, every summarization spawns a fake
 * session JSONL that pollutes the IDE session sidebar. The option is honored
 * by claude-agent-sdk >= 0.2.0.
 */
export declare function buildSummarizerQueryOptions(args: {
    model: string;
}): Record<string, unknown>;
export declare function buildCodexSummaryPrompt(): string;
export declare function buildCodexSummarizerCommand(args: {
    sessionId: string;
    prompt: string;
    model?: string;
    codexBin?: string;
}): CodexSummarizerCommand;
/** Options for one Claude text call. Omitted values read the environment as before. */
export interface CallClaudeOptions {
    /** Model for the primary attempt. Default: `EPISODIC_MEMORY_API_MODEL || 'haiku'`. */
    model?: string;
    /** Model for the retry. Default: `EPISODIC_MEMORY_API_MODEL_FALLBACK || 'sonnet'`. */
    fallbackModel?: string;
    /** Start on the fallback model. */
    useFallback?: boolean;
}
/** Digest entry point: same backend, model and fallback choice as session summaries. */
export declare function callDigestModel(prompt: string): Promise<string>;
/**
 * The learn model and its retry, from their own variables.
 *
 * Learning calls are text-only (task paraphrases, merge and split decisions,
 * the recall judge). They get their own model setting so tuning them never
 * moves the digest's model, and `sonnet` on both sides: the judge and the
 * paraphrase both need more than a summarizer's instruction-following.
 */
export declare function resolveLearnModels(env?: Record<string, string | undefined>): {
    model: string;
    fallbackModel: string;
};
/**
 * Learn entry point: the backend switch with the learn model.
 *
 * Text-only calls (task generation, learner split/merge, the recall judge) go
 * through here. A tool-using solver or learner is an SDK subprocess and does not
 * (spec: the ollama backend is a text call, not a harness).
 */
export declare function callLearnModel(prompt: string): Promise<string>;
export declare function runCodexCommand(command: CodexSummarizerCommand): Promise<string>;
export declare function summarizeConversation(exchanges: ConversationExchange[], sessionId?: string): Promise<string>;
