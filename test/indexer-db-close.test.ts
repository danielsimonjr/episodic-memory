import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { Database } from '../src/sqlite.js';
import { safeRmSync, suppressConsole } from './test-utils.js';

// Each index function opens the database before the function loads the embedding model.
// A failed load then throws inside the function.
// The test records every handle that `initDatabase` returns.
// The test also checks that the function closes the handle before the error leaves the function.
// The check reads `db.open`, so the check works on every platform.
// A delete of the open file cannot show the leak on Linux because Linux deletes an open file.
const opened: Database[] = [];

vi.mock('../src/db.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/db.js')>();
  return {
    ...actual,
    initDatabase: (...args: Parameters<typeof actual.initDatabase>) => {
      const db = actual.initDatabase(...args);
      opened.push(db);
      return db;
    },
  };
});

vi.mock('../src/embeddings.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/embeddings.js')>();
  return { ...actual, initEmbeddings: async () => { throw new Error('embedding backend failed to load'); } };
});

const { indexConversations, indexSession, indexUnprocessed } = await import('../src/indexer.js');

const SESSION = 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff';

describe('an index function closes the database when it throws', () => {
  const KEYS = ['TEST_PROJECTS_DIR', 'TEST_ARCHIVE_DIR', 'TEST_DB_PATH'] as const;
  const saved: Record<string, string | undefined> = {};
  let testDir: string;
  let restoreConsole: () => void;

  beforeEach(() => {
    opened.length = 0;
    for (const key of KEYS) saved[key] = process.env[key];
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'em-db-close-'));
    const projectsDir = path.join(testDir, 'projects');
    const project = path.join(projectsDir, '-Users-real-project');
    fs.mkdirSync(project, { recursive: true });
    fs.writeFileSync(path.join(project, `${SESSION}.jsonl`), '{}\n', 'utf-8');
    process.env.TEST_PROJECTS_DIR = projectsDir;
    process.env.TEST_ARCHIVE_DIR = path.join(testDir, 'archive');
    process.env.TEST_DB_PATH = path.join(testDir, 'test.db');
    restoreConsole = suppressConsole();
  });

  afterEach(() => {
    restoreConsole();
    for (const db of opened) if (db.open) db.close();
    for (const key of KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
    safeRmSync(testDir);
  });

  it('indexConversations', async () => {
    await expect(indexConversations(undefined, undefined, 1, true)).rejects.toThrow('embedding backend failed to load');
    expect(opened.length).toBe(1);
    expect(opened[0].open).toBe(false);
  });

  it('indexSession', async () => {
    await expect(indexSession(SESSION, 1, true)).rejects.toThrow('embedding backend failed to load');
    expect(opened.length).toBe(1);
    expect(opened[0].open).toBe(false);
  });

  it('indexUnprocessed', async () => {
    await expect(indexUnprocessed(1, true)).rejects.toThrow('embedding backend failed to load');
    expect(opened.length).toBe(1);
    expect(opened[0].open).toBe(false);
  });
});
