import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { mkdirSync, writeFileSync } from 'fs';
import { indexUnprocessed } from '../../src/indexer.js';
import { initDatabase, closeSharedReaderDatabase } from '../../src/db.js';
import { ensureDigestSchema, insertDigestEntry } from '../../src/digest-db.js';
import {
  learnSearch,
  learnRead,
  learnDigest,
  learnSkills,
} from '../../src/learn/learn-handlers.js';
import { LEARN_OFF_MESSAGE } from '../../src/learn/learn-config.js';
import { projectKeyFromCwd } from '../../src/digest-inject.js';
import { safeRmSync, suppressConsole } from '../test-utils.js';

suppressConsole();

function lines(opts: { seq: number; sessionId: string; topic: string }): string {
  const ts = new Date(2026, 0, 1 + opts.seq).toISOString();
  const userUuid = `u-${opts.seq}`;
  return (
    JSON.stringify({
      parentUuid: null,
      isSidechain: false,
      userType: 'external',
      cwd: '/test/project',
      sessionId: opts.sessionId,
      version: '2.0.9',
      gitBranch: 'main',
      type: 'user',
      message: { role: 'user', content: `Question about ${opts.topic}` },
      uuid: userUuid,
      timestamp: ts,
    }) +
    '\n' +
    JSON.stringify({
      parentUuid: userUuid,
      isSidechain: false,
      userType: 'external',
      cwd: '/test/project',
      sessionId: opts.sessionId,
      version: '2.0.9',
      gitBranch: 'main',
      type: 'assistant',
      message: {
        model: 'claude-sonnet-4-5',
        role: 'assistant',
        content: [{ type: 'text', text: `Answer about ${opts.topic}` }],
      },
      uuid: `a-${opts.seq}`,
      timestamp: ts,
    }) +
    '\n'
  );
}

