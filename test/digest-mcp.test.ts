import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { initDatabase } from '../src/db.js';
import { insertDigestEntry } from '../src/digest-db.js';
import { handleToolCall } from '../src/mcp-tools.js';
import { runDigestPhase } from '../src/digest-phase.js';
import { normalizeHandoff } from '../src/digest-tool.js';
import { safeRmSync, suppressConsole } from './test-utils.js';

suppressConsole();

describe('digest MCP tool', () => {
  const dir = path.join(os.tmpdir(), 'digest-mcp-' + Date.now());

  beforeEach(() => {
    fs.mkdirSync(dir, { recursive: true });
    process.env.TEST_DB_PATH = path.join(dir, 't.db');
    const db = initDatabase();
    insertDigestEntry(db, {
      tier: 'session',
      project: 'proj-a',
      periodStart: '2026-10-07T09:00:00.000Z',
      periodEnd: '2026-10-07T09:30:00.000Z',
      text: 'Chose sqlite for the cache [#e1]',
      sources: ['e1'],
      model: 'haiku',
      handoff: false,
    });
    db.prepare(
      `INSERT INTO exchanges (id, project, timestamp, user_message, assistant_message, archive_path, line_start, line_end, session_id)
       VALUES ('e1', 'proj-a', '2026-10-07T09:00:00.000Z', 'q', 'a', '/archive/a.jsonl', 4, 9, 's1')`
    ).run();
    db.close();
  });
  afterEach(() => {
    delete process.env.TEST_DB_PATH;
    delete process.env.EPISODIC_MEMORY_DIGEST;
    safeRmSync(dir);
  });

  const text = (r: { content: Array<{ text: string }> }) => r.content[0].text;

  it('shows the digest for a project', async () => {
    const r = await handleToolCall('digest', { project: 'proj-a' });
    expect(r.isError).toBeUndefined();
    expect(text(r)).toContain('Chose sqlite for the cache [#e1]');
  });

  it('says so when the project has no entries', async () => {
    const r = await handleToolCall('digest', { project: 'nope' });
    expect(text(r)).toContain('No digest entries');
  });

  it('searches the digest', async () => {
    const r = await handleToolCall('digest', { query: 'sqlite' });
    expect(text(r)).toContain('Chose sqlite');
    const none = await handleToolCall('digest', { query: 'postgres' });
    expect(text(none)).toContain('No digest entries match');
  });

  it('expands an exchange id into a path and line range for read', async () => {
    const r = await handleToolCall('digest', { expand: 'e1' });
    expect(text(r)).toContain('path: /archive/a.jsonl');
    expect(text(r)).toContain('startLine: 4');
    expect(text(r)).toContain('endLine: 9');
  });

  it('reports an unknown exchange id as an error', async () => {
    const r = await handleToolCall('digest', { expand: 'missing' });
    expect(r.isError).toBe(true);
  });

  it('stores a handoff note that then comes first in the view', async () => {
    const save = await handleToolCall('digest', { project: 'proj-a', handoff: 'Resume the cache work in src/cache.ts' });
    expect(save.isError).toBeUndefined();
    const view = await handleToolCall('digest', { project: 'proj-a' });
    const t = text(view);
    expect(t.indexOf('Resume the cache work')).toBeGreaterThan(-1);
    expect(t.indexOf('Resume the cache work')).toBeLessThan(t.indexOf('Chose sqlite'));
  });

  it('rejects unknown arguments', async () => {
    const r = await handleToolCall('digest', { bogus: 1 });
    expect(r.isError).toBe(true);
  });
});

describe('normalizeHandoff', () => {
  it('redacts, flattens to one line, and caps at 500 characters', () => {
    const out = normalizeHandoff(`line one\nline two sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGH ${'z'.repeat(800)}`);
    expect(out).not.toContain('\n');
    expect(out).not.toContain('sk-ant-api03');
    expect(out.length).toBeLessThanOrEqual(500);
  });
});

describe('runDigestPhase', () => {
  afterEach(() => {
    delete process.env.EPISODIC_MEMORY_DIGEST;
  });

  it('does nothing and never calls the model with the flag off', async () => {
    let called = false;
    const r = await runDigestPhase({
      model: async () => {
        called = true;
        return '';
      },
    });
    expect(r).toBeNull();
    expect(called).toBe(false);
  });

  it('survives a thrown error and returns null', async () => {
    process.env.EPISODIC_MEMORY_DIGEST = '1';
    const r = await runDigestPhase({
      db: {
        prepare() {
          throw new Error('db exploded');
        },
      } as never,
    });
    expect(r).toBeNull();
  });
});
