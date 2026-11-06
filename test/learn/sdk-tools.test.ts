import { describe, it, expect } from 'vitest';
import {
  buildLearnToolServer,
  SERVED_TOOL_NAMES,
  PROPOSE_TOOL_NAME,
  servedToolNames,
} from '../../src/learn/sdk-tools.js';
import type { ProposedEntry } from '../../src/learn/types.js';

const HEX = 'a'.repeat(32);

function registeredToolNames(server: ReturnType<typeof buildLearnToolServer>): string[] {
  // The SDK keeps its registry on the McpServer instance it hands back.
  const instance = server.instance as unknown as {
    _registeredTools: Record<string, unknown>;
  };
  return Object.keys(instance._registeredTools).sort();
}

function handlerFor(
  server: ReturnType<typeof buildLearnToolServer>,
  name: string
): (args: Record<string, unknown>, extra?: unknown) => Promise<any> {
  const instance = server.instance as unknown as {
    _registeredTools: Record<string, { handler: (a: any, extra: any) => Promise<any> }>;
  };
  return instance._registeredTools[name].handler;
}

function textOf(result: any): string {
  const content = result?.content ?? [];
  return content.map((part: any) => part?.text ?? '').join('\n');
}

describe('SERVED_TOOL_NAMES', () => {
  it('names the four read-only tools, fully qualified', () => {
    expect(SERVED_TOOL_NAMES).toEqual([
      'mcp__episodic-learn__search',
      'mcp__episodic-learn__read',
      'mcp__episodic-learn__digest',
      'mcp__episodic-learn__skills',
    ]);
  });

  it('names propose_entry separately', () => {
    expect(PROPOSE_TOOL_NAME).toBe('mcp__episodic-learn__propose_entry');
  });

  it('servedToolNames adds propose_entry only for a learner', () => {
    expect(servedToolNames(false)).toEqual(SERVED_TOOL_NAMES);
    expect(servedToolNames(true)).toEqual([...SERVED_TOOL_NAMES, PROPOSE_TOOL_NAME]);
  });
});

describe('buildLearnToolServer', () => {
  const ctx = { project: 'proj-a', hideExchangeIds: [] as string[] };

  it('is named episodic-learn', () => {
    const server = buildLearnToolServer({ ...ctx, allowPropose: false });
    expect(server.type).toBe('sdk');
    expect(server.name).toBe('episodic-learn');
  });

  it('serves exactly the four read-only tools when allowPropose is false', () => {
    const server = buildLearnToolServer({ ...ctx, allowPropose: false });
    expect(registeredToolNames(server)).toEqual(['digest', 'read', 'search', 'skills']);
    expect(registeredToolNames(server)).not.toContain('propose_entry');
  });

  it('adds propose_entry only when allowPropose is true', () => {
    const server = buildLearnToolServer({ ...ctx, allowPropose: true, onPropose: () => {} });
    expect(registeredToolNames(server)).toEqual([
      'digest',
      'propose_entry',
      'read',
      'search',
      'skills',
    ]);
  });

  it('serves a digest with no handoff parameter and no write-shaped tool', () => {
    const server = buildLearnToolServer({ ...ctx, allowPropose: false });
    const instance = server.instance as unknown as {
      _registeredTools: Record<string, { inputSchema: { shape: Record<string, unknown> } }>;
    };
    const shape = instance._registeredTools.digest.inputSchema.shape;
    expect(Object.keys(shape)).not.toContain('handoff');
    expect(Object.keys(shape).sort()).toEqual(['expand', 'limit', 'query']);
    // Nothing else write-shaped either.
    for (const name of Object.keys(instance._registeredTools)) {
      expect(name).not.toMatch(/write|delete|handoff|update/i);
    }
  });

  it('calls onPropose with a valid proposal and never writes anything', async () => {
    const seen: ProposedEntry[] = [];
    const server = buildLearnToolServer({
      ...ctx,
      allowPropose: true,
      onPropose: proposal => seen.push(proposal),
    });
    const propose = handlerFor(server, 'propose_entry');

    const result = await propose({
      kind: 'skill',
      project: 'proj-a',
      slug: 'cache-work',
      title: 'Cache work',
      description: 'Use when the cache is being changed',
      body: `cache notes [#${HEX}]`,
      scope: 'proj-a cache work',
      confidence: 'medium',
    });

    expect(seen).toHaveLength(1);
    expect(seen[0].slug).toBe('cache-work');
    expect(seen[0].body).toContain(`[#${HEX}]`);
    expect(textOf(result)).toMatch(/received|proposed|recorded|not stored/i);
  });

  it('rejects a malformed proposal without calling onPropose', async () => {
    const seen: ProposedEntry[] = [];
    const server = buildLearnToolServer({
      ...ctx,
      allowPropose: true,
      onPropose: proposal => seen.push(proposal),
    });
    const propose = handlerFor(server, 'propose_entry');

    const result = await propose({
      kind: 'not-a-kind',
      project: 'proj-a',
      slug: 'x',
      title: 't',
      description: 'd',
      body: 'b',
      scope: 's',
      confidence: 'medium',
    });

    expect(seen).toHaveLength(0);
    expect(textOf(result)).toMatch(/invalid|reject|error/i);
  });

  it('carries a proposal through when onPropose is absent', async () => {
    const server = buildLearnToolServer({ ...ctx, allowPropose: true });
    const propose = handlerFor(server, 'propose_entry');
    const result = await propose({
      kind: 'reflection',
      project: 'proj-a',
      slug: 'what-worked',
      title: 'What worked',
      description: 'A note from a past run',
      body: `the search-first path worked [#${HEX}]`,
      scope: 'proj-a runs',
      confidence: 'low',
    });
    expect(textOf(result)).toMatch(/received|proposed|recorded|not stored/i);
  });

  it('denies a tool the server does not serve, through the digest handler', async () => {
    const server = buildLearnToolServer({
      ...ctx,
      hideExchangeIds: ['hidden-exchange-id'],
      allowPropose: false,
    });
    const digest = handlerFor(server, 'digest');
    const result = await digest({ expand: 'hidden-exchange-id' });
    expect(textOf(result)).not.toContain('hidden-exchange-id\npath:');
  });

  it('passes the hidden ids through to search', async () => {
    const server = buildLearnToolServer({
      ...ctx,
      hideExchangeIds: ['hidden-exchange-id'],
      allowPropose: false,
    });
    const search = handlerFor(server, 'search');
    const result = await search({ query: 'nothing-matches-this-at-all', mode: 'text', limit: 5 });
    expect(textOf(result)).toMatch(/No results found|Error/);
  });
});
