/**
 * One tool call that an agent made during an exchange.
 *
 * `toolInput` holds the arguments as the transcript stores them. `toolResult` holds the result text, when the transcript has one. `isError` is true when the result reports an error.
 */
export interface ToolCall {
    id: string;
    exchangeId: string;
    toolName: string;
    toolInput?: any;
    toolResult?: string;
    isError: boolean;
    timestamp: string;
}
/**
 * The agent that wrote a transcript: Claude Code (`claude`) or Codex (`codex`).
 */
export type ConversationHarness = 'claude' | 'codex';
/**
 * One user message and the assistant messages that follow it, as read from one transcript.
 *
 * `archivePath`, `lineStart` and `lineEnd` locate the exchange in its archived transcript. The optional fields hold session context and thinking metadata, when the transcript provides them.
 */
export interface ConversationExchange {
    id: string;
    project: string;
    timestamp: string;
    userMessage: string;
    assistantMessage: string;
    archivePath: string;
    lineStart: number;
    lineEnd: number;
    parentUuid?: string;
    isSidechain?: boolean;
    harness?: ConversationHarness;
    sessionId?: string;
    cwd?: string;
    gitBranch?: string;
    claudeVersion?: string;
    agentVersion?: string;
    model?: string;
    modelProvider?: string;
    thinkingLevel?: string;
    thinkingDisabled?: boolean;
    thinkingTriggers?: string;
    toolCalls?: ToolCall[];
}
/**
 * One hit from a single-query search, with its exchange and a snippet of its user message.
 *
 * `similarity` is the cosine similarity to the query, from -1 to 1. A text-only search leaves `similarity` undefined. In a `both` search, a text hit reports 1, because the text query sets its distance to 0.
 */
export interface SearchResult {
    exchange: ConversationExchange;
    similarity: number;
    snippet: string;
    summary?: string;
}
/**
 * One conversation that has a hit for every concept of a multi-concept search.
 *
 * `conceptSimilarities` has one value for each concept, in query order. `averageSimilarity` is the mean of those values. `exchange` and `snippet` come from the best matching exchange for the first concept.
 */
export interface MultiConceptResult {
    exchange: ConversationExchange;
    snippet: string;
    conceptSimilarities: number[];
    averageSimilarity: number;
    summary?: string;
}
