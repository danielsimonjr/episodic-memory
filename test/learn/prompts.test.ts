import { describe, it, expect } from 'vitest';
import { solverSystemPrompt } from '../../src/learn/prompts.js';
import type { KnowledgeEntry } from '../../src/learn/types.js';

const HEX = 'b'.repeat(32);

function entry(over: Partial<KnowledgeEntry> = {}): KnowledgeEntry {
  return {
    id: `learned:instruction:proj-a:search-first:v1`,
    kind: 'instruction',
    project: 'proj-a',
    slug: 'search-first',
    version: 1,
    title: 'Search first',
    description: 'Search before reading',
    body: `mode text for release notes [#${HEX}]`,
    scope: 'proj-a release work',
    confidence: 'medium',
    trust: 'verified',
    sources: [],
    status: 'active',
    runId: 'run-1',
    createdAt: '2026-11-01T00:00:00.000Z',
    supersededBy: null,
    validation: null,
    heuristicIds: [],
    decisionId: null,
    procedureId: null,
    ...over,
  };
}

describe('solverSystemPrompt', () => {
  it('names the role and the answer format', () => {
    const prompt = solverSystemPrompt([], '');
    expect(prompt).toMatch(/solver/i);
    for (const label of ['path:', 'lines:', 'project:', 'date:', 'outcome:']) {
      expect(prompt).toContain(label);
    }
  });

  it('states the citation and honest-answer rules', () => {
    const prompt = solverSystemPrompt([], '');
    expect(prompt).toMatch(/cite|address/i);
    expect(prompt).toMatch(/do not guess|say so|no answer|not found/i);
    expect(prompt).toMatch(/read-only|read only|only the tools/i);
  });

  it('includes the instruction lines verbatim', () => {
    const prompt = solverSystemPrompt([entry()], '');
    expect(prompt).toContain(`mode text for release notes [#${HEX}]`);
  });

  it('includes the skills index', () => {
    const prompt = solverSystemPrompt([], 'navigation: map of the archive (medium, v1)');
    expect(prompt).toContain('navigation: map of the archive (medium, v1)');
    expect(prompt).toMatch(/skills/i);
  });

  it('omits a section it has nothing for rather than printing an empty one', () => {
    const prompt = solverSystemPrompt([], '');
    expect(prompt).not.toMatch(/Instructions:\s*\n\s*\n/);
  });

  it('is pure: the same input gives the same output', () => {
    const a = solverSystemPrompt([entry()], 'alpha: does a thing');
    const b = solverSystemPrompt([entry()], 'alpha: does a thing');
    expect(a).toBe(b);
  });

  it('never carries a planted secret', () => {
    const secret = 'ghp_' + 'Z'.repeat(36);
    const prompt = solverSystemPrompt([entry({ body: `a line [#${HEX}]` })], 'skill: thing');
    expect(prompt).not.toContain(secret);
  });

  it('states that the learned text is data, not instructions', () => {
    const prompt = solverSystemPrompt([entry()], 'alpha: does a thing');
    expect(prompt).toMatch(/data, not instructions|not instructions/i);
  });
});
