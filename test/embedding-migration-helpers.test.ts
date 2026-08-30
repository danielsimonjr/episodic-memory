import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'path';
import os from 'os';
import fs from 'fs';
import {
  EMBEDDING_VERSION,
  getMigrationLockPath,
  countStale,
  pickStaleBatch,
  recordReembedded,
} from '../src/embedding-migration.js';
import { initDatabase, insertExchange } from '../src/db.js';
import type { ConversationExchange } from '../src/types.js';
import { safeRmSync } from './test-utils.js';

describe('embedding-migration helpers', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'em-mig-helpers-'));
    process.env.TEST_DB_PATH = path.join(testDir, 'db.sqlite');
  });

  afterEach(() => {
    delete process.env.TEST_DB_PATH;
    safeRmSync(testDir);
  });

  it('builds the lock path and counts/picks stale rows', () => {
    expect(getMigrationLockPath('/tmp/index')).toBe(path.join('/tmp/index', '.embedding-migration.lock'));
    expect(EMBEDDING_VERSION).toBeGreaterThanOrEqual(1);

    const db = initDatabase();
    const embedding = new Array(384).fill(0.02);
    const exchange: ConversationExchange = {
      id: 'fresh',
      project: 'p',
      timestamp: '2026-01-01T00:00:00.000Z',
      userMessage: 'u',
      assistantMessage: 'a',
      archivePath: '/tmp/a.jsonl',
      lineStart: 1,
      lineEnd: 2,
    };
    insertExchange(db, exchange, embedding);
    expect(countStale(db)).toBe(0);
    expect(pickStaleBatch(db, 10)).toEqual([]);

    db.prepare('UPDATE exchanges SET embedding_version = 0 WHERE id = ?').run('fresh');
    expect(countStale(db)).toBe(1);
    expect(pickStaleBatch(db, 10)[0].id).toBe('fresh');

    recordReembedded(db, 'fresh', embedding);
    expect(countStale(db)).toBe(0);
    db.close();
  });
});
