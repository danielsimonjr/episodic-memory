import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

describe('search-agent template', () => {
  const templatePath = path.join(__dirname, '..', 'prompts', 'search-agent.md');

  it('exists at expected location', () => {
    expect(fs.existsSync(templatePath)).toBe(true);
  });

  it('contains required placeholders', () => {
    const content = fs.readFileSync(templatePath, 'utf-8');

    // Check for all required placeholders
    expect(content).toContain('{TOPIC}');
    expect(content).toContain('{SEARCH_QUERY}');
    expect(content).toContain('{FOCUS_AREAS}');
  });

  it('contains required output sections', () => {
    const content = fs.readFileSync(templatePath, 'utf-8');

    // Check for required output format sections
    expect(content).toContain('### Summary');
    expect(content).toContain('### Sources');
    expect(content).toContain('### For Follow-Up');
  });

  it('specifies word count requirements', () => {
    const content = fs.readFileSync(templatePath, 'utf-8');

    // Should specify 200-1000 words for synthesis
    expect(content).toMatch(/200-1000 words/);
    expect(content).toMatch(/max 1000 words/);
  });

  it('includes source metadata requirements', () => {
    const content = fs.readFileSync(templatePath, 'utf-8');

    // Check for source metadata fields
    expect(content).toContain('project-name');
    expect(content).toContain('YYYY-MM-DD');
    expect(content).toContain('% match');
    expect(content).toContain('Conversation summary:');
    expect(content).toContain('File:');
    expect(content).toContain('Status:');
    expect(content).toContain('Read in detail');
    expect(content).toContain('Reviewed summary only');
    expect(content).toContain('Skimmed');
  });

  it('provides search command', () => {
    const content = fs.readFileSync(templatePath, 'utf-8');

    // Should include the MCP tool for searching
    expect(content).toContain('mcp__plugin_episodic-memory_episodic-memory__search');
  });

  it('includes critical rules', () => {
    const content = fs.readFileSync(templatePath, 'utf-8');

    // Check for DO and DO NOT sections
    expect(content).toContain('## Critical Rules');
    expect(content).toContain('**DO:**');
    expect(content).toContain('**DO NOT:**');
  });

  it('includes complete example output', () => {
    const content = fs.readFileSync(templatePath, 'utf-8');

    // Check example has all required components
    expect(content).toContain('## Example Output');

    // Example should show Summary, Sources, and For Follow-Up
    const exampleSection = content.substring(content.indexOf('## Example Output'));
    expect(exampleSection).toContain('### Summary');
    expect(exampleSection).toContain('### Sources');
    expect(exampleSection).toContain('### For Follow-Up');

    // Example should show specific details
    expect(exampleSection).toContain('react-router-7-starter');
    expect(exampleSection).toContain('92% match');
    expect(exampleSection).toContain('.jsonl');
  });

  it('emphasizes synthesis over raw excerpts', () => {
    const content = fs.readFileSync(templatePath, 'utf-8');

    // Should explicitly discourage raw conversation excerpts
    expect(content).toContain('synthesize');
    expect(content).toContain('raw conversation excerpts');
    expect(content).toContain('synthesize instead');
  });

  it('provides follow-up options', () => {
    const content = fs.readFileSync(templatePath, 'utf-8');

    // Should explain how main agent can follow up
    expect(content).toContain('Main agent can:');
    expect(content).toContain('dig deeper');
    expect(content).toContain('refined query');
    expect(content).toContain('context bloat');
  });

  it('agent and skill files contain the new step and all existing steps', () => {
    const learnedStep =
      'If the context holds a learned-hints block, load the matching skill with the `skills` tool, then search as it advises.';

    const files = [
      path.join(__dirname, '..', 'agents', 'search-conversations.md'),
      path.join(__dirname, '..', 'skills', 'remembering-conversations', 'SKILL.md'),
      templatePath,
    ];
    for (const file of files) {
      const content = fs.readFileSync(file, 'utf-8');
      expect(content, file).toContain(learnedStep);
      // The step is the first one in each workflow, before the search step.
      const stepIndex = content.indexOf(learnedStep);
      const searchIndex = content.indexOf('Search ', stepIndex + learnedStep.length);
      expect(stepIndex, file).toBeLessThan(searchIndex);
    }

    // Every pre-existing step survives.
    const agent = fs.readFileSync(files[0], 'utf-8');
    for (const step of [
      'Search conversations using the `search` tool',
      'Read the top 2-5 most relevant results using the `read` tool',
      'Synthesize key findings (max 1000 words)',
      'Return synthesis + source pointers (so main agent can dig deeper)',
    ]) {
      expect(agent).toContain(step);
    }

    const skill = fs.readFileSync(files[1], 'utf-8');
    for (const step of [
      'Search with the `search` tool',
      'Read top 2-5 results with the `read` tool',
      'Synthesize findings (200-1000 words)',
      'Return actionable insights + sources',
    ]) {
      expect(skill).toContain(step);
    }
    // Both direct-MCP variants keep their steps too.
    expect(skill).toContain('Search with the episodic-memory `search` tool');
    expect(skill).toContain('Read the top 2-5 results with the episodic-memory `read` tool');

    const prompt = fs.readFileSync(templatePath, 'utf-8');
    for (const step of [
      'Search conversations for: {TOPIC}',
      'Read the top 2-5 most relevant results',
      'Synthesize key findings (max 1000 words)',
      'Return synthesis + source pointers (so main agent can dig deeper)',
    ]) {
      expect(prompt).toContain(step);
    }
  });
});
