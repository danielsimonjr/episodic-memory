/**
 * Optional MCP tool authorization.
 *
 * The MCP protocol has no per-tool scopes. When EPISODIC_MEMORY_MCP_TOKEN is
 * set, every tool call must include a matching `auth_token` argument. The check
 * runs in handleToolCall before the tool runs. When the variable is unset, the
 * server keeps the single-user stdio behavior.
 */
/**
 * Return the MCP access token, or undefined when no token is required.
 *
 * The function reads the EPISODIC_MEMORY_MCP_TOKEN environment variable at each run.
 * The function removes leading and trailing whitespace from the value.
 * The function returns undefined when the variable is unset, empty or only whitespace.
 * The function does not throw.
 */
export declare function getRequiredMcpToken(): string | undefined;
/**
 * Compare the token that a caller presented with the expected token.
 *
 * The function compares the UTF-8 bytes of both strings.
 * When the lengths match, the function calls crypto.timingSafeEqual.
 * The timingSafeEqual comparison does not stop at the first byte that differs.
 * A length mismatch returns false before the comparison.
 * The timing of a length mismatch can reveal the length of the expected token.
 *
 * @param provided the token that the caller presented
 * @param expected the token that the server requires
 */
export declare function tokensEqual(provided: string, expected: string): boolean;
/**
 * Throw when the server requires a token and the caller does not present it.
 *
 * The function does nothing when getRequiredMcpToken returns undefined.
 * Otherwise the function reads the auth_token property of args.
 * The check fails when auth_token is missing, is not a string or does not equal the required token.
 * When the check fails, the function throws an Error with the message "Unauthorized: valid auth_token required".
 *
 * @param args the tool arguments. The function accepts any value and reads only an object's auth_token property.
 */
export declare function assertMcpAuthorized(args: unknown): void;
