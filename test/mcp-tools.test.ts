import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { handleToolCall } from '../src/mcp-tools.js';
import { safeRmSync } from './test-utils.js';

describe('handleToolCall', () => {
  let testDir: string;
  let archiveDir: string;
  const prevToken = process.env.EPISODIC_MEMORY_MCP_TOKEN;

  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'em-mcp-tools-'));
    archiveDir = path.join(testDir, 'archive');
    fs.mkdirSync(archiveDir, { recursive: true });
    process.env.TEST_ARCHIVE_DIR = archiveDir;
    process.env.EPISODIC_MEMORY_CONFIG_DIR = path.join(testDir, 'config');
    delete process.env.EPISODIC_MEMORY_MCP_TOKEN;
  });

  afterEach(async () => {
    const { closeSharedReaderDatabase } = await import('../src/db.js');
    closeSharedReaderDatabase();
    delete process.env.TEST_ARCHIVE_DIR;
    delete process.env.EPISODIC_MEMORY_CONFIG_DIR;
    delete process.env.TEST_DB_PATH;
    if (prevToken === undefined) delete process.env.EPISODIC_MEMORY_MCP_TOKEN;
    else process.env.EPISODIC_MEMORY_MCP_TOKEN = prevToken;
    safeRmSync(testDir);
  });

  it('returns an error for an unknown tool', async () => {
    const result = await handleToolCall('explode', {});
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/Unknown tool/);
  });

  it('rejects search input that fails Zod validation', async () => {
    const result = await handleToolCall('search', { query: 'x' });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/Error:/);
  });

  it('reads an in-archive jsonl and rejects paths outside', async () => {
    const file = path.join(archiveDir, 'sess.jsonl');
    fs.writeFileSync(
      file,
      JSON.stringify({
        uuid: '1',
        parentUuid: null,
        timestamp: '2026-08-30T00:00:00.000Z',
        type: 'user',
        isSidechain: false,
        message: { role: 'user', content: 'hello from archive' },
      }) + '\n',
      'utf-8'
    );

    const ok = await handleToolCall('read', { path: file });
    expect(ok.isError).toBeUndefined();
    expect(ok.content[0].text).toContain('hello from archive');

    const denied = await handleToolCall('read', { path: '/etc/passwd' });
    expect(denied.isError).toBe(true);
    expect(denied.content[0].text).toMatch(/outside the conversation archive/);
  });

  it('returns JSON and markdown search results, including multi-concept', async () => {
    process.env.TEST_DB_PATH = path.join(testDir, 'db.sqlite');
    const { initDatabase } = await import('../src/db.js');
    const db = initDatabase();
    db.close();

    const json = await handleToolCall('search', {
      query: 'authentication flow',
      mode: 'text',
      response_format: 'json',
    });
    expect(json.isError).toBeUndefined();
    const parsed = JSON.parse(json.content[0].text);
    expect(parsed.count).toBe(0);
    expect(parsed.mode).toBe('text');

    const md = await handleToolCall('search', {
      query: 'authentication flow',
      mode: 'text',
    });
    expect(md.content[0].text).toMatch(/No results found/);

    const multi = await handleToolCall('search', {
      query: ['alpha-concept', 'beta-concept'],
      response_format: 'json',
    });
    expect(multi.isError).toBeUndefined();
    const multiParsed = JSON.parse(multi.content[0].text);
    expect(multiParsed.concepts).toEqual(['alpha-concept', 'beta-concept']);
    expect(multiParsed.count).toBe(0);

    delete process.env.TEST_DB_PATH;
  });

  it('requires auth_token when EPISODIC_MEMORY_MCP_TOKEN is set', async () => {
    process.env.EPISODIC_MEMORY_MCP_TOKEN = 'gate';
    const denied = await handleToolCall('search', { query: 'authentication' });
    expect(denied.isError).toBe(true);
    expect(denied.content[0].text).toMatch(/Unauthorized/);

    const allowed = await handleToolCall('search', {
      query: 'authentication',
      auth_token: 'gate',
      mode: 'text',
    });
    // May error on missing DB, but must not be Unauthorized
    expect(allowed.content[0].text).not.toMatch(/Unauthorized/);
  });
});
