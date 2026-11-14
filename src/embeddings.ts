import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { InferenceSession } from 'onnxruntime-node';
import type { Tokenizer } from '@huggingface/tokenizers';
import { maybeRedactSecrets } from './redact.js';
import { truncateForIndex } from './constants.js';
import { EMBEDDING_MODEL, EmbeddingsUnavailableError, ensureModel, modelDir } from './embedding-model.js';

export { EmbeddingsUnavailableError };

/**
 * The embedding model: bge-small-en-v1.5, from the Xenova ONNX export, with the `q8` data type.
 *
 * The model produces 384-dimensional vectors, which the exchange_vectors table expects.
 * The code runs the model once per text with onnxruntime-node. It tokenizes with @huggingface/tokenizers.
 * The query embedder adds BGE_QUERY_PREFIX before the embedder embeds a query. The passage embedders do not.
 * See `withQueryPrefix` and `generateQueryEmbedding`.
 */
const MODEL_ONNX_FILE = 'onnx/model_quantized.onnx';
const TOKENIZER_FILE = 'tokenizer.json';
const TOKENIZER_CONFIG_FILE = 'tokenizer_config.json';
/** The maximum number of tokens that the model reads. The code keeps the first ids and drops the rest. */
const MAX_TOKENS = 512;
const EMBED_DIM = 384;
/** The prefix that the query embedder adds to a search query. Passage embeddings do not use it. */
export const BGE_QUERY_PREFIX = 'Represent this sentence for searching relevant passages: ';

/** The loaded runtime: the ONNX session, the tokenizer and the module that made the tensors. */
interface EmbeddingRuntime {
  session: InferenceSession;
  tokenizer: Tokenizer;
  ort: typeof import('onnxruntime-node');
}

let runtimeLoad: Promise<EmbeddingRuntime> | null = null;

/**
 * Load the embedding model. The function does nothing when the model is already loaded.
 *
 * When no model is in memory, the function writes two messages to stderr. The first load can take some time.
 * Calls that overlap a load share one load. If a load fails, the function throws,
 * and the next call tries the load again.
 *
 * @throws EmbeddingsUnavailableError when the model files are not ready or the runtime does not load.
 */
export async function initEmbeddings(): Promise<void> {
  await getRuntime();
}

/** Return the one runtime of this process. The first call starts the load, and overlapping calls share it. */
function getRuntime(): Promise<EmbeddingRuntime> {
  if (!runtimeLoad) {
    runtimeLoad = loadRuntime().then(
      runtime => {
        console.error('Embedding model loaded');
        return runtime;
      },
      error => {
        runtimeLoad = null;
        throw error;
      }
    );
  }
  return runtimeLoad;
}

/**
 * Check the model files, then create the ONNX session and the tokenizer.
 *
 * The model files are never downloaded here. A search or an index run on a host without the files fails at once.
 *
 * @throws EmbeddingsUnavailableError when a file is missing or the runtime does not load. `cause` holds the load error.
 */
