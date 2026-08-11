/**
 * Validate custom summarizer API base URLs so a compromised / mis-set env
 * cannot silently ship transcripts to an attacker-controlled HTTP proxy.
 */
export type ApiBaseUrlValidation = {
    ok: true;
    url: string;
} | {
    ok: false;
    reason: string;
};
/**
 * Accept https:// anywhere, and http:// only for loopback hosts.
 * Rejects credentials embedded in the URL and non-http(s) schemes.
 */
export declare function validateApiBaseUrl(raw: string): ApiBaseUrlValidation;
