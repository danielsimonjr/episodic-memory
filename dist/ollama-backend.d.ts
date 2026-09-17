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
export declare function summarizerBackend(): 'claude' | 'ollama';
/** Drop <think>...</think> blocks that a reasoning model may emit before its answer. */
export declare function stripThinking(text: string): string;
export interface OllamaCallOptions {
    fetchImpl?: typeof fetch;
    maxPromptChars?: number;
    timeoutMs?: number;
}
export declare function callOllama(prompt: string, opts?: OllamaCallOptions): Promise<string>;
