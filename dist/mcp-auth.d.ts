/**
 * Optional MCP tool authorization.
 *
 * The MCP protocol has no per-tool scopes. When EPISODIC_MEMORY_MCP_TOKEN is
 * set, every search/read call must include a matching `auth_token` argument.
 * Unset (the default) keeps the existing single-user stdio behavior.
 */
export declare function getRequiredMcpToken(): string | undefined;
export declare function tokensEqual(provided: string, expected: string): boolean;
/**
 * Throw if a required MCP token is configured and the call does not present it.
 */
export declare function assertMcpAuthorized(args: unknown): void;
