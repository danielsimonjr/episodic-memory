/**
 * Zod schemas for MCP tool inputs. Kept out of mcp-server.ts so tests can
 * validate them without starting a stdio transport.
 */
import { z } from 'zod';
export declare const SearchModeEnum: z.ZodEnum<{
    text: "text";
    vector: "vector";
    both: "both";
}>;
export declare const ResponseFormatEnum: z.ZodEnum<{
    markdown: "markdown";
    json: "json";
}>;
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
export type SearchInput = z.infer<typeof SearchInputSchema>;
export declare const ShowConversationInputSchema: z.ZodObject<{
    path: z.ZodString;
    startLine: z.ZodOptional<z.ZodNumber>;
    endLine: z.ZodOptional<z.ZodNumber>;
    auth_token: z.ZodOptional<z.ZodString>;
}, z.core.$strict>;
export type ShowConversationInput = z.infer<typeof ShowConversationInputSchema>;
export declare function handleMcpError(error: unknown): string;
