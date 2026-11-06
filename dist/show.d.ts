/**
 * Format a conversation transcript as Markdown.
 *
 * A Codex rollout uses the Codex formatter. Every other transcript uses the Claude formatter.
 * The Claude formatter skips non-conversation messages, messages without a timestamp and messages without content.
 * The Claude formatter keeps an assistant message without content when the message has usage data.
 * The Claude formatter throws a SyntaxError when a line is not valid JSON.
 * The line numbers count the non-blank lines of `jsonl`.
 *
 * @param jsonl the transcript, one JSON object for each line. The function skips blank lines.
 * @param startLine the first line to format, 1-indexed and inclusive. The default is the first line.
 * @param endLine the last line to format, 1-indexed and inclusive. The default is the last line.
 */
export declare function formatConversationAsMarkdown(jsonl: string, startLine?: number, endLine?: number): string;
/**
 * Format a conversation transcript as a complete HTML document.
 *
 * The function formats a Codex rollout as Markdown first, and then converts the Markdown to HTML.
 * The function renders every other transcript to HTML directly.
 * The Claude path throws a SyntaxError when a line is not valid JSON.
 *
 * @param jsonl the transcript, one JSON object for each line. The function skips blank lines.
 */
export declare function formatConversationAsHTML(jsonl: string): string;
