/**
 * Helpers that read the message content of a transcript line. Imports nothing.
 *
 * `parser.ts` (indexing) and `show.ts` (the `read` tool) read the same Claude Code and Codex content shapes.
 * Both use these helpers, so the indexed text and the shown text cannot drift apart.
 */
/**
 * Return the text of a message content.
 * The function returns a string content unchanged. For an array, the function joins the `text` strings of the blocks
 * with a newline. The function skips every other block. Any other value gives an empty string.
 */
export declare function extractContentText(content: unknown): string;
/** Parse `value` as JSON. When the text is not valid JSON, return `value` unchanged. */
export declare function safeParseJson(value: string): unknown;
