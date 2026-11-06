import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const REPO_ROOT = join(import.meta.dirname, '..');

function read(relPath: string): string {
  return readFileSync(join(REPO_ROOT, relPath), 'utf-8');
}

describe('Codex-aware skills', () => {
  it('documents both Claude Code and Codex invocation paths in the skill', () => {
    const skill = read('skills/remembering-conversations/SKILL.md');

    expect(skill).toContain('Claude Code');
    expect(skill).toContain('Codex');
    expect(skill).toContain('Task tool');
    expect(skill).toContain('MCP tools directly');
  });

  it('describes episodic memory as cross-harness instead of Claude-only', () => {
    expect(read('skills/remembering-conversations/MCP-TOOLS.md'))
      .toContain('Claude Code and Codex conversations');
    expect(read('agents/search-conversations.md'))
      .toContain('Claude Code and Codex conversations');
    expect(read('prompts/search-agent.md'))
      .toContain('Claude Code and Codex conversations');
    expect(read('src/mcp-server.ts'))
      .toContain('Claude Code and Codex conversations');
    expect(read('README.md'))
      .toContain('Codex plugin');
    expect(read('README.md'))
      .toContain('~/.codex/sessions');
  });

  it('tells the agent and the skill to load a learned skill before searching', () => {
    const learnedStep =
      'If the context holds a learned-hints block, load the matching skill with the `skills` tool, then search as it advises.';

    // The agent and the prompt template that dispatches it.
    expect(read('agents/search-conversations.md')).toContain(learnedStep);
    expect(read('prompts/search-agent.md')).toContain(learnedStep);

    // The skill, in both the agent path and the direct-MCP path.
    const skill = read('skills/remembering-conversations/SKILL.md');
    const occurrences = skill.split(learnedStep).length - 1;
    expect(occurrences).toBe(2);
    expect(skill.indexOf(learnedStep)).toBeLessThan(skill.indexOf('Search with the `search` tool'));
  });
});
