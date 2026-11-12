/**
 * The `topics` MCP tool: read the topic memory documents of a project.
 *
 * The module holds the read-only half of the tool. `mcp-tools.ts` imports this module
 * inside the `topics` branch, so a session that never calls the tool loads nothing of
 * the feature. The module imports no writer, no summarizer and no model client.
 *
 * The tool never writes. It opens the index read-only, and it answers that topic memory has
 * no documents yet when the index file or the topic tables do not exist.
 * It does not check the topic flag: the MCP server never sees that variable.
 */
import type { TopicsInput } from './mcp-schemas.js';
/** The text that the tool returns when the topic tables do not exist. */
export declare const NO_TOPICS_MESSAGE = "Topic memory has no documents yet.";
/**
 * Behavior of the `topics` MCP tool. Runs one action on the project, and returns redacted text.
 *
 * `project` defaults to the key for the working directory. The index opens read-only once for the call
 * and closes in `finally`.
 */
export declare function topicsToolText(params: TopicsInput): string;
