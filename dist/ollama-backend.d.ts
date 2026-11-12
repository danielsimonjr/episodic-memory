/**
 * Local-model summarizer backend (Ollama). Opt-in with EPISODIC_MEMORY_SUMMARIZER_BACKEND=ollama.
 *
 * WHY. Thousands of archived conversations have no summary, and summarising them through the
 * Claude SDK is thousands of billed calls. A local model does the same job at no cost; the summary
 * only feeds search display, so a small quality gap is an acceptable trade.
 *
 * Env:
 * - EPISODIC_MEMORY_OLLAMA_URL     base URL (default http://localhost:11434). Same rule as the API
 *                                  base URL: https anywhere, http ONLY on loopback. To use a model
 *                                  on another machine, tunnel it (ssh -L 11434:localhost:11434).
 * - EPISODIC_MEMORY_OLLAMA_MODEL   REQUIRED. No default: a shared Ollama host holds one model, so
 *                                  an implicit default would evict whatever another client loaded.
 * - EPISODIC_MEMORY_OLLAMA_MAX_PROMPT_CHARS  prompt character budget (default 24000, fits 8k ctx).
 * - EPISODIC_MEMORY_API_TIMEOUT_MS  per-call timeout, shared with the Claude backend (default 120 s).
 */
/**
 * Another agent reserves the shared GPU.
 * `callOllama` therefore does not load a model now.
 * A reservation is not a summary failure: callers leave the work queued and do not count an attempt.
 */
export declare class GpuReservedError extends Error {
    /** The reservation message: who holds the GPU. */
    readonly detail: string;
    constructor(detail: string);
}
/**
 * Returns `ollama` when `EPISODIC_MEMORY_SUMMARIZER_BACKEND` is `ollama`, ignoring letter case and surrounding spaces.
 *
 * Returns `claude` for every other value, including an unset variable.
 */
export declare function summarizerBackend(): 'claude' | 'ollama';
/** Drop <think>...</think> blocks that a reasoning model may emit before its answer. */
export declare function stripThinking(text: string): string;
/**
 * Per-call overrides for `callOllama`.
 *
 * `maxPromptChars` and `timeoutMs` replace the environment defaults. `fetchImpl` replaces the global `fetch`, so a test can pass a fake.
 * `requireSummaryBlock` (default true) makes the call refuse a reply that has no `<summary>` block.
 * Set it to false for a prompt that does not ask for that block, such as a digest or learn prompt.
 */
export interface OllamaCallOptions {
    fetchImpl?: typeof fetch;
    maxPromptChars?: number;
    timeoutMs?: number;
    requireSummaryBlock?: boolean;
}
/**
 * Sends a summarizer prompt to an Ollama server and returns the reply text without `<think>` blocks.
 *
 * The call throws `GpuReservedError` while another agent holds the shared GPU.
 * The call throws when `EPISODIC_MEMORY_OLLAMA_MODEL` is unset or blank.
 * The call throws when the server URL fails validation or the HTTP status is not OK.
 * The call throws when the reply is empty.
 * The call also throws when the reply has no `<summary>` block, unless `requireSummaryBlock` is false.
 * The call throws when the request runs longer than `timeoutMs`.
 *
 * The function cuts the prompt to the character budget before the function sends the request.
 *
 * @param prompt The complete summarizer prompt.
 * @param opts Per-call overrides. See `OllamaCallOptions`.
 */
export declare function callOllama(prompt: string, opts?: OllamaCallOptions): Promise<string>;
