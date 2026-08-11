/**
 * Validate custom summarizer API base URLs so a compromised / mis-set env
 * cannot silently ship transcripts to an attacker-controlled HTTP proxy.
 */
/**
 * Accept https:// anywhere, and http:// only for loopback hosts.
 * Rejects credentials embedded in the URL and non-http(s) schemes.
 */
export function validateApiBaseUrl(raw) {
    const trimmed = raw.trim();
    if (!trimmed) {
        return { ok: false, reason: 'API base URL is empty' };
    }
    let parsed;
    try {
        parsed = new URL(trimmed);
    }
    catch {
        return { ok: false, reason: `API base URL is not a valid URL: ${raw}` };
    }
    if (parsed.username || parsed.password) {
        return {
            ok: false,
            reason: 'API base URL must not embed credentials; use EPISODIC_MEMORY_API_TOKEN',
        };
    }
    const protocol = parsed.protocol.toLowerCase();
    if (protocol === 'https:') {
        return { ok: true, url: trimmed };
    }
    if (protocol === 'http:') {
        const host = parsed.hostname.toLowerCase();
        const loopback = host === 'localhost' ||
            host === '127.0.0.1' ||
            host === '[::1]' ||
            host === '::1';
        if (!loopback) {
            return {
                ok: false,
                reason: `HTTP API base URL is only allowed for localhost (got ${parsed.hostname}); use HTTPS`,
            };
        }
        return { ok: true, url: trimmed };
    }
    return {
        ok: false,
        reason: `API base URL must use https: (or http: on localhost); got ${parsed.protocol}`,
    };
}
