/**
 * Zod schemas for MCP tool inputs. Kept out of mcp-server.ts so tests can
 * validate them without starting a stdio transport.
 */
import { z } from 'zod';
export const SearchModeEnum = z.enum(['vector', 'text', 'both']);
export const ResponseFormatEnum = z.enum(['markdown', 'json']);
export const SearchInputSchema = z
    .object({
    query: z
        .union([
        z.string().min(2, 'Query must be at least 2 characters'),
        z
            .array(z.string().min(2))
            .min(2, 'Must provide at least 2 concepts for multi-concept search')
            .max(5, 'Cannot search more than 5 concepts at once'),
    ])
        .describe('Search query - string for single concept, array of strings for multi-concept AND search'),
    mode: SearchModeEnum.default('both').describe('Search mode: "vector" for semantic similarity, "text" for exact matching, "both" for combined (default: "both"). Only used for single-concept searches.'),
    limit: z
        .number()
        .int()
        .min(1)
        .max(50)
        .default(10)
        .describe('Maximum number of results to return (default: 10)'),
    after: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/, 'Date must be in YYYY-MM-DD format')
        .optional()
        .describe('Only return conversations after this date (YYYY-MM-DD format)'),
    before: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/, 'Date must be in YYYY-MM-DD format')
        .optional()
        .describe('Only return conversations before this date (YYYY-MM-DD format)'),
    project: z.string().min(1).optional().describe('Filter by project name (exact match)'),
    session_id: z.string().min(1).optional().describe('Filter by session ID (exact match)'),
    git_branch: z.string().min(1).optional().describe('Filter by git branch name (exact match)'),
    response_format: ResponseFormatEnum.default('markdown').describe('Output format: "markdown" for human-readable or "json" for machine-readable (default: "markdown")'),
    auth_token: z
        .string()
        .min(1)
        .optional()
        .describe('Required when EPISODIC_MEMORY_MCP_TOKEN is set'),
})
    .strict();
export const ShowConversationInputSchema = z
    .object({
    path: z
        .string()
        .min(1, 'Path is required')
        .describe('Absolute path to the JSONL conversation file to display'),
    startLine: z
        .number()
        .int()
        .min(1)
        .optional()
        .describe('Starting line number (1-indexed, inclusive). Omit to start from beginning.'),
    endLine: z
        .number()
        .int()
        .min(1)
        .optional()
        .describe('Ending line number (1-indexed, inclusive). Omit to read to end.'),
    auth_token: z
        .string()
        .min(1)
        .optional()
        .describe('Required when EPISODIC_MEMORY_MCP_TOKEN is set'),
})
    .strict();
export const DigestInputSchema = z
    .object({
    query: z.string().min(1).optional().describe('Search the digest instead of showing it'),
    project: z
        .string()
        .min(1)
        .optional()
        .describe('Project key. Defaults to the key for the current working directory.'),
    limit: z.number().int().min(1).max(50).optional().describe('Max search hits (default 10)'),
    expand: z
        .string()
        .min(1)
        .optional()
        .describe('An exchange id from a [#id] mark. Returns the archive path and line range to pass to read.'),
    handoff: z
        .string()
        .min(1)
        .max(2000)
        .optional()
        .describe('Store a one-line note for the next session (capped at 500 characters, redacted)'),
    auth_token: z.string().min(1).optional().describe('Required when EPISODIC_MEMORY_MCP_TOKEN is set'),
})
    .strict();
export function handleMcpError(error) {
    if (error instanceof Error) {
        return `Error: ${error.message}`;
    }
    return `Error: ${String(error)}`;
}
