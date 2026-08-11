import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  redactSecrets,
  maybeRedactSecrets,
  isSecretRedactionEnabled,
} from '../src/redact.js';
import { validateApiBaseUrl } from '../src/api-endpoint.js';
import { buildFtsMatchQuery } from '../src/search.js';

describe('secret redaction', () => {
  const prev = process.env.EPISODIC_MEMORY_REDACT_SECRETS;

  afterEach(() => {
    if (prev === undefined) delete process.env.EPISODIC_MEMORY_REDACT_SECRETS;
    else process.env.EPISODIC_MEMORY_REDACT_SECRETS = prev;
  });

  it('redacts common token shapes', () => {
    const input =
      'key=sk-abcdefghijklmnopqrstuvwxyz012345 github=ghp_abcdefghijklmnopqrstuv npm=npm_abcdefghijklmnopqrst';
    const out = redactSecrets(input);
    expect(out).not.toMatch(/sk-abc/);
    expect(out).not.toMatch(/ghp_/);
    expect(out).not.toMatch(/npm_/);
    expect(out).toContain('[redacted]');
  });

  it('is opt-in via env', () => {
    delete process.env.EPISODIC_MEMORY_REDACT_SECRETS;
    expect(isSecretRedactionEnabled()).toBe(false);
    expect(maybeRedactSecrets('sk-abcdefghijklmnopqrstuvwxyz012345')).toContain('sk-');

    process.env.EPISODIC_MEMORY_REDACT_SECRETS = '1';
    expect(isSecretRedactionEnabled()).toBe(true);
    expect(maybeRedactSecrets('sk-abcdefghijklmnopqrstuvwxyz012345')).toBe('[redacted]');
  });
});

describe('API base URL validation', () => {
  it('accepts https URLs', () => {
    expect(validateApiBaseUrl('https://api.example.com/v1')).toEqual({
      ok: true,
      url: 'https://api.example.com/v1',
    });
  });

  it('accepts http only on localhost', () => {
    expect(validateApiBaseUrl('http://127.0.0.1:8080').ok).toBe(true);
    expect(validateApiBaseUrl('http://evil.example.com').ok).toBe(false);
  });

  it('rejects embedded credentials and non-http schemes', () => {
    expect(validateApiBaseUrl('https://user:pass@api.example.com').ok).toBe(false);
    expect(validateApiBaseUrl('ftp://api.example.com').ok).toBe(false);
  });
});

describe('FTS query builder', () => {
  it('phrase-quotes and escapes embedded quotes', () => {
    expect(buildFtsMatchQuery('hello world')).toBe('"hello world"');
    expect(buildFtsMatchQuery('say "hi"')).toBe('"say ""hi"""');
  });
});