async function loadRuntime(): Promise<EmbeddingRuntime> {
  console.error('Loading embedding model (first run may take time)...');
  const dir = modelDir();
  await ensureModel({ download: false, dir });

  let ort: typeof import('onnxruntime-node');
  let tokenizers: typeof import('@huggingface/tokenizers');
  try {
    const onnxModule = await import('onnxruntime-node');
    ort = (onnxModule as unknown as { default?: typeof onnxModule }).default ?? onnxModule;
    tokenizers = await import('@huggingface/tokenizers');
  } catch (error) {
    throw new EmbeddingsUnavailableError(
      'Failed to load the embedding backend (onnxruntime-node). A native binding of onnxruntime-node, ' +
        'the binding path is ONNX_BINDING in src/deps-health.ts, usually causes this failure. ' +
        `Vector search and indexing stay off until the binding loads. Underlying error: ${
          error instanceof Error ? error.message : String(error)
        }`,
      { cause: error }
    );
  }

  try {
    const session = await ort.InferenceSession.create(join(dir, ...MODEL_ONNX_FILE.split('/')));
    const tokenizer = new tokenizers.Tokenizer(
      JSON.parse(readFileSync(join(dir, TOKENIZER_FILE), 'utf-8')),
      JSON.parse(readFileSync(join(dir, TOKENIZER_CONFIG_FILE), 'utf-8'))
    );
    return { session, tokenizer, ort };
  } catch (error) {
    throw new EmbeddingsUnavailableError(
      `Failed to create the embedding session from ${dir} (${EMBEDDING_MODEL.repo}). ` +
        `Underlying error: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error }
    );
  }
}

/** Truncate one passage the same way single and batch paths do. */
function truncateForEmbed(text: string): string {
  // Truncate text to avoid token limits (512 tokens max for bge-small).
  // Empirically, retrieval quality is best at the 2000-char truncation limit;
  // longer inputs degrade mean-pooled embeddings.
  return text.substring(0, 2000);
}

/**
 * Embed one text with the runtime. The function runs the model on this text only, with no padding.
 *
 * The function keeps the first 512 token ids. It takes the mean over the tokens and normalizes the result to length 1.
 */
async function embedOne(runtime: EmbeddingRuntime, text: string): Promise<number[]> {
  const ids = runtime.tokenizer.encode(text).ids.slice(0, MAX_TOKENS);
  const n = ids.length;
  const { ort, session } = runtime;
  // The three input arrays are built once for this text. Every array has n entries.
  const inputIds = BigInt64Array.from(ids, (v) => BigInt(v));
  const attentionMask = new BigInt64Array(n).fill(1n);
  const tokenTypeIds = new BigInt64Array(n);
  const result = await session.run({
    input_ids: new ort.Tensor('int64', inputIds, [1, n]),
    attention_mask: new ort.Tensor('int64', attentionMask, [1, n]),
    token_type_ids: new ort.Tensor('int64', tokenTypeIds, [1, n]),
  });
  const out = result[session.outputNames[0]];
  try {
    const dims = out.dims;
    if (dims.length !== 3 || dims[0] !== 1 || dims[1] !== n || dims[2] !== EMBED_DIM) {
      throw new EmbeddingsUnavailableError(
        `The embedding model returned shape [${dims.join(', ')}]; expected [1, ${n}, ${EMBED_DIM}].`
      );
    }
    const data = out.data as Float32Array;

    const mean = new Array<number>(EMBED_DIM).fill(0);
    for (let t = 0; t < n; t++) {
      for (let k = 0; k < EMBED_DIM; k++) mean[k] += data[t * EMBED_DIM + k] / n;
    }
    let norm = 0;
    for (const v of mean) norm += v * v;
    norm = Math.sqrt(norm);
    return mean.map(v => v / norm);
  } finally {
    // The mean is a copy, so the output tensor can be released now.
    out.dispose?.();
  }
}

/**
 * Embed one or more texts. The function returns an empty list for an empty input.
 *
 * The model runs once per text, so every text gets the same vector alone or in a batch. A padded batch
 * changes the vectors of the q8 model. For that reason, batching does not require a change to EMBEDDING_VERSION.
 */
export async function generateEmbeddings(texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return [];
  const runtime = await getRuntime();
  const vectors: number[][] = [];
  for (const text of texts) {
    vectors.push(await embedOne(runtime, truncateForEmbed(text)));
  }
  return vectors;
}

/**
 * Embed one text and return its vector. The vector has 384 numbers.
 *
 * The function calls generateEmbeddings, so the first call loads the model.
 */
export async function generateEmbedding(text: string): Promise<number[]> {
  const [vec] = await generateEmbeddings([text]);
  return vec;
}

/**
 * Prepend the BGE retrieval prefix to a query string.
 * Idempotent: returns the input unchanged if the prefix is already present.
 */
export function withQueryPrefix(query: string): string {
  if (query.startsWith(BGE_QUERY_PREFIX)) return query;
  return BGE_QUERY_PREFIX + query;
}

/**
 * Embed a search query. The function adds BGE_QUERY_PREFIX before the function embeds the query.
 *
 * Passage embedders, such as generateExchangeEmbedding, do not add the prefix.
 */
export async function generateQueryEmbedding(query: string): Promise<number[]> {
  return generateEmbedding(withQueryPrefix(query));
}

/**
 * Build the passage text that the single and batch exchange embedders use.
 *
 * The function redacts secrets when EPISODIC_MEMORY_REDACT_SECRETS is on, and caps each message before the function joins them.
 * The function lists the tool names after the assistant message when the caller gives at least one tool name.
 */
export function formatExchangeEmbeddingText(
  userMessage: string,
  assistantMessage: string,
  toolNames?: string[]
): string {
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
export async function generateExchangeEmbedding(
  userMessage: string,
  assistantMessage: string,
  toolNames?: string[]
): Promise<number[]> {
  return generateEmbedding(
    formatExchangeEmbeddingText(userMessage, assistantMessage, toolNames)
  );
}

/** Embed a batch of exchanges, as the batch form of `generateExchangeEmbedding`. */
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
