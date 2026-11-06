/**
 * Zod schemas for the MCP tool inputs.
 *
 * The schemas live in this module, not in mcp-server.ts. Tests validate the
 * schemas without starting a stdio transport.
 */
import { z } from 'zod';
/**
 * The search methods that the `mode` input of the `search` tool accepts.
 *
 * `vector` ranks exchanges by semantic similarity. `text` finds exchanges that
 * contain the query text. `both` runs the two methods and combines the results.
 */
export declare const SearchModeEnum: z.ZodEnum<{
    text: "text";
    vector: "vector";
    both: "both";
}>;
/** The output formats of the `search` tool: `markdown` for people, `json` for programs. */
export declare const ResponseFormatEnum: z.ZodEnum<{
    markdown: "markdown";
    json: "json";
}>;
/**
 * The input schema of the `search` tool.
 *
 * The schema rejects unknown fields. A string `query` has at least 2 characters.
 * An array `query` has 2 to 5 strings, and each string has at least 2 characters.
 * The `mode` input applies only to a string `query`.
 * The `after` and `before` inputs must match YYYY-MM-DD. The schema does not check that the date exists.
 * When the caller omits an input, the schema uses these defaults: mode `both`, limit 10 and response_format `markdown`.
 * `assertMcpAuthorized` checks the `auth_token` input, and this schema does not.
 */
export declare const SearchInputSchema: z.ZodObject<{
    query: z.ZodUnion<readonly [z.ZodString, z.ZodArray<z.ZodString>]>;
    mode: z.ZodDefault<z.ZodEnum<{
        text: "text";
        vector: "vector";
        both: "both";
    }>>;
    limit: z.ZodDefault<z.ZodNumber>;
    after: z.ZodOptional<z.ZodString>;
    before: z.ZodOptional<z.ZodString>;
    project: z.ZodOptional<z.ZodString>;
    session_id: z.ZodOptional<z.ZodString>;
    git_branch: z.ZodOptional<z.ZodString>;
    response_format: z.ZodDefault<z.ZodEnum<{
        markdown: "markdown";
        json: "json";
    }>>;
    auth_token: z.ZodOptional<z.ZodString>;
}, z.core.$strict>;
/** The parsed input of the `search` tool, with the schema defaults applied. */
export type SearchInput = z.infer<typeof SearchInputSchema>;
/**
 * The input schema of the `read` tool, which shows one archived conversation.
 *
 * The schema requires a non-empty `path`, but the schema does not check the path.
 * The read tool passes `path` to resolveArchiveJsonlPath. That function refuses a file
 * outside the conversation archive and a file that does not end in .jsonl.
 * `startLine` and `endLine` are 1-indexed and inclusive. Without `startLine`, the read
 * starts at line 1. Without `endLine`, the read runs to the end of the file.
 * A read without a line range fails when the file is larger than the read cap. The
 * EPISODIC_MEMORY_MAX_READ_BYTES variable sets the read cap.
 * `assertMcpAuthorized` checks the `auth_token` input, and this schema does not.
 */
export declare const ShowConversationInputSchema: z.ZodObject<{
    path: z.ZodString;
    startLine: z.ZodOptional<z.ZodNumber>;
    endLine: z.ZodOptional<z.ZodNumber>;
    auth_token: z.ZodOptional<z.ZodString>;
}, z.core.$strict>;
/** The parsed input of the `read` tool. */
export type ShowConversationInput = z.infer<typeof ShowConversationInputSchema>;
/**
 * The input schema of the `digest` tool.
 *
 * The tool checks `expand`, then `handoff`, then `query`. The first one that the caller sets decides the action.
 * When the caller sets none of them, the tool shows the digest for `project`, or for the working directory when the caller omits `project`.
 * The `query` action searches every project when the caller omits `project`.
 * `limit` sets the number of search hits. The default is 10.
 * `handoff` accepts up to 2000 characters. The stored note is one line, redacted, and capped at 500 characters.
 * `assertMcpAuthorized` checks the `auth_token` input, and this schema does not.
 */
export declare const DigestInputSchema: z.ZodObject<{
    query: z.ZodOptional<z.ZodString>;
    project: z.ZodOptional<z.ZodString>;
    limit: z.ZodOptional<z.ZodNumber>;
    expand: z.ZodOptional<z.ZodString>;
    handoff: z.ZodOptional<z.ZodString>;
    auth_token: z.ZodOptional<z.ZodString>;
}, z.core.$strict>;
/** The parsed input of the `digest` tool. */
export type DigestInput = z.infer<typeof DigestInputSchema>;
/**
 * The input schema of the `skills` tool.
 *
 * The tool checks `get`, then `query`. The first one that the caller sets decides the action.
 * When the caller sets neither, the tool lists the learned skills.
 * `project` selects the project for each action. The default is the working directory.
 * `limit` sets the number of skills that the `query` action and the list action return. The default is 10.
 * When the learn feature is off, the tool returns a fixed message.
 * `assertMcpAuthorized` checks the `auth_token` input, and this schema does not.
 */
export declare const SkillsInputSchema: z.ZodObject<{
    get: z.ZodOptional<z.ZodString>;
    query: z.ZodOptional<z.ZodString>;
    project: z.ZodOptional<z.ZodString>;
    limit: z.ZodOptional<z.ZodNumber>;
    auth_token: z.ZodOptional<z.ZodString>;
}, z.core.$strict>;
/** The parsed input of the `skills` tool. */
export type SkillsInput = z.infer<typeof SkillsInputSchema>;
/**
 * Format a caught value as the text of an MCP error result.
 *
 * An Error gives its message. Any other value gives its String form. The text always starts with "Error: ".
 *
 * @param error the value that the tool handler caught
 */
export declare function handleMcpError(error: unknown): string;
