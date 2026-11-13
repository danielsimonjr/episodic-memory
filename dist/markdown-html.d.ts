/**
 * Markdown to HTML renderer for the transcript viewer. Node built-ins only.
 * Every block and inline rule is a line or token scan. No regex has nested
 * quantifiers over unbounded input.
 */
/** Escape the five HTML-special characters of a text or attribute value. */
export declare function escapeHtml(text: string): string;
/**
 * Render Markdown text to HTML. The function escapes all raw HTML and refuses unsafe link schemes.
 * The function never throws. Each block ends with one newline.
 * Not supported: indented code, setext headings, images (a `!` then the link rule),
 * angle and email autolinks, www autolinks, strikethrough, raw HTML blocks and reference links.
 */
export declare function markdownToHtml(text: string): string;
