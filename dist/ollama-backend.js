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
import { validateApiBaseUrl } from './api-endpoint.js';
import { gpuReservationBlock } from './gpu-reservation.js';
import { envPositiveInt, OLLAMA_MAX_PROMPT_CHARS_DEFAULT } from './constants.js';
/**
 * Another agent reserves the shared GPU.
 * `callOllama` therefore does not load a model now.
 * A reservation is not a summary failure: callers leave the work queued and do not count an attempt.
 */
export class GpuReservedError extends Error {
    /** The reservation message: who holds the GPU. */
    detail;
    constructor(detail) {
        super(`GPU reserved, summary deferred: ${detail}`);
        this.name = 'GpuReservedError';
        this.detail = detail;
    }
}
/** The error codes that mean the endpoint cannot be reached. Every other fetch rejection counts as a failed attempt. */
const OUTAGE_CODES = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'EHOSTUNREACH', 'ENETUNREACH', 'UND_ERR_CONNECT_TIMEOUT']);
/** The start of every `OllamaUnavailableError` message. `ollamaOutageHost` reads the host after it. */
export const OLLAMA_UNAVAILABLE_PREFIX = 'Ollama endpoint ';
/**
 * Returns the outage code of a fetch rejection, or null.
 * The function reads `err.code`, `err.cause.code` and the code of each entry of `err.cause.errors`.
 * Node gives an AggregateError there when `localhost` resolves to two addresses.
 */
function outageCode(err) {
    const e = err;
    const codes = [e?.code, e?.cause?.code];
    if (Array.isArray(e?.cause?.errors))
        for (const x of e.cause.errors)
            codes.push(x?.code);
    for (const c of codes)
        if (typeof c === 'string' && OUTAGE_CODES.has(c))
            return c;
    return null;
}
/**
 * Returns the endpoint of an outage deferral detail, or null when the detail is not an outage.
 *
 * @param detail - A deferral detail, for example `summariesDeferred` of a sync result.
 */
export function ollamaOutageHost(detail) {
    if (!detail || !detail.startsWith(OLLAMA_UNAVAILABLE_PREFIX))
        return null;
    const host = detail.slice(OLLAMA_UNAVAILABLE_PREFIX.length).split(' ')[0];
    return host || null;
}
/** Returns the configured Ollama model name, or an empty string when the variable is unset. */
export function ollamaModelName() {
    return (process.env.EPISODIC_MEMORY_OLLAMA_MODEL || '').trim();
}
/**
 * The Ollama endpoint cannot be reached: the fetch rejects with a code in `OUTAGE_CODES`.
 * The endpoint is down for every call, so callers defer the work and count no attempt.
 * A timeout, an HTTP error, an empty reply and any other fetch rejection are not this error: they count as failed attempts.
 */
export class OllamaUnavailableError extends Error {
    /** The one-line reason for the logs and the sync report. */
    detail;
    constructor(detail) {
        super(detail);
        this.name = 'OllamaUnavailableError';
        this.detail = detail;
    }
}
/**
 * Returns `ollama` when `EPISODIC_MEMORY_SUMMARIZER_BACKEND` is `ollama`, ignoring letter case and surrounding spaces.
 *
 * Returns `claude` for every other value, including an unset variable.
 */
export function summarizerBackend() {
    return (process.env.EPISODIC_MEMORY_SUMMARIZER_BACKEND || '').trim().toLowerCase() === 'ollama'
        ? 'ollama'
        : 'claude';
}
/** Drop <think>...</think> blocks that a reasoning model may emit before its answer. */
export function stripThinking(text) {
    return text.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
}
/**
 * The prompt cap of the Ollama backend: `EPISODIC_MEMORY_OLLAMA_MAX_PROMPT_CHARS`, default 24000.
 *
 * `callOllama` cuts every prompt to this length, and `promptBudgetChars` builds prompts within it.
 */
export function ollamaMaxPromptChars() {
    return envPositiveInt('EPISODIC_MEMORY_OLLAMA_MAX_PROMPT_CHARS', OLLAMA_MAX_PROMPT_CHARS_DEFAULT);
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
 * The call throws `OllamaUnavailableError` when the fetch rejects with a connection error code (`OUTAGE_CODES`).
 *
 * The function cuts the prompt to the character budget before the function sends the request.
 *
 * @param prompt The complete summarizer prompt.
 * @param opts Per-call overrides. See `OllamaCallOptions`.
 */
export async function callOllama(prompt, opts = {}) {
    const reserved = gpuReservationBlock();
    if (reserved)
        throw new GpuReservedError(reserved);
    const model = ollamaModelName();
    if (!model) {
        throw new Error('EPISODIC_MEMORY_OLLAMA_MODEL is required for the ollama summarizer backend');
    }
    const check = validateApiBaseUrl(process.env.EPISODIC_MEMORY_OLLAMA_URL || 'http://localhost:11434');
    if (!check.ok) {
        throw new Error(`EPISODIC_MEMORY_OLLAMA_URL rejected: ${check.reason}`);
    }
    const maxChars = opts.maxPromptChars ?? ollamaMaxPromptChars();
    const timeoutMs = opts.timeoutMs ?? envPositiveInt('EPISODIC_MEMORY_API_TIMEOUT_MS', 120000);
    const doFetch = opts.fetchImpl ?? fetch;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const base = check.url.replace(/\/+$/, '');
        let res;
        try {
            res = await doFetch(`${base}/api/generate`, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({
                    model,
                    prompt: prompt.slice(0, maxChars),
                    stream: false,
                    think: false,
                    options: { temperature: 0 },
                }),
                signal: controller.signal,
            });
        }
        catch (err) {
            // A timeout keeps its plain error (the outer catch). Only a connection error code is an outage.
            // Every other rejection keeps its original error and counts as a failed attempt.
            if (controller.signal.aborted)
                throw err;
            const code = outageCode(err);
            if (!code)
                throw err;
            const cause = err?.cause;
            const reason = cause?.message || err?.message || code;
            throw new OllamaUnavailableError(`${OLLAMA_UNAVAILABLE_PREFIX}${base} is unreachable: ${reason.includes(code) ? reason : `${reason} (${code})`}`);
        }
        if (!res.ok) {
            let detail = '';
            try {
                detail = JSON.stringify(await res.json());
            }
            catch { /* body is not JSON */ }
            throw new Error(`Ollama call failed with HTTP ${res.status} ${detail}`.trim());
        }
        const body = await res.json();
        const text = stripThinking(typeof body?.response === 'string' ? body.response : '');
        if (!text)
            throw new Error('Ollama returned an empty response');
        // Every conversation-summary prompt asks for <summary></summary>. A reply without them is a model that
        // continued the transcript or emitted junk (measured on qwen2.5vl:3b). The shared extractor would
        // store it verbatim as a summary, so refuse it here and let the retry/give-up path record it.
        // Digest and learn prompts ask for other formats, and their own parsers check the reply.
        if (opts.requireSummaryBlock !== false && !/<summary>[\s\S]*?<\/summary>/i.test(text)) {
            throw new Error('Ollama reply has no <summary></summary> block');
        }
        return text;
    }
    catch (err) {
        if (controller.signal.aborted)
            throw new Error(`Ollama call timed out after ${timeoutMs}ms`);
        throw err;
    }
    finally {
        clearTimeout(timer);
    }
}
