/**
 * Citation gate for tool-using agents.
 *
 * A model that read the archive cites the exchanges it read, as a trailing
 * mark group: `[#<32 hex>, #<32 hex>, @<attempt id>]`. A line is kept only
 * when
 *
 * 1. it ends in such a group,
 * 2. the group holds at least one `#` exchange mark (an `@`-only line, or a
 *    numeric digest-style mark such as `[7]`, is not grounding),
 * 3. every mark resolves (the resolvers are injected, so this stays pure), and
 * 4. the line shares at least `minGrounding` distinct content tokens with the
 *    text of at least one cited exchange — a real id pinned to an unrelated
 *    sentence is not a citation.
 *
 * The existing `parseCitedLines` in `digest-validate.ts` is a different gate
 * for text-only prompts that carry a numeric mark map; it is unchanged.
 */
import type { SourceRef } from './types.js';
export type DropReason = 'no-marks' | 'unknown-id' | 'ungrounded';
export interface IdResolvers {
    exchange: (id: string) => {
        ref: SourceRef;
        text: string;
    } | null;
    attempt: (id: number) => boolean;
}
export interface IdCitedLines {
    /** Kept lines, with the mark group exactly as the model wrote it. */
    lines: string[];
    /** Sources of every cited exchange, deduplicated, in first-seen order. */
    sources: SourceRef[];
    /** Cited attempt ids, deduplicated, in first-seen order. */
    attempts: number[];
    /** Lines that were dropped, with why. Blank lines are not reported. */
    dropped: Array<{
        line: string;
        reason: DropReason;
    }>;
}
/**
 * Parse and filter a model's cited body.
 *
 * `minGrounding` is `EPISODIC_MEMORY_LEARN_MIN_GROUNDING` (default 3).
 */
export declare function parseIdCitedLines(raw: string, resolve: IdResolvers, minGrounding: number): IdCitedLines;
