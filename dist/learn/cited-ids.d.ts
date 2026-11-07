/**
 * Citation gate for model-written learned text.
 *
 * Tool-using agents see real exchange ids. Their lines must end in a mark group
 * that names those ids: `[#<32 hex>,...]`. A reflection may add `[@<attemptId>]`
 * marks in the same group. The gate keeps a line only when all three
 * tests pass:
 *
 * - the line has at least one `#` mark;
 * - every mark resolves;
 * - the line shares enough content tokens with one cited exchange to make the
 *   citation meaningful.
 *
 * The module is pure. Callers inject the resolvers. The module reads no environment and imports only types.
 * The digest's text-only `parseCitedLines` is a separate function that owns the `[3,5]` mark-map form.
 */
import type { SourceRef } from './types.js';
/** An exchange that an exchange mark resolves to. */
export interface ResolvedExchange {
    ref: SourceRef;
    /** The exchange text the grounding check compares against. */
    text: string;
}
/**
 * The lookups that parseIdCitedLines uses to resolve the marks of a line.
 *
 * The caller supplies the lookups, so the parser reads no store.
 */
export interface IdCitationResolver {
    /** Return the exchange for this id, or null when no such exchange exists. The id has no leading `#`. */
    exchange: (id: string) => ResolvedExchange | null;
    /** Return true when this attempt id exists. */
    attempt: (id: number) => boolean;
}
/**
 * The reason that the citation gate dropped a line.
 *
 * `no-marks` means the line has no usable citation group, or no text before the group.
 * `unknown-id` means that a mark does not resolve.
 * `ungrounded` means that no cited exchange shares enough content tokens with the line.
 */
export type DropReason = 'no-marks' | 'unknown-id' | 'ungrounded';
/** The result of parseIdCitedLines. */
export interface IdCitedLines {
    /** Kept lines, marks rewritten to the canonical `[#<id>,@<n>]` form. */
    lines: string[];
    /** Every exchange cited by a kept line, deduplicated, in first-seen order. */
    sources: SourceRef[];
    /** Every attempt id cited by a kept line, deduplicated, in first-seen order. */
    attempts: number[];
    /** Lines rejected, with the reason, in input order. */
    dropped: Array<{
        line: string;
        reason: DropReason;
    }>;
}
/**
 * Split a model's answer into the lines the citation gate keeps.
 *
 * A kept line keeps its body.
 * The function rewrites its marks to the canonical form, so a downstream writer stores one citation shape.
 * The function skips blank lines without counting them as drops.
 * The function reports every other rejected line with its reason.
 *
 * @param raw the model answer, one statement for each line
 * @param resolve looks up the exchange marks and the attempt marks
 * @param minGrounding the number of content tokens that a line must share with one cited exchange
 */
export declare function parseIdCitedLines(raw: string, resolve: IdCitationResolver, minGrounding: number): IdCitedLines;
