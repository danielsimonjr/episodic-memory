import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { initDatabase } from '../src/db.js';
import { runTopicPhase } from '../src/topic-phase.js';
import { SUMMARIZER_GUARD_ENV } from '../src/reentrancy.js';
import { safeRmSync, suppressConsole } from './test-utils.js';

suppressConsole();

const KEYS = ['TEST_DB_PATH', 'EPISODIC_MEMORY_TOPICS', 'EPISODIC_MEMORY_TOPICS_SINCE', 'FLEET_GPU_RESERVATION', SUMMARIZER_GUARD_ENV];
const saved: Record<string, string | undefined> = {};

function topicTables(db: Database.Database): string[] {
  return (db.prepare("SELECT name FROM sqlite_master WHERE name LIKE 'topic_%'").all() as { name: string }[]).map(r => r.name);
}

describe('runTopicPhase', () => {
  let dir: string;

  beforeEach(() => {
    for (const k of KEYS) saved[k] = process.env[k];
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'topic-phase-'));
    process.env.TEST_DB_PATH = path.join(dir, 't.db');
    process.env.FLEET_GPU_RESERVATION = path.join(dir, 'gpu-reserved.json');
    process.env.EPISODIC_MEMORY_TOPICS_SINCE = '2026-10-01T00:00:00.000Z';
    delete process.env[SUMMARIZER_GUARD_ENV];
    delete process.env.EPISODIC_MEMORY_TOPICS;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    safeRmSync(dir);
  });

  it('returns null and creates no topic table with the flag off', async () => {
    const db = initDatabase();
    try {
      const model = vi.fn(async () => '');
      expect(await runTopicPhase({ db, model })).toBeNull();
      expect(model).not.toHaveBeenCalled();
      expect(topicTables(db)).toEqual([]);
    } finally {
      db.close();
    }
  });

  it('returns null under the summarizer guard', async () => {
    process.env.EPISODIC_MEMORY_TOPICS = '1';
    process.env[SUMMARIZER_GUARD_ENV] = '1';
    const db = initDatabase();
    try {
      expect(await runTopicPhase({ db, model: async () => '' })).toBeNull();
      expect(topicTables(db)).toEqual([]);
    } finally {
      db.close();
    }
  });

  it('runs the job with the flag on and writes one summary line to stderr only', async () => {
    process.env.EPISODIC_MEMORY_TOPICS = '1';
    const db = initDatabase();
    const err = vi.spyOn(console, 'error');
    const log = vi.spyOn(console, 'log');
    try {
      const r = await runTopicPhase({ db, model: async () => '' });
      expect(r).toMatchObject({ empty: 0, rejected: 0, failed: 0 });
      expect(log).not.toHaveBeenCalled();
      const lines = err.mock.calls.map(c => String(c[0]));
      expect(lines.some(l => l.startsWith('episodic-memory: topics:'))).toBe(true);
    } finally {
      db.close();
    }
  });

  it('opens and closes its own database when none is passed', async () => {
    process.env.EPISODIC_MEMORY_TOPICS = '1';
    const r = await runTopicPhase({ model: async () => '' });
    expect(r).not.toBeNull();
    const check = new Database(path.join(dir, 't.db'), { readonly: true });
    try {
      expect(topicTables(check)).toContain('topic_session');
    } finally {
      check.close();
    }
  });

  it('never throws: a closed database gives null and a stderr line', async () => {
    process.env.EPISODIC_MEMORY_TOPICS = '1';
    const db = initDatabase();
    db.close();
    const err = vi.spyOn(console, 'error');
    await expect(runTopicPhase({ db, model: async () => '' })).resolves.toBeNull();
    expect(err.mock.calls.some(c => String(c[0]).includes('topic phase error'))).toBe(true);
  });
});
