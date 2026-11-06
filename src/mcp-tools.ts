/**
 * MCP tool dispatch. Extracted from mcp-server.ts so tests can exercise
 * search/read without starting a stdio transport.
 */

import {
  resolveArchiveJsonlPath,
  readJsonlLines,
} from './archive-path.js';
import { maybeRedactSecrets } from './redact.js';
import { LEARN_OFF_MESSAGE, learnEnabled } from './learn/learn-config.js';
import { assertMcpAuthorized } from './mcp-auth.js';
import {
  DigestInputSchema,
  SearchInputSchema,
  ShowConversationInputSchema,
  SkillsInputSchema,
  handleMcpError,
} from './mcp-schemas.js';

/**
 * The result of one MCP tool call, in the MCP content form.
 *
 * `isError` is true when the call failed. The text then holds the error message.
 */
export interface McpToolResult {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
}

/**
 * Run one MCP tool call and return its result.
 *
 * The tools are `search`, `read`, `digest` and `skills`. When `EPISODIC_MEMORY_MCP_TOKEN` is set, the function first requires a matching `auth_token` argument. The function then parses the arguments with the schema of the tool.
 *
 * The function does not throw. A failed check, an invalid argument or an unknown tool name gives a result with `isError` set.
 */
export async function handleToolCall(name: string, args: unknown): Promise<McpToolResult> {
  try {
    assertMcpAuthorized(args);

    if (name === 'search') {
      const params = SearchInputSchema.parse(args);
      const {
        searchConversations,
        searchMultipleConcepts,
        formatResults,
        formatMultiConceptResults,
        includeSearchSummaries,
      } = await import('./search.js');
      type SearchOptions = import('./search.js').SearchOptions;

      let resultText: string;

      if (Array.isArray(params.query)) {
        const options = {
          limit: params.limit,
          after: params.after,
          before: params.before,
          project: params.project,
          session_id: params.session_id,
          git_branch: params.git_branch,
          useSharedReader: true,
        };

        const results = await searchMultipleConcepts(params.query, options);

        if (params.response_format === 'json') {
          resultText = JSON.stringify(
            {
              results,
              count: results.length,
              concepts: params.query,
            },
            null,
            2
          );
        } else {
          resultText = await formatMultiConceptResults(results, params.query);
        }
      } else {
        const options: SearchOptions = {
          mode: params.mode,
          limit: params.limit,
          after: params.after,
          before: params.before,
          project: params.project,
          session_id: params.session_id,
          git_branch: params.git_branch,
          useSharedReader: true,
        };

        const results = await searchConversations(params.query, options);
        const showSummary = includeSearchSummaries();

        if (params.response_format === 'json') {
          resultText = JSON.stringify(
            {
              results: results.map((r) => ({
                exchange: r.exchange,
                similarity: r.similarity,
                snippet: r.snippet,
                ...(showSummary && r.summary ? { summary: r.summary } : {}),
              })),
              count: results.length,
              mode: params.mode,
            },
            null,
            2
          );
        } else {
          resultText = await formatResults(results);
        }
      }

      return {
        content: [{ type: 'text', text: resultText }],
      };
    }

    if (name === 'read') {
      const params = ShowConversationInputSchema.parse(args);
      const safePath = resolveArchiveJsonlPath(params.path);
      const jsonlContent = await readJsonlLines(
        safePath,
        params.startLine,
        params.endLine
      );

      const { formatConversationAsMarkdown } = await import('./show.js');
      const markdownContent = maybeRedactSecrets(
        formatConversationAsMarkdown(jsonlContent)
      );

      return {
        content: [{ type: 'text', text: markdownContent }],
      };
    }

    if (name === 'digest') {
      const params = DigestInputSchema.parse(args);
      const { digestToolText } = await import('./digest-tool.js');
      return { content: [{ type: 'text', text: digestToolText(params) }] };
    }

    if (name === 'skills') {
      const params = SkillsInputSchema.parse(args);
      // Flag-off must not import `skills-tool.js`: that module opens the knowledge store.
      // The tool stays registered; it answers without opening a store.
      if (!learnEnabled()) {
        return { content: [{ type: 'text', text: LEARN_OFF_MESSAGE }] };
      }
      // Lazy on purpose: a server that never gets a flag-on `skills` call must
      // never pay to open the knowledge store.
      const { skillsToolText } = await import('./learn/skills-tool.js');
      return { content: [{ type: 'text', text: await skillsToolText(params) }] };
    }

    throw new Error(`Unknown tool: ${name}`);
  } catch (error) {
    return {
      content: [{ type: 'text', text: handleMcpError(error) }],
      isError: true,
    };
  }
}
