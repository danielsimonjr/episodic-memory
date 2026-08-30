/**
 * Optional MCP tool authorization.
 *
 * The MCP protocol has no per-tool scopes. When EPISODIC_MEMORY_MCP_TOKEN is
 * set, every search/read call must include a matching `auth_token` argument.
 * Unset (the default) keeps the existing single-user stdio behavior.
 */
import { timingSafeEqual } from 'crypto';
export function getRequiredMcpToken() {
    const raw = process.env.EPISODIC_MEMORY_MCP_TOKEN;
    if (!raw)
        return undefined;
    const trimmed = raw.trim();
    return trimmed.length > 0 ? trimmed : undefined;
}
export function tokensEqual(provided, expected) {
    const a = Buffer.from(provided);
    const b = Buffer.from(expected);
    if (a.length !== b.length)
        return false;
    return timingSafeEqual(a, b);
}
/**
 * Throw if a required MCP token is configured and the call does not present it.
 */
export function assertMcpAuthorized(args) {
    const required = getRequiredMcpToken();
    if (!required)
        return;
    const token = args && typeof args === 'object' && args !== null && 'auth_token' in args
        ? args.auth_token
        : undefined;
    if (typeof token !== 'string' || !tokensEqual(token, required)) {
        throw new Error('Unauthorized: valid auth_token required');
    }
}
