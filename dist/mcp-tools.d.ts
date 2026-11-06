/**
 * MCP tool dispatch. Extracted from mcp-server.ts so tests can exercise
 * search/read without starting a stdio transport.
 */
/**
 * The result of one MCP tool call, in the MCP content form.
 *
 * `isError` is true when the call failed. The text then holds the error message.
 */
export interface McpToolResult {
    content: Array<{
        type: 'text';
        text: string;
    }>;
    isError?: boolean;
}
/**
 * Run one MCP tool call and return its result.
 *
 * The tools are `search`, `read`, `digest` and `skills`. When `EPISODIC_MEMORY_MCP_TOKEN` is set, the function first requires a matching `auth_token` argument. The function then parses the arguments with the schema of the tool.
 *
 * The function does not throw. A failed check, an invalid argument or an unknown tool name gives a result with `isError` set.
 */
export declare function handleToolCall(name: string, args: unknown): Promise<McpToolResult>;
