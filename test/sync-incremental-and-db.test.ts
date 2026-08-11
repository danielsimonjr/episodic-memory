import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, statSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import Database from 'better-sqlite3';
import { syncConversations } from '../src/sync.js';
import { initDatabase } from '../src/db.js';
import { formatResults } from '../src/search.js';
import { SearchResult } from '../src/types.js';
import { suppressConsole, safeRmSync } from './test-utils.js';

function makeExchangeLines(seq: number, sessionId: string): string {
  const userUuid = `user-${seq}-${sessionId}`;
  const assistantUuid = `asst-${seq}-${sessionId}`;
  const ts = new Date(2026, 0, 1 + seq).toISOString();
  const userLine = JSON.stringify({
    parentUuid: seq === 1 ? null : `asst-${seq - 1}-${sessionId}`,
    isSidechain: false,
    userType: 'external',
    cwd: '/test/project',
    sessionId,
    version: '2.0.9',
    gitBranch: 'main',
    type: 'user',
    message: { role: 'user', content: `User question number ${seq} about topic-${seq}` },
    uuid: userUuid,
    timestamp: ts,
  });
  const assistantLine = JSON.stringify({
    parentUuid: userUuid,
    isSidechain: false,
    userType: 'external',
    cwd: '/test/project',
    sessionId,
    version: '2.0.9',
    gitBranch: 'main',
    type: 'assistant',
    message: {
      model: 'claude-sonnet-4-5',
      role: 'assistant',
      content: [{ type: 'text', text: `Assistant answer ${seq} discussing details of topic-${seq}` }],
    },
    uuid: assistantUuid,
    timestamp: ts,
  });
  return userLine + '\n' + assistantLine + '\n';
}

describe('sync high-water incremental indexing', () => {
  let testDir: string;
  let projectsDir: string;
  let archiveDir: string;
  let configDir: string;
  let dbPath: string;
  let restoreConsole: () => void;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'em-sync-hw-'));
    projectsDir = join(testDir, 'projects');
    archiveDir = join(testDir, 'archive');
    configDir = join(testDir, 'config');
    dbPath = join(testDir, 'test.db');
    mkdirSync(projectsDir, { recursive: true });
    mkdirSync(archiveDir, { recursive: true });
    mkdirSync(configDir, { recursive: true });

    process.env.TEST_PROJECTS_DIR = projectsDir;
    process.env.TEST_ARCHIVE_DIR = archiveDir;
    process.env.EPISODIC_MEMORY_CONFIG_DIR = configDir;
    process.env.TEST_DB_PATH = dbPath;
    restoreConsole = suppressConsole();
  });

  afterEach(() => {
    restoreConsole();
    delete process.env.TEST_PROJECTS_DIR;
    delete process.env.TEST_ARCHIVE_DIR;
    delete process.env.EPISODIC_MEMORY_CONFIG_DIR;
    delete process.env.TEST_DB_PATH;
    safeRmSync(testDir);
  });

  function countExchanges(): number {
    const db = new Database(dbPath);
    const row = db.prepare('SELECT COUNT(*) AS c FROM exchanges').get() as { c: number };
    db.close();
    return row.c;
  }

  it('only indexes newly appended exchanges on a second sync', async () => {
    const projectDir = join(projectsDir, 'project-a');
    mkdirSync(projectDir, { recursive: true });
    const transcriptPath = join(projectDir, 'session-1.jsonl');

    writeFileSync(
      transcriptPath,
      makeExchangeLines(1, 'session-1') + makeExchangeLines(2, 'session-1'),
      'utf-8'
    );

    await syncConversations(projectsDir, archiveDir, { skipSummaries: true });
    expect(countExchanges()).toBe(2);

    // Ensure mtime advances so copyIfNewer picks the file up again
    const later = new Date(Date.now() + 2000);
    appendFileSync(
      transcriptPath,
      makeExchangeLines(3, 'session-1') + makeExchangeLines(4, 'session-1'),
      'utf-8'
    );
    // Touch explicitly in case append doesn't bump enough on some FS
    const { utimesSync } = await import('fs');
    utimesSync(transcriptPath, later, later);

    await syncConversations(projectsDir, archiveDir, { skipSummaries: true });
    expect(countExchanges()).toBe(4);
  }, 120_000);
});

describe('formatResults avoids full-file line counts', () => {
  it('reports ≥line_end instead of scanning the archive', async () => {
    const result: SearchResult & { summary?: string } = {
      exchange: {
        id: '1',
        project: 'p',
        timestamp: '2026-01-01T00:00:00.000Z',
        userMessage: 'hello world',
        assistantMessage: 'hi',
        archivePath: '/nonexistent/path.jsonl',
        lineStart: 10,
        lineEnd: 42,
      },
      similarity: 0.9,
      snippet: 'hello world',
    };
    const text = await formatResults([result]);
    expect(text).toContain('Lines 10-42');
    expect(text).toContain('≥42 lines');
    expect(text).not.toMatch(/, \d+ lines\)/);
  });
});

describe('database file modes and indexes', () => {
  let testDir: string;
  let dbPath: string;
  let restoreConsole: () => void;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'em-db-mode-'));
    dbPath = join(testDir, 'index', 'db.sqlite');
    process.env.TEST_DB_PATH = dbPath;
    process.env.EPISODIC_MEMORY_CONFIG_DIR = join(testDir, 'config');
    restoreConsole = suppressConsole();
  });

  afterEach(() => {
    restoreConsole();
    delete process.env.TEST_DB_PATH;
    delete process.env.EPISODIC_MEMORY_CONFIG_DIR;
    safeRmSync(testDir);
  });

  it('creates archive_path + embedding_version indexes and FTS table', () => {
    const db = initDatabase();
    const indexes = db
      .prepare(`SELECT name FROM sqlite_master WHERE type='index'`)
      .all() as Array<{ name: string }>;
    const names = new Set(indexes.map((i) => i.name));
    expect(names.has('idx_archive_path')).toBe(true);
    expect(names.has('idx_embedding_version')).toBe(true);

    const fts = db
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='exchanges_fts'`)
      .get();
    expect(fts).toBeTruthy();
    db.close();
  });

  it('applies restrictive modes on Unix', () => {
    if (process.platform === 'win32') return;
    const db = initDatabase();
    db.close();
    const mode = statSync(dbPath).mode & 0o777;
    // 0o600 preferred; some umasks may leave group bits — assert owner-only write at least
    expect(mode & 0o077).toBe(0);
  });
});
