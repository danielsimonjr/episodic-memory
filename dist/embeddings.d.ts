/** The prefix that the query embedder adds to a search query. Passage embeddings do not use it. */
export declare const BGE_QUERY_PREFIX = "Represent this sentence for searching relevant passages: ";
/**
 * Load the embedding model. The function does nothing when the model is already loaded.
 *
 * When no model is in memory, the function writes two messages to stderr. The first load can take some time.
 * Calls that overlap a load can start more than one load. If a load fails, the function throws,
 * and the next call tries the load again.
 */
export declare function initEmbeddings(): Promise<void>;
/**
 * Embed one or more texts in one pipeline call. The function returns an empty list for an empty input.
 *
 * Each text gets the same truncation, mean pooling and normalization as a single-text call.
 * For that reason, batching does not require a change to EMBEDDING_VERSION.
 */
export declare function generateEmbeddings(texts: string[]): Promise<number[][]>;
/**
 * Embed one text and return its vector. The vector has 384 numbers.
 *
 * The function calls generateEmbeddings, so the first call loads the model.
 */
export declare function generateEmbedding(text: string): Promise<number[]>;
/**
 * Prepend the BGE retrieval prefix to a query string. Idempotent: returns
 * the input unchanged if the prefix is already present.
 */
export declare function withQueryPrefix(query: string): string;
/**
 * Embed a search query. The function adds BGE_QUERY_PREFIX before the function embeds the query.
 *
 * Passage embedders, such as generateExchangeEmbedding, do not add the prefix.
 */
export declare function generateQueryEmbedding(query: string): Promise<number[]>;
/**
 * Build the passage text that the single and batch exchange embedders use.
 *
 * The function redacts secrets when EPISODIC_MEMORY_REDACT_SECRETS is on, and caps each message before the function joins them.
 * The function lists the tool names after the assistant message when the caller gives at least one tool name.
 */
export declare function formatExchangeEmbeddingText(userMessage: string, assistantMessage: string, toolNames?: string[]): string;
/**
 * Embed one exchange as a passage. The function formats the text with formatExchangeEmbeddingText.
 * The function does not add the query prefix.
 *
 * @param toolNames the tool names to list after the assistant message. Optional.
 */
export declare function generateExchangeEmbedding(userMessage: string, assistantMessage: string, toolNames?: string[]): Promise<number[]>;
/** Embed a batch of exchanges in one pipeline call, as the batch form of `generateExchangeEmbedding`. */
export declare function generateExchangeEmbeddings(items: Array<{
    userMessage: string;
    assistantMessage: string;
    toolNames?: string[];
}>): Promise<number[][]>;
