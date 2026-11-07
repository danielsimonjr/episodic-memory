/** The result of the citation check on model output. */
export interface CitedLines {
    /** Kept lines, marks rewritten to the stable form `[#<exchangeId>,#<exchangeId>]`. */
    lines: string[];
    /** Exchange ids cited by the kept lines, deduplicated, in first-seen order. */
    sources: string[];
    /** Number of non-blank lines rejected. */
    dropped: number;
}
/**
 * Keep the model lines that cite only known exchanges, and rewrite their marks.
 *
 * A kept line ends in a mark group such as `[3,5]`. Each number in the group must be a key of `marks`.
 * The function removes a leading bullet marker from each line and skips blank lines without counting them.
 * The function drops a line with no mark group.
 * The function also drops a line that cites an unknown number, and a line with no text before the group.
 * The function rewrites the mark group of a kept line to `[#<exchangeId>,#<exchangeId>]`.
 *
 * @param raw the model output. Each line holds one statement.
 * @param marks maps each mark number to the exchange id that the number names
 */
export declare function parseCitedLines(raw: string, marks: ReadonlyMap<number, string>): CitedLines;
/**
 * Redact the secrets in digest text. The function always redacts.
 *
 * Unlike maybeRedactSecrets, the function does not check the EPISODIC_MEMORY_REDACT_SECRETS setting,
 * because digest text reaches new sessions.
 */
export declare function redactEntryText(text: string): string;
