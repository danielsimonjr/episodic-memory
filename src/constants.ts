/**
 * Marker text that identifies summarizer agent conversations.
 * When this text appears in a conversation, it will be excluded from indexing.
 * Used in summarizer prompts to prevent agent conversations from polluting search results.
 */
export const SUMMARIZER_CONTEXT_MARKER =
  'Context: This summary will be shown in a list to help users and Claude choose which conversations are relevant';

/**
 * Cap on how many characters of a single message we index.
 *
 * The EXCLUSION_MARKERS defence in sync.ts is *cooperative* — it only skips
 * transcripts from agents that emit a known marker. Third-party plugins that
 * summarize conversations (a common pattern) spawn subagents whose prompt embeds
 * the entire conversation being summarized, emit no marker, and are therefore
 * indexed like any other chat. The result is a "user message" of several MB.
 *
 * Measured on a real install before this guard existed:
 *   median user_message      1,636 bytes
 *   largest user_message  3,109,374 bytes
 *   1,301 such rows       2.53 GB = 97.2% of a 3.04 GB database
 *
 * 256 KB is ~150x the median, so no human-authored message comes close, while
 * machine-generated prompt payload is cut off. Override with
 * EPISODIC_MEMORY_MAX_MESSAGE_BYTES (0 or negative disables the guard).
 */
export const MAX_INDEXED_MESSAGE_BYTES = (() => {
  const raw = process.env.EPISODIC_MEMORY_MAX_MESSAGE_BYTES;
  if (raw === undefined) return 262_144;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : 262_144;
})();

/** Suffix appended to a truncated message, recording what was dropped. */
export function truncationNoticeFor(originalLength: number): string {
  return `\n\n[truncated by episodic-memory: ${originalLength} chars exceeded the ${MAX_INDEXED_MESSAGE_BYTES}-char index cap]`;
}

/**
 * Cap a message for indexing.
 *
 * Keep the head, so the message stays searchable and the source remains identifiable.
 * Idempotent: re-truncating an already-truncated string is a no-op, so re-indexing
 * never stacks notices.
 */
export function truncateForIndex(message: string): string {
  if (!message || MAX_INDEXED_MESSAGE_BYTES <= 0) return message;
  if (message.length <= MAX_INDEXED_MESSAGE_BYTES) return message;
  if (message.includes('[truncated by episodic-memory:')) return message;
  return message.slice(0, MAX_INDEXED_MESSAGE_BYTES) + truncationNoticeFor(message.length);
}

/** Prompt budget of the Ollama backend, in characters: the default of EPISODIC_MEMORY_OLLAMA_MAX_PROMPT_CHARS. */
export const OLLAMA_MAX_PROMPT_CHARS_DEFAULT = 24000;

/** Prompt budget of the Claude backend, in characters. */
export const CLAUDE_MAX_PROMPT_CHARS = 48000;

/**
 * Defaults of the topic memory limits. Each limit with an environment variable is read from it at call time,
 * and an invalid value falls back to the default here.
 */
export const TOPIC_DEFAULTS = {
  /** EPISODIC_MEMORY_TOPICS_MAX_SESSIONS: sessions that reach the model per run. */
  maxSessions: 3,
  /** EPISODIC_MEMORY_TOPICS_MAX_TRANSCRIPT_CHARS: the numbered transcript of one session. */
  maxTranscriptChars: 10000,
  /** EPISODIC_MEMORY_TOPICS_MAX_DOCS_CHARS: the full text of the documents shown in one prompt. */
  maxDocsChars: 10000,
  /** EPISODIC_MEMORY_TOPICS_MAX_DOC_CHARS: the length of one document. */
  maxDocChars: 8000,
  /** EPISODIC_MEMORY_TOPICS_MAX_DOCS: the number of documents of one project. */
  maxDocs: 50,
  /** Failed model calls of one session before the session is rejected. */
  maxFailedCalls: 3,
  /** Prompt characters kept free for the error list that a retry adds. */
  retryReserveChars: 1000,
} as const;

/** Return true when topic memory is on. The flag is on only when EPISODIC_MEMORY_TOPICS is exactly `1`. */
export function topicsEnabled(): boolean {
  return process.env.EPISODIC_MEMORY_TOPICS === '1';
}

/**
 * Read a positive integer from an environment variable.
 *
 * An unset, invalid or non-positive value gives `fallback`.
 */
export function envPositiveInt(name: string, fallback: number): number {
  const n = Number(process.env[name]);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}
