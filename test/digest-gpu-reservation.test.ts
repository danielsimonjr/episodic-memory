import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type Database from 'better-sqlite3';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { initDatabase } from '../src/db.js';
import { runDigest } from '../src/digest-job.js';
import { compressDigest } from '../src/digest-compress.js';
import { ensureDigestSchema, insertDigestEntry } from '../src/digest-db.js';
import { GpuReservedError } from '../src/ollama-backend.js';
import BetterSqlite3 from 'better-sqlite3';
import { SUMMARIZER_GUARD_ENV } from '../src/reentrancy.js';
import { safeRmSync, suppressConsole } from './test-utils.js';

suppressConsole();

const NOW = new Date('2026-10-08T18:00:00.000Z');
const KEYS = [
  'FLEET_GPU_RESERVATION',
  'EPISODIC_MEMORY_SUMMARIZER_BACKEND',
  'EPISODIC_MEMORY_DIGEST',
  'EPISODIC_MEMORY_OLLAMA_URL',
  'EPISODIC_MEMORY_OLLAMA_MODEL',
  'EPISODIC_MEMORY_DIGEST_DAY_CAP',
  'TEST_DB_PATH',
];
const saved: Record<string, string | undefined> = {};
for (const k of KEYS) saved[k] = process.env[k];

describe('runDigest under a GPU reservation', () => {
  const dir = path.join(os.tmpdir(), 'digest-gpu-' + Date.now());
  let db: Database.Database;

  beforeEach(() => {
    fs.mkdirSync(dir, { recursive: true });
    process.env.TEST_DB_PATH = path.join(dir, 't.db');
    process.env.EPISODIC_MEMORY_DIGEST = '1';
    process.env.EPISODIC_MEMORY_SUMMARIZER_BACKEND = 'ollama';
    process.env.EPISODIC_MEMORY_OLLAMA_URL = 'http://127.0.0.1:9'; // closed port; the tests stub fetch
    process.env.EPISODIC_MEMORY_OLLAMA_MODEL = 'qwen3.8:27b';
    process.env.FLEET_GPU_RESERVATION = path.join(dir, 'gpu-reserved.json');
    delete process.env[SUMMARIZER_GUARD_ENV];
    db = initDatabase();
    for (const [id, ts] of [['e1', '2026-10-08T09:00:00.000Z'], ['e2', '2026-10-08T09:05:00.000Z']]) {
      db.prepare(
        `INSERT INTO exchanges (id, project, timestamp, user_message, assistant_message, archive_path, line_start, line_end, session_id)
         VALUES (?, 'proj-a', ?, 'Please pick a cache store and explain why', 'Chose sqlite because it ships with the plugin', '/a.jsonl', 1, 2, 's1')`,
      ).run(id, ts);
    }
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    db.close();
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    safeRmSync(dir);
  });

  it('sends no request to the model while the GPU is reserved', async () => {
    fs.writeFileSync(process.env.FLEET_GPU_RESERVATION!, JSON.stringify({ holder: 'Starship' }));
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    const result = await runDigest(db, { now: NOW });

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(result).toMatchObject({ written: 0, failed: 0, deferred: 'fleet GPU reserved by Starship' });
  });

  it('reports the wait before it reads any session', async () => {
    db.prepare('DELETE FROM exchanges').run();
    fs.writeFileSync(process.env.FLEET_GPU_RESERVATION!, JSON.stringify({ holder: 'Starship' }));

    const result = await runDigest(db, { now: NOW });

    expect(result).toMatchObject({ written: 0, failed: 0, deferred: 'fleet GPU reserved by Starship' });
  });

  it('stops at the first deferral when the reservation appears during the run, and counts no failure', async () => {
    for (const [id, ts] of [['e3', '2026-10-08T10:00:00.000Z'], ['e4', '2026-10-08T10:05:00.000Z']]) {
      db.prepare(
        `INSERT INTO exchanges (id, project, timestamp, user_message, assistant_message, archive_path, line_start, line_end, session_id)
         VALUES (?, 'proj-a', ?, 'Please pick a cache store and explain why', 'Chose sqlite because it ships with the plugin', '/b.jsonl', 1, 2, 's2')`,
      ).run(id, ts);
    }
    const model = vi.fn(async () => {
      throw new GpuReservedError('fleet GPU reserved by Starship');
    });

    const result = await runDigest(db, { now: NOW, model });

    expect(model).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ written: 0, failed: 0, deferred: 'fleet GPU reserved by Starship' });
    expect(result.compressed).toBeUndefined();
  });

  it('still counts a real model failure', async () => {
    const model = vi.fn(async () => {
      throw new Error('connection refused');
    });

    const result = await runDigest(db, { now: NOW, model });

    expect(result.failed).toBe(1);
    expect(result.deferred).toBeUndefined();
  });

  it('reports a deferral that comes from the compression step', async () => {
    // Three session entries of one past day, over a cap of two, give the compression step work to do.
    process.env.EPISODIC_MEMORY_DIGEST_DAY_CAP = '2';
    ensureDigestSchema(db);
    for (const n of [1, 2, 3]) {
      insertDigestEntry(db, {
        tier: 'session',
        project: 'proj-b',
        periodStart: `2026-10-05T0${n}:00:00.000Z`,
        periodEnd: `2026-10-05T0${n}:30:00.000Z`,
        text: `Fact ${n} [#e${n}]`,
        sources: [`e${n}`],
        model: 'haiku',
        handoff: false,
      });
    }
    // Call 1 is the session of proj-a: it returns no cited line. Call 2 is the compression.
    let calls = 0;
    const model = vi.fn(async () => {
      calls++;
      if (calls === 1) return '';
      throw new GpuReservedError('fleet GPU reserved by Starship');
    });

    const result = await runDigest(db, { now: NOW, model });

    expect(model).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({ written: 0, failed: 0, compressed: 0, deferred: 'fleet GPU reserved by Starship' });
  });

  it('reaches the model when the GPU is free', async () => {
    const fetchSpy = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ response: 'no tags here' }) }) as any);
    vi.stubGlobal('fetch', fetchSpy);

    await runDigest(db, { now: NOW });

    expect(fetchSpy).toHaveBeenCalled();
  });
});

