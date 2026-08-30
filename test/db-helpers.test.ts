import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  initDatabase,
  insertExchange,
  getAllExchanges,
  getFileLastIndexed,
  getMaxIndexedLine,
  deleteExchange,
  getFreelistInfo,
  vacuumDatabase,
  getSharedReaderDatabase,
  closeSharedReaderDatabase,
  upsertExchangeFts,
  deleteExchangeFts,
  ensureFts,
} from '../src/db.js';
import type { ConversationExchange } from '../src/types.js';
import { safeRmSync } from './test-utils.js';
import fs from 'fs';
import path from 'path';
import os from 'os';

function sample(id: string, archivePath: string, lineEnd = 4): ConversationExchange {
  return {
    id,
    project: 'p',
    timestamp: '2026-01-01T00:00:00.000Z',
    userMessage: 'hello world searchable',
    assistantMessage: 'hi there',
    archivePath,
    lineStart: 1,
    lineEnd,
    toolCalls: [
      {
        id: `${id}-tool`,
        exchangeId: id,
        toolName: 'Read',
        toolInput: { path: '/tmp/x' },
        toolResult: 'ok',
        isError: false,
        timestamp: '2026-01-01T00:00:00.000Z',
      },
    ],
  };
}

describe('db helpers', () => {
  let testDir: string;
  let dbPath: string;

  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'em-db-helpers-'));
    dbPath = path.join(testDir, 'db.sqlite');
    process.env.TEST_DB_PATH = dbPath;
    closeSharedReaderDatabase();
  });

  afterEach(() => {
    closeSharedReaderDatabase();
    delete process.env.TEST_DB_PATH;
    safeRmSync(testDir);
  });

  it('inserts, lists, tracks high-water marks, and deletes', () => {
    const db = initDatabase();
    const archive = path.join(testDir, 'a.jsonl');
    const embedding = new Array(384).fill(0.01);
    insertExchange(db, sample('id-1', archive, 8), embedding);

    expect(getAllExchanges(db)).toEqual([{ id: 'id-1', archivePath: archive }]);
    expect(getMaxIndexedLine(db, archive)).toBe(8);
    expect(getFileLastIndexed(db, archive)).toBeGreaterThan(0);
    expect(getMaxIndexedLine(db, '/nope.jsonl')).toBe(0);
    expect(getFileLastIndexed(db, '/nope.jsonl')).toBeNull();

    const info = getFreelistInfo(db);
    expect(info.pageSize).toBeGreaterThan(0);
    expect(info.freePages).toBeGreaterThanOrEqual(0);

    deleteExchange(db, 'id-1');
    expect(getAllExchanges(db)).toEqual([]);
    vacuumDatabase(db);
    expect(fs.existsSync(dbPath)).toBe(true);
    db.close();
  });

  it('reuses a shared reader and closes it', () => {
    const first = getSharedReaderDatabase();
    const second = getSharedReaderDatabase();
    expect(first).toBe(second);
    closeSharedReaderDatabase();
    closeSharedReaderDatabase(); // second close is a no-op
  });

  it('FTS upsert/delete helpers do not throw on a migrated db', () => {
    const db = initDatabase();
    expect(() => ensureFts(db)).not.toThrow();
    expect(() => upsertExchangeFts(db, 'missing', 'u', 'a')).not.toThrow();
    expect(() => deleteExchangeFts(db, 'missing')).not.toThrow();
    db.close();
  });
});
