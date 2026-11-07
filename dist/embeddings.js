import { pipeline, env } from '@huggingface/transformers';
import { maybeRedactSecrets } from './redact.js';
import { truncateForIndex } from './constants.js';
// In MCP, stdout must carry only JSON-RPC communication. These settings
// allow models from local files and turn off the browser cache.
env.allowLocalModels = true;
env.useBrowserCache = false;
/**
 * The embedding model: bge-small-en-v1.5, from the Xenova ONNX export, with the `q8` data type.
 *
 * The model produces 384-dimensional vectors, which the vec_exchanges table expects.
 * The query embedder adds BGE_QUERY_PREFIX before the embedder embeds a query. The passage embedders do not.
 * See `withQueryPrefix` and `generateQueryEmbedding`.
 */
const MODEL_ID = 'Xenova/bge-small-en-v1.5';
const MODEL_DTYPE = 'q8';
/** The prefix that the query embedder adds to a search query. Passage embeddings do not use it. */
export const BGE_QUERY_PREFIX = 'Represent this sentence for searching relevant passages: ';
let embeddingPipeline = null;
/**
 * Load the embedding model. The function does nothing when the model is already loaded.
 *
 * When no model is in memory, the function writes two messages to stderr. The first load can take some time.
 * Calls that overlap a load can start more than one load. If a load fails, the function throws,
 * and the next call tries the load again.
 */
export async function initEmbeddings() {
    if (!embeddingPipeline) {
        console.error('Loading embedding model (first run may take time)...');
        embeddingPipeline = await pipeline('feature-extraction', MODEL_ID, { dtype: MODEL_DTYPE, progress_callback: () => { } });
        console.error('Embedding model loaded');
    }
}
/** Truncate one passage the same way single and batch paths do. */
function truncateForEmbed(text) {
    // Truncate text to avoid token limits (512 tokens max for bge-small).
    // Empirically, retrieval quality is best at the 2000-char truncation limit;
    // longer inputs degrade mean-pooled embeddings.
    return text.substring(0, 2000);
}
const EMBED_DIM = 384;
/**
 * Embed one or more texts in one pipeline call. The function returns an empty list for an empty input.
 *
 * Each text gets the same truncation, mean pooling and normalization as a single-text call.
 * For that reason, batching does not require a change to EMBEDDING_VERSION.
 */
export async function generateEmbeddings(texts) {
    if (texts.length === 0)
        return [];
    if (!embeddingPipeline) {
        await initEmbeddings();
    }
    const truncated = texts.map(truncateForEmbed);
    const output = await embeddingPipeline(truncated, {
        pooling: 'mean',
        normalize: true,
    });
    const data = output.data;
    if (truncated.length === 1) {
        return [Array.from(data)];
    }
    // Batch output is a flat [N * dim] Float32Array (dims typically [N, dim]).
    const vectors = [];
    for (let i = 0; i < truncated.length; i++) {
        const offset = i * EMBED_DIM;
        vectors.push(Array.from(data.subarray(offset, offset + EMBED_DIM)));
    }
    return vectors;
}
/**
 * Embed one text and return its vector. The vector has 384 numbers.
 *
 * The function calls generateEmbeddings, so the first call loads the model.
 */
export async function generateEmbedding(text) {
    const [vec] = await generateEmbeddings([text]);
    return vec;
}
/**
 * Prepend the BGE retrieval prefix to a query string.
 * Idempotent: returns the input unchanged if the prefix is already present.
 */
export function withQueryPrefix(query) {
    if (query.startsWith(BGE_QUERY_PREFIX))
        return query;
    return BGE_QUERY_PREFIX + query;
}
/**
 * Embed a search query. The function adds BGE_QUERY_PREFIX before the function embeds the query.
 *
 * Passage embedders, such as generateExchangeEmbedding, do not add the prefix.
 */
export async function generateQueryEmbedding(query) {
    return generateEmbedding(withQueryPrefix(query));
}
/**
 * Build the passage text that the single and batch exchange embedders use.
 *
 * The function redacts secrets when EPISODIC_MEMORY_REDACT_SECRETS is on, and caps each message before the function joins them.
 * The function lists the tool names after the assistant message when the caller gives at least one tool name.
 */
export function formatExchangeEmbeddingText(userMessage, assistantMessage, toolNames) {
    // The function redacts and caps each message before it joins them, so a multi-MB
    // payload never reaches the combined string.
    const user = truncateForIndex(maybeRedactSecrets(userMessage));
    const assistant = truncateForIndex(maybeRedactSecrets(assistantMessage));
    let combined = `User: ${user}\n\nAssistant: ${assistant}`;
    if (toolNames && toolNames.length > 0) {
        combined += `\n\nTools: ${toolNames.join(', ')}`;
    }
    return combined;
}
/**
 * Embed one exchange as a passage. The function formats the text with formatExchangeEmbeddingText.
 * The function does not add the query prefix.
 *
 * @param toolNames the tool names to list after the assistant message. Optional.
 */
export async function generateExchangeEmbedding(userMessage, assistantMessage, toolNames) {
    return generateEmbedding(formatExchangeEmbeddingText(userMessage, assistantMessage, toolNames));
}
/** Embed a batch of exchanges in one pipeline call, as the batch form of `generateExchangeEmbedding`. */
export async function generateExchangeEmbeddings(items) {
    return generateEmbeddings(items.map((item) => formatExchangeEmbeddingText(item.userMessage, item.assistantMessage, item.toolNames)));
}
