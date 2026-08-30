/**
 * MCP tool dispatch. Extracted from mcp-server.ts so tests can exercise
 * search/read without starting a stdio transport.
 */
import { resolveArchiveJsonlPath, readJsonlLines, } from './archive-path.js';
import { maybeRedactSecrets } from './redact.js';
import { assertMcpAuthorized } from './mcp-auth.js';
import { SearchInputSchema, ShowConversationInputSchema, handleMcpError, } from './mcp-schemas.js';
export async function handleToolCall(name, args) {
    try {
        assertMcpAuthorized(args);
        if (name === 'search') {
            const params = SearchInputSchema.parse(args);
            const { searchConversations, searchMultipleConcepts, formatResults, formatMultiConceptResults, includeSearchSummaries, } = await import('./search.js');
            let resultText;
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
                    resultText = JSON.stringify({
                        results,
                        count: results.length,
                        concepts: params.query,
                    }, null, 2);
                }
                else {
                    resultText = await formatMultiConceptResults(results, params.query);
                }
            }
            else {
                const options = {
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
                    resultText = JSON.stringify({
                        results: results.map((r) => ({
                            exchange: r.exchange,
                            similarity: r.similarity,
                            snippet: r.snippet,
                            ...(showSummary && r.summary ? { summary: r.summary } : {}),
                        })),
                        count: results.length,
                        mode: params.mode,
                    }, null, 2);
                }
                else {
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
            const jsonlContent = await readJsonlLines(safePath, params.startLine, params.endLine);
            const { formatConversationAsMarkdown } = await import('./show.js');
            const markdownContent = maybeRedactSecrets(formatConversationAsMarkdown(jsonlContent));
            return {
                content: [{ type: 'text', text: markdownContent }],
            };
        }
        throw new Error(`Unknown tool: ${name}`);
    }
    catch (error) {
        return {
            content: [{ type: 'text', text: handleMcpError(error) }],
            isError: true,
        };
    }
}
