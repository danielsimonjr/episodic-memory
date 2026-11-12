import { ConversationExchange } from './types.js';
import { shouldSkipReentrantSync } from './reentrancy.js';
/** The command that runs one Codex summarization. buildCodexSummarizerCommand creates it. */
export interface CodexSummarizerCommand {
    /** The executable to start. */
    command: string;
    /** The arguments for the executable. */
    args: string[];
    /** The summarization prompt. */
    prompt: string;
    /** The Codex session to fork. */
    sessionId: string;
    /** The model for the fork. When the caller omits `model`, the fork sends no model. */
    model?: string;
    /** The arguments for the version check, run with `command`. The default is `--version`. */
    versionArgs?: string[];
    /** When true, runCodexCommand skips the version check. */
    skipVersionCheck?: boolean;
}
/**
 * Build the environment for a summarization subprocess.
 *
 * The result contains all of process.env, so the subprocess gets PATH, HOME and the other variables.
 * The result always sets EPISODIC_MEMORY_SUMMARIZER_GUARD to `1`. The guard stops the subprocess from starting another sync.
 *
 * The function reads these variables:
 * - EPISODIC_MEMORY_API_BASE_URL: when the variable has a non-empty value, the function validates it. A valid endpoint sets ANTHROPIC_BASE_URL to the validated URL. For an unsafe endpoint, the function ignores the value and writes a message to stderr.
 * - EPISODIC_MEMORY_API_TOKEN: when the variable has a non-empty value, the function sets ANTHROPIC_AUTH_TOKEN to that value.
 * - EPISODIC_MEMORY_API_TIMEOUT_MS: when the variable has a non-empty value, the function sets API_TIMEOUT_MS to that value. callClaude also reads the variable for its own abort timer.
 *
 * callClaude and callModel read EPISODIC_MEMORY_API_MODEL and EPISODIC_MEMORY_API_MODEL_FALLBACK. The function getApiEnv does not read them.
 */
export declare function getApiEnv(): Record<string, string | undefined> | undefined;
/**
 * Re-export `shouldSkipReentrantSync` from `./reentrancy.js`.
 *
 * The sync CLI imports the function from `./reentrancy.js`, so the CLI does not load this module's SDK dependencies.
 * Code that imports the function from this module keeps working.
 */
export { shouldSkipReentrantSync };
/**
 * Format exchanges as the transcript text of a summarization prompt.
 *
 * Each exchange becomes a `User:` paragraph and an `Agent:` paragraph. The function joins the exchanges with a horizontal rule.
 */
export declare function formatConversationText(exchanges: ConversationExchange[]): string;
/**
 * Return the summary that a model answer contains.
 *
 * The function returns the trimmed text between the first `<summary>` tag and the next `</summary>` tag.
 * When the answer has no such pair, the function returns the trimmed answer.
 * The function throws an Error when the answer is not a string. The message says that the SDK call failed.
 */
export declare function extractSummary(text: string): string;
/**
 * Build the options object passed to the Claude Agent SDK's query() for a summarization call.
 *
 * persistSession: false stops the SDK from saving the session to ~/.claude/projects/.
 * No later call can resume the session. Without this option, each summary adds
 * a session to the IDE session sidebar (#83). The claude-agent-sdk type
 * declarations describe the option.
 */
export declare function buildSummarizerQueryOptions(args: {
    model: string;
}): Record<string, unknown>;
/**
 * Return the prompt for one summary turn in a forked Codex session.
 *
 * The prompt contains no transcript. The forked session supplies the context.
 * The prompt tells the model not to inspect files, run commands, search the web or change state.
 * The prompt asks for one `<summary>` block. Pass the answer to extractSummary to read the block.
 */
export declare function buildCodexSummaryPrompt(): string;
/**
 * Build the command that starts a Codex app server for one summary.
 *
 * The executable is the `codexBin` argument. If the argument is empty or not set, the function uses the EPISODIC_MEMORY_CODEX_BIN variable. If the variable is also empty or not set, the executable is `codex`.
 *
 * The arguments are `app-server`. The result also holds the prompt, the session id and the model. The function starts no process.
 */
