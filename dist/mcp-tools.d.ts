/**
 * MCP tool dispatch. Extracted from mcp-server.ts so tests can exercise
 * search/read without starting a stdio transport.
 */
export interface McpToolResult {
    content: Array<{
        type: 'text';
        text: string;
    }>;
    isError?: boolean;
}
export declare function handleToolCall(name: string, args: unknown): Promise<McpToolResult>;
