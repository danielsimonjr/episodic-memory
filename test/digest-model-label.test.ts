import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { Database } from '../src/sqlite.js';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { initDatabase } from '../src/db.js';
import { runDigest } from '../src/digest-job.js';
import { listActiveEntries } from '../src/digest-db.js';
import { safeRmSync, suppressConsole } from './test-utils.js';

suppressConsole();

// The digest entry records the model that wrote it. The label must name the model of the configured backend.
const NOW = new Date('2026-10-08T18:00:00.000Z');
const KEYS = ['EPISODIC_MEMORY_SUMMARIZER_BACKEND', 'EPISODIC_MEMORY_OLLAMA_MODEL', 'EPISODIC_MEMORY_OLLAMA_FALLBACK_MODEL', 'EPISODIC_MEMORY_API_MODEL'];
const saved: Record<string, string | undefined> = {};
for (const k of KEYS) saved[k] = process.env[k];

describe('digest entry model label', () => {
  const dir = path.join(os.tmpdir(), 'digest-model-label-' + Date.now());
  let db: Database;
  const fake = async () => 'Chose sqlite as the cache store [1]';

  beforeEach(() => {
    fs.mkdirSync(dir, { recursive: true });
    process.env.TEST_DB_PATH = path.join(dir, 't.db');
    process.env.EPISODIC_MEMORY_DIGEST = '1';
    delete process.env.EPISODIC_MEMORY_API_MODEL;
    db = initDatabase();
    db.prepare(
      `INSERT INTO exchanges (id, project, timestamp, user_message, assistant_message, archive_path, line_start, line_end, session_id)
       VALUES ('e1', 'proj-a', '2026-10-08T09:00:00.000Z', 'Please pick a cache store and explain why',
               'Chose sqlite because it ships with the plugin', '/a.jsonl', 1, 2, 's1'),
              ('e2', 'proj-a', '2026-10-08T09:05:00.000Z', 'Then check the index size',
               'The index holds 12 rows', '/a.jsonl', 3, 4, 's1')`
    ).run();
  });

  afterEach(() => {
    db.close();
    delete process.env.TEST_DB_PATH;
    delete process.env.EPISODIC_MEMORY_DIGEST;
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    safeRmSync(dir);
  });

  it('names the Ollama model on the ollama backend, not the Claude default', async () => {
    process.env.EPISODIC_MEMORY_SUMMARIZER_BACKEND = 'ollama';
    process.env.EPISODIC_MEMORY_OLLAMA_MODEL = 'qwen-unit-model';
    const r = await runDigest(db, { model: fake, now: NOW });
    expect(r.written).toBe(1);
    expect(listActiveEntries(db, 'proj-a')[0].model).toBe('qwen-unit-model');
  });

  it('keeps the Claude model label on the claude backend', async () => {
    process.env.EPISODIC_MEMORY_SUMMARIZER_BACKEND = 'claude';
    process.env.EPISODIC_MEMORY_API_MODEL = 'sonnet';
    const r = await runDigest(db, { model: fake, now: NOW });
    expect(r.written).toBe(1);
    expect(listActiveEntries(db, 'proj-a')[0].model).toBe('sonnet');
  });
});

describe('digestModelLabel with no Ollama model set', () => {
  it('is never empty: it names the fallback model that wrote the digest', async () => {
    const { digestModelLabel } = await import('../src/summarizer.js');
    const before = { ...process.env };
    try {
      process.env.EPISODIC_MEMORY_SUMMARIZER_BACKEND = 'ollama';
      delete process.env.EPISODIC_MEMORY_OLLAMA_MODEL;
      process.env.EPISODIC_MEMORY_OLLAMA_FALLBACK_MODEL = 'haiku';
      expect(digestModelLabel()).toBe('haiku');
      delete process.env.EPISODIC_MEMORY_OLLAMA_FALLBACK_MODEL;
      expect(digestModelLabel()).not.toBe('');
    } finally {
      for (const k of KEYS) {
        if (before[k] === undefined) delete process.env[k];
        else process.env[k] = before[k];
      }
    }
  });
});