export declare function buildCodexSummarizerCommand(args: {
    sessionId: string;
    prompt: string;
    model?: string;
    codexBin?: string;
}): CodexSummarizerCommand;
/** Options for one Claude text call. Omitted values read the environment. */
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
 * The prompt character budget of the configured backend.
 *
 * On the Ollama backend the budget is EPISODIC_MEMORY_OLLAMA_MAX_PROMPT_CHARS. The value is parsed the way
 * `callOllama` parses it, so a prompt within the budget is never cut by the call. On the Claude backend the
 * budget is 48000 characters.
 */
export declare function promptBudgetChars(): number;
/**
 * Return the model and the retry model for learning calls.
 *
 * The learn model reads EPISODIC_MEMORY_LEARN_MODEL. The retry model reads EPISODIC_MEMORY_API_MODEL_FALLBACK, which the digest also reads. Both default to `sonnet`. A blank value counts as unset.
 *
 * callLearnModel uses these models for text-only learning calls when the backend is not ollama. The learn model does not change the digest model.
 *
 * @param env the variables to read. The default is process.env.
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
 * use this switch. The ollama backend makes text calls only.
 */
export declare function callLearnModel(prompt: string): Promise<string>;
/**
 * Run one summary turn in a Codex app server and return the answer text.
 *
 * The function runs the version check first, unless the caller sets `skipVersionCheck`. The check runs `command.versionArgs`, or `--version` by default. The function rejects when the version is missing or below the supported minimum.
 *
 * The function starts `command.command` with `command.args`, using the environment from getApiEnv. The function forks the thread `command.sessionId` as an ephemeral, read-only thread. The function starts one turn with `command.prompt`.
 *
 * The returned promise resolves with the answer text when the turn completes. The function does not parse the text. Pass the text to extractSummary to read the `<summary>` block.
 *
 * The returned promise rejects in these cases:
 *
 * - the turn does not complete.
 * - the server answers a request with an error.
 * - the server exits early.
 * - the server writes a line that is not valid JSON.
 * - a process error occurs.
 * The promise also rejects when the run lasts longer than EPISODIC_MEMORY_CODEX_SUMMARY_TIMEOUT_MS milliseconds (default 120000). The version check uses the same timeout. After the server starts, the function sends SIGTERM to the server before the promise settles.
 */
export declare function runCodexCommand(command: CodexSummarizerCommand): Promise<string>;
/**
 * Summarize one conversation and return the summary text.
 *
 * The function returns `Trivial conversation with no substantive content.` without a model call when the conversation has no exchanges.
 * The function also returns that text for one exchange when its formatted text is under 100 characters.
 * The function also returns that text for one exchange whose user message is `/exit`.
 *
 * When some exchange comes from Codex and a session id is available, the function asks Codex for the summary first. The session id is the `sessionId` argument, or else the first session id found in the exchanges. When Codex fails, the function logs the error and uses the transcript path.
 *
 * The transcript path makes one model call for up to 15 exchanges. Any model error rejects the promise in this case.
 *
 * For more than 15 exchanges, the function summarizes each chunk of exchanges. The function then synthesizes the chunk summaries into one summary. The chunk size is 8 exchanges. A larger chunk size keeps the chunk count at 20 or less. The function logs a failed chunk and skips it. A failed synthesis returns the chunk summaries joined with a space. When no chunk succeeds, the function returns `Error: Unable to summarize conversation.` as the result.
 *
 * A GpuReservedError from a model call rejects the promise.
 *
 * The function writes its progress lines with console.log, so they go to stdout.
 *
 * @param sessionId the Codex session to fork. When the caller omits `sessionId`, the function uses the session id of the first exchange that has one.
 */
export declare function summarizeConversation(exchanges: ConversationExchange[], sessionId?: string): Promise<string>;
