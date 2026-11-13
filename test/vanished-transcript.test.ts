import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import Database from 'better-sqlite3';
import { safeRmSync, suppressConsole } from './test-utils.js';

// Claude Code can delete a transcript after the index walk lists the transcript and before the copy.
// The mock lists one extra file. The extra file does not exist. The extra file sorts first.
// As a result, when a run stops on the missing file, the run never reaches the real transcript.
const GHOST_SESSION = '00000000-0000-4000-8000-000000000000';
const GHOST = `${GHOST_SESSION}.jsonl`;

vi.mock('../src/paths.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/paths.js')>();
  return {
    ...actual,
    findJsonlFiles: (...args: Parameters<typeof actual.findJsonlFiles>) => [GHOST, ...actual.findJsonlFiles(...args)],
  };
});

const { indexConversations, indexSession, indexUnprocessed } = await import('../src/indexer.js');

const SESSION = 'cccccccc-dddd-4eee-8fff-000000000001';

function exchangeLines(sessionId: string): string {
  const ts = '2026-01-03T00:00:00.000Z';
  const user = {
    parentUuid: null, isSidechain: false, userType: 'external', cwd: '/test/project', sessionId,
    version: '2.0.9', gitBranch: 'main', type: 'user',
    message: { role: 'user', content: `A question about the vanished transcript test in session ${sessionId}` },
    uuid: `user-1-${sessionId}`, timestamp: ts,
  };
  const assistant = {
    parentUuid: `user-1-${sessionId}`, isSidechain: false, userType: 'external', cwd: '/test/project', sessionId,
    version: '2.0.9', gitBranch: 'main', type: 'assistant',
    message: { model: 'claude-sonnet-4-5', role: 'assistant', content: [{ type: 'text', text: `An answer in session ${sessionId}` }] },
    uuid: `asst-1-${sessionId}`, timestamp: ts,
  };
  return JSON.stringify(user) + '\n' + JSON.stringify(assistant) + '\n';
}

describe('a transcript that disappears after the listing does not stop an index run', () => {
  const KEYS = ['TEST_PROJECTS_DIR', 'TEST_ARCHIVE_DIR', 'TEST_DB_PATH'] as const;
  const saved: Record<string, string | undefined> = {};
  let testDir: string;
  let archiveDir: string;
  let dbPath: string;
  let restoreConsole: () => void;

  beforeEach(() => {
    for (const key of KEYS) saved[key] = process.env[key];
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'em-vanished-'));
    const projectsDir = path.join(testDir, 'projects');
    const project = path.join(projectsDir, '-Users-real-project');
    fs.mkdirSync(project, { recursive: true });
    fs.writeFileSync(path.join(project, `${SESSION}.jsonl`), exchangeLines(SESSION), 'utf-8');
    archiveDir = path.join(testDir, 'archive');
    dbPath = path.join(testDir, 'test.db');
    process.env.TEST_PROJECTS_DIR = projectsDir;
    process.env.TEST_ARCHIVE_DIR = archiveDir;
    process.env.TEST_DB_PATH = dbPath;
    restoreConsole = suppressConsole();
  });

  afterEach(() => {
    restoreConsole();
    for (const key of KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
    safeRmSync(testDir);
  });

  function indexedPaths(): string[] {
    if (!fs.existsSync(dbPath)) return [];
    const db = new Database(dbPath, { readonly: true });
    try {
      return (db.prepare('SELECT DISTINCT archive_path FROM exchanges').all() as Array<{ archive_path: string }>)
        .map(row => row.archive_path);
    } finally {
      db.close();
    }
  }

  it('indexConversations skips the missing file and indexes the real transcript', async () => {
    await indexConversations(undefined, undefined, 1, true);
    const paths = indexedPaths();
    expect(paths.some(p => p.includes(SESSION))).toBe(true);
    expect(paths.some(p => p.includes(GHOST_SESSION))).toBe(false);
  }, 60000);

  it('indexUnprocessed skips the missing file and indexes the real transcript', async () => {
    await indexUnprocessed(1, true);
    const paths = indexedPaths();
    expect(paths.some(p => p.includes(SESSION))).toBe(true);
    expect(paths.some(p => p.includes(GHOST_SESSION))).toBe(false);
  }, 60000);

  it('indexSession returns without an error when the session file disappears', async () => {
    await expect(indexSession(GHOST_SESSION, 1, true)).resolves.toBeUndefined();
    expect(indexedPaths().some(p => p.includes(GHOST_SESSION))).toBe(false);
  }, 60000);

  it('skips the file when the archive copy exists and the source is gone (the parse fails, not the copy)', async () => {
    const archived = path.join(archiveDir, '-Users-real-project', GHOST);
    fs.mkdirSync(path.dirname(archived), { recursive: true });
    fs.writeFileSync(archived, exchangeLines(GHOST_SESSION), 'utf-8');
    await indexConversations(undefined, undefined, 1, true);
    const paths = indexedPaths();
    expect(paths.some(p => p.includes(SESSION))).toBe(true);
    expect(paths.some(p => p.includes(GHOST_SESSION))).toBe(false);
  }, 60000);

  it('leaves no archive copy of the missing file', async () => {
    await indexConversations(undefined, undefined, 1, true);
    expect(fs.existsSync(path.join(archiveDir, '-Users-real-project', GHOST))).toBe(false);
  }, 60000);
});
