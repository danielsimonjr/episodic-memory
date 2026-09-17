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
export function summarizerBackend() {
    return (process.env.EPISODIC_MEMORY_SUMMARIZER_BACKEND || '').trim().toLowerCase() === 'ollama'
        ? 'ollama'
        : 'claude';
}
/** Drop <think>...</think> blocks that a reasoning model may emit before its answer. */
export function stripThinking(text) {
    return text.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
}
function positiveInt(raw, fallback) {
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}
export async function callOllama(prompt, opts = {}) {
    const model = (process.env.EPISODIC_MEMORY_OLLAMA_MODEL || '').trim();
    if (!model) {
        throw new Error('EPISODIC_MEMORY_OLLAMA_MODEL is required for the ollama summarizer backend');
    }
    const check = validateApiBaseUrl(process.env.EPISODIC_MEMORY_OLLAMA_URL || 'http://localhost:11434');
    if (!check.ok) {
        throw new Error(`EPISODIC_MEMORY_OLLAMA_URL rejected: ${check.reason}`);
    }
    const maxChars = opts.maxPromptChars ?? positiveInt(process.env.EPISODIC_MEMORY_OLLAMA_MAX_PROMPT_CHARS, 24000);
    const timeoutMs = opts.timeoutMs ?? positiveInt(process.env.EPISODIC_MEMORY_API_TIMEOUT_MS, 120000);
    const doFetch = opts.fetchImpl ?? fetch;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const res = await doFetch(`${check.url.replace(/\/+$/, '')}/api/generate`, {
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
