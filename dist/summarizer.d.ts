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
 * Whether the Claude Agent SDK can resume `sessionId` — i.e. its transcript still
 * exists under ~/.claude/projects/. The summarizer prefers resuming the original
 * session (cheaper: it already holds the transcript), but resume is guaranteed to
 * fail for archived/old conversations whose source transcript Claude Code has
 * since removed, and a failed resume still spawns a doomed subprocess. Checking
 * first lets us skip straight to transcript-text summarization.
 *
 * Claude Code names each session file `<sessionId>.jsonl` and stores it in the
 * project subdir whose name the archive mirrors, so we probe that exact path
 * first and fall back to a one-level scan of the project subdirs. This is a
 * best-effort predictor; the resume call site keeps a try/catch net for the rare
 * case where the file exists but resume still fails (e.g. cwd mismatch).
 */
export declare function isSessionResumable(sessionId?: string, project?: string): boolean;
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
    sessionId?: string;
}): Record<string, unknown>;
export declare function buildCodexSummaryPrompt(): string;
export declare function buildCodexSummarizerCommand(args: {
    sessionId: string;
    prompt: string;
    model?: string;
    codexBin?: string;
}): CodexSummarizerCommand;
export declare function runCodexCommand(command: CodexSummarizerCommand): Promise<string>;
export declare function summarizeConversation(exchanges: ConversationExchange[], sessionId?: string): Promise<string>;
