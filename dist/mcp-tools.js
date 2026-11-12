/**
 * MCP tool dispatch. Extracted from mcp-server.ts so tests can exercise
 * search/read without starting a stdio transport.
 */
import { resolveArchiveJsonlPath, readJsonlLines, } from './archive-path.js';
import { maybeRedactSecrets } from './redact.js';
import { LEARN_OFF_MESSAGE, learnEnabled } from './learn/learn-config.js';
import { assertMcpAuthorized } from './mcp-auth.js';
import { DigestInputSchema, SearchInputSchema, ShowConversationInputSchema, SkillsInputSchema, TopicsInputSchema, handleMcpError, } from './mcp-schemas.js';
/**
 * Run one MCP tool call and return its result.
 *
 * The tools are `search`, `read`, `digest`, `skills` and `topics`. When `EPISODIC_MEMORY_MCP_TOKEN` is set, the function first requires a matching `auth_token` argument. The function then parses the arguments with the schema of the tool.
 *
 * The function does not throw. A failed check, an invalid argument or an unknown tool name gives a result with `isError` set.
 */
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
        if (name === 'topics') {
            const params = TopicsInputSchema.parse(args);
            // Lazy on purpose: a session that never calls `topics` loads nothing of the topic feature.
            const { topicsToolText } = await import('./topic-tool.js');
            return { content: [{ type: 'text', text: topicsToolText(params) }] };
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
