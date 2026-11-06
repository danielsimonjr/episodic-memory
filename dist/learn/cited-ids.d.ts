/**
 * Citation gate for model-written learned text.
 *
 * Tool-using agents see real exchange ids, so their lines must end in a mark
 * group naming those ids: `[#<32 hex>,...]`, and a reflection may add
 * `[@<attemptId>]` marks in the same group. A line survives only when it has at
 * least one `#` mark, every mark resolves, and the line shares enough content
 * tokens with one cited exchange to make the citation meaningful.
 *
 * This module is pure: the resolvers are injected, it reads no environment, and
 * it imports only types. The digest's text-only `parseCitedLines` is untouched
 * and still owns the `[3,5]` mark-map form.
 */
import type { SourceRef } from './types.js';
export interface ResolvedExchange {
    ref: SourceRef;
    /** The exchange text the grounding check compares against. */
    text: string;
}
export interface IdCitationResolver {
    exchange: (id: string) => ResolvedExchange | null;
    attempt: (id: number) => boolean;
}
export type DropReason = 'no-marks' | 'unknown-id' | 'ungrounded';
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
 * A kept line keeps its body and gets its marks rewritten to the canonical
 * form, so a downstream writer stores one citation shape. Blank lines are
 * skipped without counting as drops; every other rejected line is reported
 * with its reason.
 */
export declare function parseIdCitedLines(raw: string, resolve: IdCitationResolver, minGrounding: number): IdCitedLines;
