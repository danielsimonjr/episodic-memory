/**
 * Opt-in secret redaction for indexed / returned conversation text.
 *
 * Enable with EPISODIC_MEMORY_REDACT_SECRETS=1 (or "true" / "yes").
 * Default off — most single-user installs don't need it, and redaction is
 * lossy for search recall on the redacted tokens themselves.
 *
 * Applied:
 * - at insert time (before embedding + DB write) when enabled
 * - at search-return time when enabled (covers rows indexed before opt-in)
 */

const TRUTHY = new Set(['1', 'true', 'yes', 'on']);

export function isSecretRedactionEnabled(): boolean {
  const raw = process.env.EPISODIC_MEMORY_REDACT_SECRETS;
  if (!raw) return false;
  return TRUTHY.has(raw.trim().toLowerCase());
}

/**
 * Token-shaped patterns commonly pasted into coding-agent chats.
 * Order matters for overlapping shapes; more specific patterns first.
 */
const SECRET_PATTERNS: Array<{ name: string; re: RegExp }> = [
  // GitHub tokens (classic + fine-grained + OAuth/user/server-to-server)
  { name: 'github', re: /\bgh[pousr]_[A-Za-z0-9_]{20,}\b/g },
  // GitHub fine-grained PATs
  { name: 'github_pat', re: /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g },
  // OpenAI / Anthropic-style secret keys
  { name: 'sk', re: /\bsk-[A-Za-z0-9_-]{20,}\b/g },
  { name: 'sk_ant', re: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g },
  // npm tokens
  { name: 'npm', re: /\bnpm_[A-Za-z0-9]{20,}\b/g },
  // AWS access key ids
  { name: 'aws_key', re: /\b(AKIA|ASIA)[A-Z0-9]{16}\b/g },
  // Slack tokens
  { name: 'slack', re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g },
  // Google API keys
  { name: 'google', re: /\bAIza[0-9A-Za-z_-]{20,}\b/g },
  // Stripe
  { name: 'stripe', re: /\b(sk|rk|pk)_(live|test)_[A-Za-z0-9]{16,}\b/g },
  // JWT (three base64url segments)
  {
    name: 'jwt',
    re: /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g,
  },
  // Generic bearer / authorization header values on a line
  {
    name: 'bearer',
    re: /\bBearer\s+[A-Za-z0-9\-._~+/]+=*/gi,
  },
];

const REDACTED = '[redacted]';

/**
 * Replace known secret-shaped substrings with `[redacted]`.
 * Idempotent for already-redacted text.
 */
export function redactSecrets(text: string): string {
  if (!text) return text;
  let out = text;
  for (const { re } of SECRET_PATTERNS) {
    // Reset lastIndex for global regexes reused across calls
    re.lastIndex = 0;
    out = out.replace(re, REDACTED);
  }
  return out;
}

/** Redact only when the env opt-in is set; otherwise return text unchanged. */
export function maybeRedactSecrets(text: string): string {
  if (!isSecretRedactionEnabled()) return text;
  return redactSecrets(text);
}
