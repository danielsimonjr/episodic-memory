import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type Database from 'better-sqlite3';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { initDatabase } from '../src/db.js';
import { runDigest } from '../src/digest-job.js';
import { listActiveEntries } from '../src/digest-db.js';
import { SUMMARIZER_GUARD_ENV } from '../src/reentrancy.js';
import { safeRmSync, suppressConsole } from './test-utils.js';

suppressConsole();

const NOW = new Date('2026-10-08T18:00:00.000Z');

function addExchange(
  db: Database.Database,
  id: string,
  session: string,
  ts: string,
  user = 'Please pick a cache store and explain why',
  agent = 'Chose sqlite because it ships with the plugin'
) {
  db.prepare(
    `INSERT INTO exchanges (id, project, timestamp, user_message, assistant_message, archive_path, line_start, line_end, session_id)
     VALUES (?, 'proj-a', ?, ?, ?, '/a.jsonl', 1, 2, ?)`
  ).run(id, ts, user, agent, session);
}

describe('runDigest', () => {
  const dir = path.join(os.tmpdir(), 'digest-job-' + Date.now());
  let db: Database.Database;
  const fake = async () => 'Chose sqlite as the cache store [1]';

  beforeEach(() => {
    fs.mkdirSync(dir, { recursive: true });
    process.env.TEST_DB_PATH = path.join(dir, 't.db');
    process.env.EPISODIC_MEMORY_DIGEST = '1';
    delete process.env[SUMMARIZER_GUARD_ENV];
    db = initDatabase();
    addExchange(db, 'e1', 's1', '2026-10-08T09:00:00.000Z');
    addExchange(db, 'e2', 's1', '2026-10-08T09:05:00.000Z');
  });
  afterEach(() => {
    db.close();
    delete process.env.TEST_DB_PATH;
    delete process.env.EPISODIC_MEMORY_DIGEST;
    delete process.env[SUMMARIZER_GUARD_ENV];
    safeRmSync(dir);
  });

  it('returns zeros and writes nothing with the flag off', async () => {
    delete process.env.EPISODIC_MEMORY_DIGEST;
    const r = await runDigest(db, { model: fake, now: NOW });
    expect(r).toEqual({ written: 0, skipped: 0, failed: 0 });
    expect(listActiveEntries(db, 'proj-a')).toHaveLength(0);
  });

  it('returns zeros when the summarizer guard is set', async () => {
    process.env[SUMMARIZER_GUARD_ENV] = '1';
    const r = await runDigest(db, { model: fake, now: NOW });
    expect(r).toEqual({ written: 0, skipped: 0, failed: 0 });
  });

  it('writes one session entry with cited sources', async () => {
    const r = await runDigest(db, { model: fake, now: NOW });
    expect(r.written).toBe(1);
    const [e] = listActiveEntries(db, 'proj-a');
    expect(e.tier).toBe('session');
    expect(e.sources).toEqual(['e1']);
    expect(e.text).toBe('Chose sqlite as the cache store [#e1]');
    expect(e.periodStart).toBe('2026-10-08T09:00:00.000Z');
    expect(e.periodEnd).toBe('2026-10-08T09:05:00.000Z');
  });

  it('writes no duplicate on a second run', async () => {
    await runDigest(db, { model: fake, now: NOW });
    const r2 = await runDigest(db, { model: fake, now: NOW });
    expect(r2.written).toBe(0);
    expect(listActiveEntries(db, 'proj-a')).toHaveLength(1);
  });

  it('writes nothing when every line is invalid', async () => {
    const r = await runDigest(db, { model: async () => 'A claim with no citation\nAnother [42]', now: NOW });
    expect(r.written).toBe(0);
    expect(r.failed).toBe(0);
    expect(listActiveEntries(db, 'proj-a')).toHaveLength(0);
  });

  it('counts a model failure, does not throw, and retries next run', async () => {
    const r = await runDigest(db, {
      model: async () => {
        throw new Error('boom');
      },
      now: NOW,
    });
    expect(r.failed).toBe(1);
    expect(r.written).toBe(0);
    const r2 = await runDigest(db, { model: fake, now: NOW });
    expect(r2.written).toBe(1);
  });

  it('skips a session that is still active (last exchange inside the quiet window)', async () => {
    addExchange(db, 'e3', 's2', '2026-10-08T17:50:00.000Z');
    const r = await runDigest(db, { model: fake, now: NOW });
    expect(r.written).toBe(1);
    expect(r.skipped).toBe(1);
  });

  it('skips a trivial one-line session', async () => {
    addExchange(db, 'e9', 's3', '2026-10-07T09:00:00.000Z', '/exit', 'bye');
    const r = await runDigest(db, { model: fake, now: NOW });
    expect(r.written).toBe(1);
    expect(r.skipped).toBe(1);
  });

  it('redacts a planted secret out of the stored text', async () => {
    const leak = async () => 'Used key sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGH for the call [1]';
    await runDigest(db, { model: leak, now: NOW });
    const [e] = listActiveEntries(db, 'proj-a');
    expect(e.text).not.toContain('sk-ant-api03');
    expect(e.text).toContain('[redacted]');
  });

  it('ignores rows with no session id', async () => {
    db.prepare(
      `INSERT INTO exchanges (id, project, timestamp, user_message, assistant_message, archive_path, line_start, line_end)
       VALUES ('n1', 'proj-a', '2026-10-08T08:00:00.000Z', 'a long enough user message here', 'a long enough agent reply here', '/a.jsonl', 1, 2)`
    ).run();
    const r = await runDigest(db, { model: fake, now: NOW });
    expect(r.written).toBe(1);
  });
});
