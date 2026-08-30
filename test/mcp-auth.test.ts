import { describe, it, expect, afterEach } from 'vitest';
import { assertMcpAuthorized, getRequiredMcpToken, tokensEqual } from '../src/mcp-auth.js';

describe('mcp-auth', () => {
  const prev = process.env.EPISODIC_MEMORY_MCP_TOKEN;

  afterEach(() => {
    if (prev === undefined) delete process.env.EPISODIC_MEMORY_MCP_TOKEN;
    else process.env.EPISODIC_MEMORY_MCP_TOKEN = prev;
  });

  it('is disabled when the env is unset or blank', () => {
    delete process.env.EPISODIC_MEMORY_MCP_TOKEN;
    expect(getRequiredMcpToken()).toBeUndefined();
    expect(() => assertMcpAuthorized({})).not.toThrow();

    process.env.EPISODIC_MEMORY_MCP_TOKEN = '   ';
    expect(getRequiredMcpToken()).toBeUndefined();
  });

  it('rejects missing or wrong tokens when configured', () => {
    process.env.EPISODIC_MEMORY_MCP_TOKEN = 'secret-token';
    expect(getRequiredMcpToken()).toBe('secret-token');
    expect(() => assertMcpAuthorized({})).toThrow(/Unauthorized/);
    expect(() => assertMcpAuthorized({ auth_token: 'nope' })).toThrow(/Unauthorized/);
    expect(() => assertMcpAuthorized({ auth_token: 'secret-token' })).not.toThrow();
  });

  it('compares tokens in constant time and rejects length mismatch', () => {
    expect(tokensEqual('abc', 'abc')).toBe(true);
    expect(tokensEqual('abc', 'abd')).toBe(false);
    expect(tokensEqual('ab', 'abc')).toBe(false);
  });
});