describe('learn handlers', () => {
  let testDir: string;
  let projectsDir: string;
  let archiveDir: string;
  let configDir: string;

  beforeEach(async () => {
    closeSharedReaderDatabase();
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'em-learn-handlers-'));
    projectsDir = path.join(testDir, 'projects');
    archiveDir = path.join(testDir, 'archive');
    configDir = path.join(testDir, 'config');
    mkdirSync(projectsDir, { recursive: true });
    mkdirSync(configDir, { recursive: true });

    process.env.TEST_PROJECTS_DIR = projectsDir;
    process.env.TEST_ARCHIVE_DIR = archiveDir;
    process.env.EPISODIC_MEMORY_CONFIG_DIR = configDir;
    process.env.TEST_DB_PATH = path.join(testDir, 'test.db');

    const dir = path.join(projectsDir, 'proj');
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, 's1.jsonl'), lines({ seq: 1, sessionId: 's1', topic: 'authentication' }));
    writeFileSync(path.join(dir, 's2.jsonl'), lines({ seq: 2, sessionId: 's2', topic: 'authentication' }));

    await indexUnprocessed(1, true);
  });

  afterEach(() => {
    closeSharedReaderDatabase();
    delete process.env.TEST_PROJECTS_DIR;
    delete process.env.TEST_ARCHIVE_DIR;
    delete process.env.EPISODIC_MEMORY_CONFIG_DIR;
    delete process.env.TEST_DB_PATH;
    delete process.env.EPISODIC_MEMORY_MCP_TOKEN;
    safeRmSync(testDir);
  });

  function exchangeRows(): Array<{ id: string; archive_path: string }> {
    const db = initDatabase();
    try {
      return db.prepare('SELECT id, archive_path FROM exchanges').all() as Array<{
        id: string;
        archive_path: string;
      }>;
    } finally {
      db.close();
    }
  }

  it('learnSearch excludes a hidden id and never prints its path', async () => {
    const rows = exchangeRows();
    expect(rows.length).toBe(2);
    const hidden = rows[0];

    const text = await learnSearch(
      { query: 'authentication', mode: 'text', limit: 10 },
      { hideExchangeIds: [hidden.id] }
    );

    expect(text).toContain('Question about authentication');
    expect(text).not.toContain(hidden.archive_path);
    expect(text).not.toContain(path.basename(hidden.archive_path));
  });

  it('learnSearch leaves everything when nothing is hidden', async () => {
    const text = await learnSearch(
      { query: 'authentication', mode: 'text', limit: 10 },
      { hideExchangeIds: [] }
    );
    for (const row of exchangeRows()) expect(text).toContain(row.archive_path);
  });

  it('learnSearch never prints a summary line even with the env default on', async () => {
    delete process.env.EPISODIC_MEMORY_INCLUDE_SUMMARY;
    const row = exchangeRows()[0];
    writeFileSync(row.archive_path.replace(/\.jsonl$/, '-summary.txt'), 'A planted summary.', 'utf-8');

    const text = await learnSearch({ query: 'authentication', mode: 'text', limit: 10 }, { hideExchangeIds: [] });
    expect(text).not.toContain('A planted summary.');
  });

  it('learnSearch handles a multi-concept query and excludes hidden ids there too', async () => {
    const hidden = exchangeRows()[0];
    const text = await learnSearch(
      { query: ['authentication', 'authentication'], limit: 10 },
      { hideExchangeIds: [hidden.id] }
    );
    expect(text).not.toContain(hidden.archive_path);
  });

  it('learnRead adds auth_token from the env when the token is set', async () => {
    process.env.EPISODIC_MEMORY_MCP_TOKEN = 'sekret';
    const row = exchangeRows()[0];
    const text = await learnRead({ path: row.archive_path });
    expect(text).toContain('authentication');
  });

  it('learnRead fails without the env token when one is required', async () => {
    process.env.EPISODIC_MEMORY_MCP_TOKEN = 'sekret';
    const row = exchangeRows()[0];
    // The handler injects the token, so the direct MCP call is what fails.
    const { handleToolCall } = await import('../../src/mcp-tools.js');
    const result = await handleToolCall('read', { path: row.archive_path });
    expect(result.isError).toBe(true);
  });

  it('learnDigest defaults to the project view and hides cited lines', async () => {
    const project = projectKeyFromCwd(process.cwd());
    const rows = exchangeRows();
    const db = initDatabase();
    try {
      insertDigestEntry(db, {
        tier: 'session',
        project,
        periodStart: '2026-10-01T09:00:00.000Z',
        periodEnd: '2026-10-01T09:00:00.000Z',
        text: `Visible note [#${rows[0].id}]\nHidden note [#${rows[1].id}]`,
        sources: [rows[0].id, rows[1].id],
        model: 'haiku',
        handoff: false,
      });
    } finally {
      db.close();
    }

    const text = await learnDigest({}, { project, hideExchangeIds: [rows[1].id] });
    expect(text).toContain('Visible note');
    expect(text).not.toContain('Hidden note');
  });

  it('learnDigest query hides cited lines', async () => {
    const project = projectKeyFromCwd(process.cwd());
    const rows = exchangeRows();
    const db = initDatabase();
    try {
      insertDigestEntry(db, {
        tier: 'session',
        project,
        periodStart: '2026-10-02T09:00:00.000Z',
        periodEnd: '2026-10-02T09:00:00.000Z',
        text: `The cache decision [#${rows[1].id}]`,
        sources: [rows[1].id],
        model: 'haiku',
        handoff: false,
      });
    } finally {
      db.close();
    }

    const text = await learnDigest({ query: 'cache' }, { project, hideExchangeIds: [rows[1].id] });
    expect(text).not.toContain('The cache decision');
  });

  it('learnDigest refuses to expand a hidden id and takes no handoff argument', async () => {
    const rows = exchangeRows();
    const project = projectKeyFromCwd(process.cwd());
    const text = await learnDigest({ expand: rows[0].id }, { project, hideExchangeIds: [rows[0].id] });
    expect(text).toMatch(/not available|refus|hidden|cannot/i);
    expect(text).not.toContain(rows[0].archive_path);

    // `handoff` is a write. The handler's argument type has no such key, and a
    // caller that smuggles one in gets no note written.
    const db = initDatabase();
    let before = 0;
    try {
      before = (db.prepare('SELECT COUNT(*) AS c FROM digest_entry').get() as { c: number }).c;
    } finally {
      db.close();
    }
    await learnDigest({ handoff: 'do this next time' } as never, { project, hideExchangeIds: [] });
    const after = initDatabase();
    try {
      expect((after.prepare('SELECT COUNT(*) AS c FROM digest_entry').get() as { c: number }).c).toBe(before);
    } finally {
      after.close();
    }
  });

  it('learnDigest expands a non-hidden id', async () => {
    const rows = exchangeRows();
    const project = projectKeyFromCwd(process.cwd());
    const text = await learnDigest({ expand: rows[0].id }, { project, hideExchangeIds: [rows[1].id] });
    expect(text).toContain(rows[0].archive_path);
  });

  it('learnDigest with no entries says so', async () => {
    const project = projectKeyFromCwd(process.cwd());
    const text = await learnDigest({}, { project, hideExchangeIds: [] });
    expect(text).toMatch(/No digest entries/);
  });

  it('learnSkills answers the off-flag message without creating a store', async () => {
    delete process.env.EPISODIC_MEMORY_LEARN;
    const text = await learnSkills({});
    expect(text).toBe(LEARN_OFF_MESSAGE);
    expect(fs.existsSync(path.join(configDir, 'learned'))).toBe(false);
  });
});
