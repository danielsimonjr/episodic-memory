import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { parseConversation, parseConversationFile } from '../src/parser.js';
import { getFixturePath, safeRmSync } from './test-utils.js';

describe('Claude tool_result linking', () => {
  it('attaches tool_result content to the matching tool_use id', async () => {
    const fixture = getFixturePath('claude-tool-result.jsonl');
    const { exchanges } = await parseConversationFile(fixture);

    const withTools = exchanges.find((ex) => ex.toolCalls && ex.toolCalls.length > 0);
    expect(withTools).toBeDefined();
    expect(withTools!.toolCalls![0].id).toBe('toolu_abc123');
    expect(withTools!.toolCalls![0].toolName).toBe('Read');
    expect(withTools!.toolCalls![0].toolResult).toBe('file contents here');
    expect(withTools!.toolCalls![0].isError).toBe(false);
  });

  it('parseConversation uses the provided project name', async () => {
    const fixture = getFixturePath('claude-tool-result.jsonl');
    const exchanges = await parseConversation(fixture, 'my-project', fixture);
    expect(exchanges[0].project).toBe('my-project');
    expect(exchanges[0].userMessage).toContain('Please read the file');
  });
});

describe('parseConversationFile path project extraction', () => {
  it('uses the parent directory name as the project', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'em-parse-proj-'));
    const projectDir = path.join(dir, 'cool-app');
    fs.mkdirSync(projectDir, { recursive: true });
    const file = path.join(projectDir, 'session.jsonl');
    fs.copyFileSync(getFixturePath('claude-tool-result.jsonl'), file);
    try {
      const result = await parseConversationFile(file);
      expect(result.project).toBe('cool-app');
    } finally {
      safeRmSync(dir);
    }
  });
});
