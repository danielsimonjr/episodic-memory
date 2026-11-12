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
 * Number the exchanges of one session and build their transcript block.
 *
 * Each exchange adds two lines, one for its user message and one for its assistant message. Both lines carry the exchange number. Secret-shaped tokens are replaced with `[redacted]`. After redaction, a message longer than 1500 characters keeps its first 1500 characters and ends with `...`.
 *
 * An exchange is skipped when its lines would take the total past `maxChars`. The loop goes on to the next exchange, so a later small exchange can still fit. Skipped exchanges leave gaps in the numbering. The blocks are joined by a blank line.
 *
 * @param exchanges the exchanges, oldest first
 * @param maxChars the cap on the length of the returned text, the blank lines between blocks included
 * @returns the transcript text and the mark number -> exchange id map
 */
export declare function numberExchanges(exchanges: ConversationExchange[], maxChars: number): {
    text: string;
    marks: Map<number, string>;
};
/**
 * Build the summarizer prompt for the exchanges of one session.
 *
 * The transcript comes from `numberExchanges`. The transcript cap defaults to 48000 characters.
 *
 * @param exchanges the exchanges, oldest first
 * @param maxChars the cap on the transcript text, 48000 by default
 */
export declare function buildSessionPrompt(exchanges: ConversationExchange[], maxChars?: number): BuiltPrompt;
/**
 * Build the summarizer prompt that merges the digest notes of one day or one week.
 *
 * A note can end with a source mark, such as `[#id,#id]`. The function renumbers each source mark from 1 in order of first use.
 * `marks` maps each new number to its original id. Blank lines are dropped.
 * A note without a trailing mark keeps its text and gets no number.
 */
export declare function buildCompressPrompt(entries: DigestEntry[], tier: 'day' | 'week'): BuiltPrompt;
