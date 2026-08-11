export declare const BGE_QUERY_PREFIX = "Represent this sentence for searching relevant passages: ";
export declare function initEmbeddings(): Promise<void>;
/**
 * Embed one or more texts in a single pipeline call.
 * Semantics match repeated `generateEmbedding` calls (same truncate / pool /
 * normalize), so batching does not require an EMBEDDING_VERSION bump.
 */
export declare function generateEmbeddings(texts: string[]): Promise<number[][]>;
export declare function generateEmbedding(text: string): Promise<number[]>;
/**
 * Prepend the BGE retrieval prefix to a query string. Idempotent: returns
 * the input unchanged if the prefix is already present.
 */
export declare function withQueryPrefix(query: string): string;
/**
 * Generate an embedding for a search QUERY. Adds the model-specific prefix
 * before embedding, which gives a small but consistent recall lift on
 * retrieval tasks. Document/passage embeddings (`generateExchangeEmbedding`)
 * stay unmodified — that's the asymmetric pattern BGE models are trained for.
 */
export declare function generateQueryEmbedding(query: string): Promise<number[]>;
/** Build the passage text that both single and batch exchange embedders use. */
export declare function formatExchangeEmbeddingText(userMessage: string, assistantMessage: string, toolNames?: string[]): string;
export declare function generateExchangeEmbedding(userMessage: string, assistantMessage: string, toolNames?: string[]): Promise<number[]>;
/** Batch variant of `generateExchangeEmbedding` — one ONNX forward pass. */
export declare function generateExchangeEmbeddings(items: Array<{
    userMessage: string;
    assistantMessage: string;
    toolNames?: string[];
}>): Promise<number[][]>;
