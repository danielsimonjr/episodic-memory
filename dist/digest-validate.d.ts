export interface CitedLines {
    /** Kept lines, marks rewritten to the stable form `[#<exchangeId>,#<exchangeId>]`. */
    lines: string[];
    /** Exchange ids cited by the kept lines, deduplicated, in first-seen order. */
    sources: string[];
    /** Number of non-blank lines rejected. */
    dropped: number;
}
/**
 * Keep only model lines that end in a mark group such as `[3,5]` where every mark names a real
 * exchange. A line with no group, or with any unknown mark, is dropped whole.
 */
export declare function parseCitedLines(raw: string, marks: ReadonlyMap<number, string>): CitedLines;
/** Always redact digest text. Unlike maybeRedactSecrets this ignores the opt-in env: the digest is injected into new sessions. */
export declare function redactEntryText(text: string): string;
