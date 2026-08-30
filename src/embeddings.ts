import { pipeline, FeatureExtractionPipeline, env } from '@huggingface/transformers';
import { maybeRedactSecrets } from './redact.js';
import { truncateForIndex } from './constants.js';

// Disable progress callbacks to prevent stdout pollution in MCP context
// In MCP, stdout is reserved for JSON-RPC communication.
env.allowLocalModels = true;
env.useBrowserCache = false;

/**
 * Embedding model configuration.
 *
 * Using BAAI's bge-small-en-v1.5 (via Xenova's ONNX export) instead of the
 * older all-MiniLM-L6-v2 — measured +6.34 R@1 on a 17K-corpus retrieval test
 * against real production data. Same 384 dimensions, so vec_exchanges schema
 * is unchanged.
 *
 * BGE models recommend prepending a task prefix to QUERY embeddings only
 * (passages/documents go through unmodified). See `withQueryPrefix` and
 * `generateQueryEmbedding` below.
 */
const MODEL_ID = 'Xenova/bge-small-en-v1.5';
const MODEL_DTYPE = 'q8';
export const BGE_QUERY_PREFIX = 'Represent this sentence for searching relevant passages: ';

let embeddingPipeline: FeatureExtractionPipeline | null = null;

export async function initEmbeddings(): Promise<void> {
  if (!embeddingPipeline) {
    console.error('Loading embedding model (first run may take time)...');
    embeddingPipeline = await pipeline(
      'feature-extraction',
      MODEL_ID,
      { dtype: MODEL_DTYPE, progress_callback: () => {} }
    );
    console.error('Embedding model loaded');
  }
}

/** Truncate one passage the same way single and batch paths do. */
function truncateForEmbed(text: string): string {
  // Truncate text to avoid token limits (512 tokens max for bge-small).
  // Empirically, retrieval quality is best at the 2000-char truncation limit;
  // longer inputs degrade mean-pooled embeddings.
  return text.substring(0, 2000);
}

const EMBED_DIM = 384;

/**
 * Embed one or more texts in a single pipeline call.
 * Semantics match repeated `generateEmbedding` calls (same truncate / pool /
 * normalize), so batching does not require an EMBEDDING_VERSION bump.
 */
export async function generateEmbeddings(texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return [];
  if (!embeddingPipeline) {
    await initEmbeddings();
  }

  const truncated = texts.map(truncateForEmbed);
  const output = await embeddingPipeline!(truncated, {
    pooling: 'mean',
    normalize: true,
  });

  const data = output.data as Float32Array;
  if (truncated.length === 1) {
    return [Array.from(data)];
  }

  // Batch output is a flat [N * dim] Float32Array (dims typically [N, dim]).
  const vectors: number[][] = [];
  for (let i = 0; i < truncated.length; i++) {
    const offset = i * EMBED_DIM;
    vectors.push(Array.from(data.subarray(offset, offset + EMBED_DIM)));
  }
  return vectors;
}

export async function generateEmbedding(text: string): Promise<number[]> {
  const [vec] = await generateEmbeddings([text]);
  return vec;
}

/**
 * Prepend the BGE retrieval prefix to a query string. Idempotent: returns
 * the input unchanged if the prefix is already present.
 */
export function withQueryPrefix(query: string): string {
  if (query.startsWith(BGE_QUERY_PREFIX)) return query;
  return BGE_QUERY_PREFIX + query;
}

/**
 * Generate an embedding for a search QUERY. Adds the model-specific prefix
 * before embedding, which gives a small but consistent recall lift on
 * retrieval tasks. Document/passage embeddings (`generateExchangeEmbedding`)
 * stay unmodified — that's the asymmetric pattern BGE models are trained for.
 */
export async function generateQueryEmbedding(query: string): Promise<number[]> {
  return generateEmbedding(withQueryPrefix(query));
}

/** Build the passage text that both single and batch exchange embedders use. */
export function formatExchangeEmbeddingText(
  userMessage: string,
  assistantMessage: string,
  toolNames?: string[]
): string {
  // Redact then cap before concatenate so multi-MB prompt payload is never
  // allocated into the combined string (insertExchange already caps at store).
  const user = truncateForIndex(maybeRedactSecrets(userMessage));
  const assistant = truncateForIndex(maybeRedactSecrets(assistantMessage));
  let combined = `User: ${user}\n\nAssistant: ${assistant}`;
  if (toolNames && toolNames.length > 0) {
    combined += `\n\nTools: ${toolNames.join(', ')}`;
  }
  return combined;
}

export async function generateExchangeEmbedding(
  userMessage: string,
  assistantMessage: string,
  toolNames?: string[]
): Promise<number[]> {
  return generateEmbedding(
    formatExchangeEmbeddingText(userMessage, assistantMessage, toolNames)
  );
}

/** Batch variant of `generateExchangeEmbedding` — one ONNX forward pass. */
export async function generateExchangeEmbeddings(
  items: Array<{
    userMessage: string;
    assistantMessage: string;
    toolNames?: string[];
  }>
): Promise<number[][]> {
  return generateEmbeddings(
    items.map((item) =>
      formatExchangeEmbeddingText(
        item.userMessage,
        item.assistantMessage,
        item.toolNames
      )
    )
  );
}