describe('compressDigest under a GPU reservation', () => {
  let cdb: BetterSqlite3.Database;
  const NOW_C = new Date('2026-10-20T12:00:00.000Z');

  function addSession(n: number, day: string) {
    const hh = String(n).padStart(2, '0');
    insertDigestEntry(cdb, {
      tier: 'session',
      project: 'proj-a',
      periodStart: `${day}T${hh}:00:00.000Z`,
      periodEnd: `${day}T${hh}:30:00.000Z`,
      text: `Fact ${n} [#e${n}]`,
      sources: [`e${n}`],
      model: 'haiku',
      handoff: false,
    });
  }

  beforeEach(() => {
    cdb = new BetterSqlite3(':memory:');
    ensureDigestSchema(cdb);
    // Two past days, each over the cap, so a run that goes on after a deferral would call the model twice.
    [1, 2, 3].forEach(n => addSession(n, '2026-10-05'));
    [1, 2, 3].forEach(n => addSession(n, '2026-10-06'));
  });
  afterEach(() => cdb.close());

  it('stops at the first deferral and counts no failure', async () => {
    const model = vi.fn(async () => {
      throw new GpuReservedError('fleet GPU reserved by Starship');
    });

    const result = await compressDigest(cdb, { model, now: NOW_C, dayCap: 2 });

    expect(model).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ created: 0, failed: 0, deferred: 'fleet GPU reserved by Starship' });
  });

  it('stops at the first deferral in the week step too', async () => {
    // Three day entries in each of two finished weeks, over a week cap of two. The day step has no work.
    for (const day of ['2026-09-28', '2026-09-29', '2026-09-30', '2026-10-05', '2026-10-06', '2026-10-07']) {
      insertDigestEntry(cdb, {
        tier: 'day',
        project: 'proj-a',
        periodStart: `${day}T00:00:00.000Z`,
        periodEnd: `${day}T23:59:59.000Z`,
        text: `Day ${day} [#d${day}]`,
        sources: [`d${day}`],
        model: 'haiku',
        handoff: false,
      });
    }
    const model = vi.fn(async () => {
      throw new GpuReservedError('fleet GPU reserved by Starship');
    });

    const result = await compressDigest(cdb, { model, now: NOW_C, dayCap: 99, weekCap: 2 });

    expect(model).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ created: 0, failed: 0, deferred: 'fleet GPU reserved by Starship' });
  });

  it('still counts a real model failure and goes on to the next group', async () => {
    const model = vi.fn(async () => {
      throw new Error('connection refused');
    });

    const result = await compressDigest(cdb, { model, now: NOW_C, dayCap: 2 });

    expect(model).toHaveBeenCalledTimes(2);
    expect(result.failed).toBe(2);
    expect(result.deferred).toBeUndefined();
  });
});
