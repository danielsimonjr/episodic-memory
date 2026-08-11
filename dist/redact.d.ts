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
export declare function isSecretRedactionEnabled(): boolean;
/**
 * Replace known secret-shaped substrings with `[redacted]`.
 * Idempotent for already-redacted text.
 */
export declare function redactSecrets(text: string): string;
/** Redact only when the env opt-in is set; otherwise return text unchanged. */
export declare function maybeRedactSecrets(text: string): string;
