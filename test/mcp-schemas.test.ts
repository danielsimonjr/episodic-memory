import { describe, it, expect } from 'vitest';
import {
  SearchInputSchema,
  ShowConversationInputSchema,
  SkillsInputSchema,
  handleMcpError,
} from '../src/mcp-schemas.js';

describe('MCP Zod schemas', () => {
  it('accepts a single-concept search with defaults', () => {
    const parsed = SearchInputSchema.parse({ query: 'auth flow' });
    expect(parsed.mode).toBe('both');
    expect(parsed.limit).toBe(10);
    expect(parsed.response_format).toBe('markdown');
  });

  it('accepts multi-concept queries and rejects too few or too many', () => {
    expect(SearchInputSchema.parse({ query: ['alpha', 'beta'] }).query).toEqual(['alpha', 'beta']);
    expect(() => SearchInputSchema.parse({ query: ['only'] })).toThrow();
    expect(() => SearchInputSchema.parse({ query: ['a', 'b', 'c', 'd', 'e', 'f'] })).toThrow();
  });

  it('rejects invalid dates, extra fields, and short queries', () => {
    expect(() => SearchInputSchema.parse({ query: 'x' })).toThrow();
    expect(() => SearchInputSchema.parse({ query: 'ok', after: '2026/01/01' })).toThrow();
    expect(() => SearchInputSchema.parse({ query: 'ok', extra: true })).toThrow();
  });

  it('validates read path and optional line range', () => {
    const parsed = ShowConversationInputSchema.parse({ path: '/tmp/a.jsonl', startLine: 1, endLine: 10 });
    expect(parsed.path).toContain('.jsonl');
    expect(() => ShowConversationInputSchema.parse({})).toThrow();
    expect(() => ShowConversationInputSchema.parse({ path: '/tmp/a.jsonl', startLine: 0 })).toThrow();
  });

  it('formats unknown errors for MCP results', () => {
    expect(handleMcpError(new Error('boom'))).toBe('Error: boom');
    expect(handleMcpError('plain')).toBe('Error: plain');
  });
});

describe('SkillsInputSchema', () => {
  it('accepts an empty object (list with defaults)', () => {
    expect(SkillsInputSchema.parse({})).toEqual({});
  });

  it('accepts get, query, project, limit and auth_token', () => {
    const parsed = SkillsInputSchema.parse({
      get: 'alpha',
      query: 'ledger',
      project: 'p',
      limit: 5,
      auth_token: 't',
    });
    expect(parsed).toEqual({ get: 'alpha', query: 'ledger', project: 'p', limit: 5, auth_token: 't' });
  });

  it('rejects unknown keys and out-of-range values', () => {
    expect(() => SkillsInputSchema.parse({ extra: true })).toThrow();
    expect(() => SkillsInputSchema.parse({ limit: 0 })).toThrow();
    expect(() => SkillsInputSchema.parse({ limit: 51 })).toThrow();
    expect(() => SkillsInputSchema.parse({ limit: 1.5 })).toThrow();
    expect(() => SkillsInputSchema.parse({ get: '' })).toThrow();
    expect(() => SkillsInputSchema.parse({ project: '' })).toThrow();
  });
});
