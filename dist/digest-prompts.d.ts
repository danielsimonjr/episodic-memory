import type { ConversationExchange } from './types.js';
import type { DigestEntry } from './digest-db.js';
/**
 * A summarizer prompt, with the numbers that the prompt uses.
 *
 * `marks` maps each number in `prompt` to the exchange id that the number stands for.
 */
export interface BuiltPrompt {
    prompt: string;
    /** Mark number used in the prompt -> exchange id. */
    marks: Map<number, string>;
}
/**
 * Build the summarizer prompt for the exchanges of one session.
 *
 * Each exchange adds two lines, one for its user message and one for its assistant message. Both lines carry the exchange number. Secret-shaped tokens are replaced with `[redacted]`. After redaction, a message longer than 1500 characters keeps its first 1500 characters and ends with `...`.
 *
 * An exchange is skipped when its lines would take the total past 48000 characters. Skipped exchanges leave gaps in the numbering.
 */
export declare function buildSessionPrompt(exchanges: ConversationExchange[]): BuiltPrompt;
/**
 * Build the summarizer prompt that merges the digest notes of one day or one week.
 *
 * A note can end with a source mark, such as `[#id,#id]`. The function renumbers each source mark from 1 in order of first use.
 * `marks` maps each new number to its original id. Blank lines are dropped.
 * A note without a trailing mark keeps its text and gets no number.
 */
export declare function buildCompressPrompt(entries: DigestEntry[], tier: 'day' | 'week'): BuiltPrompt;
