import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import Database from 'better-sqlite3';
import { syncConversations } from '../src/sync.js';
import { indexConversations, indexSession, indexUnprocessed } from '../src/indexer.js';
import { verifyIndex } from '../src/verify.js';
import { statIfExists } from '../src/paths.js';
import { safeRmSync, suppressConsole } from './test-utils.js';

// A storage migration can leave a project link whose target is gone. `fs.statSync` follows the link and throws
// ENOENT. The error used to abort the whole walk. Some hosts cannot create a link (Windows without the privilege).
// Probe once and skip the link tests there. The CI runner is Linux. The runner runs the link tests.
let linksSupported = true;
{
  const probe = fs.mkdtempSync(path.join(os.tmpdir(), 'em-link-probe-'));
  try {
    fs.symlinkSync(path.join(probe, 'no-such-target'), path.join(probe, 'link'), 'dir');
  } catch {
    linksSupported = false;
  }
  safeRmSync(probe);
}

const SESSION = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

function exchangeLines(sessionId: string): string {
  const ts = '2026-01-02T00:00:00.000Z';
  const user = {
    parentUuid: null, isSidechain: false, userType: 'external', cwd: '/test/project', sessionId,
    version: '2.0.9', gitBranch: 'main', type: 'user',
    message: { role: 'user', content: `A question about the dangling link test in session ${sessionId}` },
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

describe('statIfExists', () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'em-statifexists-')); });
  afterEach(() => { safeRmSync(dir); });

  it('returns the stats of a directory', () => {
    expect(statIfExists(dir)?.isDirectory()).toBe(true);
  });

  it('returns null for a path that does not exist', () => {
    expect(statIfExists(path.join(dir, 'missing'))).toBeNull();
  });

  it.skipIf(!linksSupported)('returns null for a link whose target does not exist', () => {
    const link = path.join(dir, 'dangling');
    fs.symlinkSync(path.join(dir, 'no-such-target'), link, 'dir');
    expect(() => fs.statSync(link)).toThrow();
    expect(statIfExists(link)).toBeNull();
  });
});

describe.skipIf(!linksSupported)('a dangling project link does not stop a directory walk', () => {
  const saved: Record<string, string | undefined> = {};
  const KEYS = ['TEST_PROJECTS_DIR', 'TEST_ARCHIVE_DIR', 'TEST_DB_PATH'] as const;
  let testDir: string;
  let projectsDir: string;
  let archiveDir: string;
  let dbPath: string;
  let restoreConsole: () => void;

  beforeEach(() => {
    for (const key of KEYS) saved[key] = process.env[key];
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'em-dangling-'));
    projectsDir = path.join(testDir, 'projects');
    archiveDir = path.join(testDir, 'archive');
    dbPath = path.join(testDir, 'test.db');
    fs.mkdirSync(projectsDir, { recursive: true });
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

  /** One real project with one conversation, and a dangling link beside the project. The link sorts first. */
  function setup(parent: string): void {
    const project = path.join(parent, '-Users-real-project');
    fs.mkdirSync(project, { recursive: true });
    fs.writeFileSync(path.join(project, `${SESSION}.jsonl`), exchangeLines(SESSION), 'utf-8');
    fs.symlinkSync(path.join(testDir, 'no-such-target'), path.join(parent, '-Users-a-migrated-away'), 'dir');
  }

  function indexedPaths(): string[] {
    const db = new Database(dbPath, { readonly: true });
    try {
      return (db.prepare('SELECT DISTINCT archive_path FROM exchanges').all() as Array<{ archive_path: string }>)
        .map(row => row.archive_path);
    } finally {
      db.close();
    }
  }

  it('syncConversations copies the real project and skips the link', async () => {
    setup(projectsDir);
    const result = await syncConversations(projectsDir, archiveDir, { skipIndex: true, skipSummaries: true });
    expect(result.copied).toBe(1);
    expect(fs.existsSync(path.join(archiveDir, '-Users-real-project', `${SESSION}.jsonl`))).toBe(true);
  });

  it('indexConversations indexes the real project and skips the link', async () => {
    setup(projectsDir);
    await indexConversations(undefined, undefined, 1, true);
    expect(indexedPaths().some(p => p.includes(SESSION))).toBe(true);
  }, 60000);

  it('indexSession finds the session in the real project and skips the link', async () => {
    setup(projectsDir);
    await indexSession(SESSION, 1, true);
    expect(indexedPaths().some(p => p.includes(SESSION))).toBe(true);
  }, 60000);

  it('indexUnprocessed indexes the real project and skips the link', async () => {
    setup(projectsDir);
    await indexUnprocessed(1, true);
    expect(indexedPaths().some(p => p.includes(SESSION))).toBe(true);
  }, 60000);

  it('verifyIndex walks an archive that holds a dangling link', async () => {
    setup(archiveDir);
    const result = await verifyIndex();
    expect(result.missing.some(m => m.path.includes(SESSION))).toBe(true);
  });
});
