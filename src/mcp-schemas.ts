/**
 * Zod schemas for the MCP tool inputs.
 *
 * The schemas live in this module, not in mcp-server.ts. Tests validate the
 * schemas without starting a stdio transport.
 */

import { z } from 'zod';
import { UNIT_ID_PATTERN, isValidTime } from './topic-format.js';

/**
 * The search methods that the `mode` input of the `search` tool accepts.
 *
 * `vector` ranks exchanges by semantic similarity. `text` finds exchanges that
 * contain the query text. `both` runs the two methods and combines the results.
 */
export const SearchModeEnum = z.enum(['vector', 'text', 'both']);
/** The output formats of the `search` tool: `markdown` for people, `json` for programs. */
export const ResponseFormatEnum = z.enum(['markdown', 'json']);

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
      .describe(
        'Search query - string for single concept, array of strings for multi-concept AND search'
      ),
    mode: SearchModeEnum.default('both').describe(
      'Search mode: "vector" for semantic similarity, "text" for exact matching, "both" for combined (default: "both"). Only used for single-concept searches.'
    ),
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
    response_format: ResponseFormatEnum.default('markdown').describe(
      'Output format: "markdown" for human-readable or "json" for machine-readable (default: "markdown")'
    ),
    auth_token: z
      .string()
      .min(1)
      .optional()
      .describe('Required when EPISODIC_MEMORY_MCP_TOKEN is set'),
  })
  .strict();

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
export const ShowConversationInputSchema = z
  .object({
    path: z
      .string()
      .min(1, 'Path is required')
      .describe(
        'The archive_path of a search result: a .jsonl file inside the conversation archive. Paths outside the archive are refused.'
      ),
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
export const SkillsInputSchema = z
  .object({
    get: z
      .string()
      .min(1)
      .optional()
      .describe('Slug of one learned skill, as listed. Returns its frontmatter and body.'),
    query: z
      .string()
      .min(1)
      .optional()
      .describe('Search the learned skills instead of listing them'),
    project: z
      .string()
      .min(1)
      .optional()
      .describe('Project key. Defaults to the key for the current working directory.'),
    limit: z.number().int().min(1).max(50).optional().describe('Max skills listed (default 10)'),
    auth_token: z.string().min(1).optional().describe('Required when EPISODIC_MEMORY_MCP_TOKEN is set'),
  })
  .strict();

/** The parsed input of the `skills` tool. */
export type SkillsInput = z.infer<typeof SkillsInputSchema>;

/** The actions of the `topics` tool. */
export const TopicsActionEnum = z.enum(['list', 'read', 'search', 'links', 'timeline']);

/** The argument that each action requires. The `list` and `timeline` actions require none. */
const TOPICS_REQUIRED_ARG: Partial<Record<z.infer<typeof TopicsActionEnum>, 'slug' | 'query' | 'unit'>> = {
  read: 'slug',
  search: 'query',
  links: 'unit',
};

/**
 * The input schema of the `topics` tool, which reads the topic memory documents.
 *
 * The schema rejects unknown fields. `action` selects one of list, read, search, links and timeline.
 * `read` requires `slug`, `search` requires `query` and `links` requires `unit`. A missing required
 * argument is a schema error. `unit` is 8 lowercase hex characters. `from` and `to` are YYYY, YYYY-MM or
 * YYYY-MM-DD, and each check uses `isValidTime`. `limit` caps the hits of `search` (default 10).
 * `project` defaults to the key for the working directory, in the handler.
 * `assertMcpAuthorized` checks the `auth_token` input, and this schema does not.
 */
export const TopicsInputSchema = z
  .object({
    action: TopicsActionEnum.describe('What to read: list, read, search, links or timeline'),
    project: z
      .string()
      .min(1)
      .optional()
      .describe('Project key. Defaults to the key for the current working directory.'),
    slug: z.string().min(1).optional().describe('Slug of one document (action read)'),
    query: z.string().min(1).optional().describe('Words to search the topic units for (action search)'),
    unit: z
      .string()
      .regex(UNIT_ID_PATTERN, 'unit must be 8 lowercase hex characters')
      .optional()
      .describe('Unit id of one paragraph, 8 lowercase hex characters (action links)'),
    from: z
      .string()
      .refine(isValidTime, 'from must be YYYY, YYYY-MM or YYYY-MM-DD')
      .optional()
      .describe('Earliest time, YYYY, YYYY-MM or YYYY-MM-DD (inclusive)'),
    to: z
      .string()
      .refine(isValidTime, 'to must be YYYY, YYYY-MM or YYYY-MM-DD')
      .optional()
      .describe('Latest time, YYYY, YYYY-MM or YYYY-MM-DD (inclusive)'),
    limit: z.number().int().min(1).max(50).optional().describe('Max search hits (default 10)'),
    auth_token: z.string().min(1).optional().describe('Required when EPISODIC_MEMORY_MCP_TOKEN is set'),
  })
  .strict()
  .superRefine((args, ctx) => {
    const field = TOPICS_REQUIRED_ARG[args.action];
    if (field !== undefined && args[field] === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: [field],
        message: `${field} is required for action ${args.action}`,
      });
    }
  });

/** The parsed input of the `topics` tool. */
export type TopicsInput = z.infer<typeof TopicsInputSchema>;

/**
 * Format a caught value as the text of an MCP error result.
 *
 * An Error gives its message. Any other value gives its String form. The text always starts with "Error: ".
 *
 * @param error the value that the tool handler caught
 */
export function handleMcpError(error: unknown): string {
  if (error instanceof Error) {
    return `Error: ${error.message}`;
  }
  return `Error: ${String(error)}`;
}
