import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import {
  tryChmod,
  getClaudeDir,
  getCodexDir,
  getConversationSourceDirs,
  findJsonlFiles,
  getSuperpowersDir,
  getArchiveDir,
  getIndexDir,
  getDbPath,
  getExcludeConfigPath,
  getExcludedProjects,
} from '../src/paths.js';
import { safeRmSync } from './test-utils.js';

describe('paths', () => {
  let testDir: string;
  const envKeys = [
    'CLAUDE_CONFIG_DIR',
    'CODEX_HOME',
    'TEST_PROJECTS_DIR',
    'EPISODIC_MEMORY_CONFIG_DIR',
    'PERSONAL_SUPERPOWERS_DIR',
    'XDG_CONFIG_HOME',
    'TEST_ARCHIVE_DIR',
    'TEST_DB_PATH',
    'EPISODIC_MEMORY_DB_PATH',
    'CONVERSATION_SEARCH_EXCLUDE_PROJECTS',
  ];
  const prev: Record<string, string | undefined> = {};

  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'em-paths-'));
    for (const key of envKeys) {
      prev[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of envKeys) {
      if (prev[key] === undefined) delete process.env[key];
      else process.env[key] = prev[key];
    }
    safeRmSync(testDir);
  });

  it('resolves claude/codex dirs from env or home defaults', () => {
    process.env.CLAUDE_CONFIG_DIR = path.join(testDir, 'claude');
    process.env.CODEX_HOME = path.join(testDir, 'codex');
    expect(getClaudeDir()).toBe(path.join(testDir, 'claude'));
    expect(getCodexDir()).toBe(path.join(testDir, 'codex'));
  });

  it('lists only existing conversation source dirs', () => {
    const projects = path.join(testDir, 'claude', 'projects');
    fs.mkdirSync(projects, { recursive: true });
    process.env.CLAUDE_CONFIG_DIR = path.join(testDir, 'claude');
    process.env.CODEX_HOME = path.join(testDir, 'codex-missing');
    expect(getConversationSourceDirs()).toEqual([projects]);

    process.env.TEST_PROJECTS_DIR = path.join(testDir, 'override');
    expect(getConversationSourceDirs()).toEqual([path.join(testDir, 'override')]);
  });

  it('finds jsonl files recursively and skips excluded dir names', () => {
    const root = path.join(testDir, 'src');
    fs.mkdirSync(path.join(root, 'proj', 'subagents'), { recursive: true });
    fs.writeFileSync(path.join(root, 'top.jsonl'), '', 'utf-8');
    fs.writeFileSync(path.join(root, 'proj', 'nested.jsonl'), '', 'utf-8');
    fs.writeFileSync(path.join(root, 'proj', 'subagents', 'skip.jsonl'), '', 'utf-8');
    fs.writeFileSync(path.join(root, 'notes.txt'), '', 'utf-8');

    const all = findJsonlFiles(root);
    expect(all).toEqual(expect.arrayContaining(['top.jsonl', path.join('proj', 'nested.jsonl')]));
    expect(all.some((f) => f.includes('skip.jsonl'))).toBe(true);

    const filtered = findJsonlFiles(root, new Set(['subagents']));
    expect(filtered.some((f) => f.includes('skip.jsonl'))).toBe(false);
    expect(findJsonlFiles(path.join(testDir, 'nope'))).toEqual([]);
  });

  it('creates config/archive/index dirs and honors overrides', () => {
    process.env.EPISODIC_MEMORY_CONFIG_DIR = testDir;
    expect(getSuperpowersDir()).toBe(testDir);
    expect(getArchiveDir()).toBe(path.join(testDir, 'conversation-archive'));
    expect(getIndexDir()).toBe(path.join(testDir, 'conversation-index'));
    expect(getDbPath()).toBe(path.join(testDir, 'conversation-index', 'db.sqlite'));
    expect(getExcludeConfigPath()).toBe(path.join(testDir, 'conversation-index', 'exclude.txt'));

    process.env.TEST_ARCHIVE_DIR = path.join(testDir, 'alt-archive');
    expect(getArchiveDir()).toBe(path.join(testDir, 'alt-archive'));

    process.env.TEST_DB_PATH = path.join(testDir, 'custom.sqlite');
    expect(getDbPath()).toBe(path.join(testDir, 'custom.sqlite'));
  });

  it('reads excluded projects from env or exclude.txt', () => {
    process.env.EPISODIC_MEMORY_CONFIG_DIR = testDir;
    process.env.CONVERSATION_SEARCH_EXCLUDE_PROJECTS = 'a, b ,c';
    expect(getExcludedProjects()).toEqual(['a', 'b', 'c']);

    delete process.env.CONVERSATION_SEARCH_EXCLUDE_PROJECTS;
    const cfg = getExcludeConfigPath();
    fs.mkdirSync(path.dirname(cfg), { recursive: true });
    fs.writeFileSync(cfg, '# comment\nnoisy\n\n', 'utf-8');
    expect(getExcludedProjects()).toEqual(['noisy']);
  });

  it('tryChmod is best-effort and does not throw', () => {
    const file = path.join(testDir, 'f.txt');
    fs.writeFileSync(file, 'x', 'utf-8');
    expect(() => tryChmod(file, 0o600)).not.toThrow();
    expect(() => tryChmod(path.join(testDir, 'missing'), 0o600)).not.toThrow();
  });
});
