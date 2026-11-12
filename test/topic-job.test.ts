import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type Database from 'better-sqlite3';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { initDatabase } from '../src/db.js';
import { runTopics } from '../src/topic-job.js';
import { GpuReservedError } from '../src/ollama-backend.js';
import { promptBudgetChars } from '../src/summarizer.js';
import { SUMMARIZER_GUARD_ENV } from '../src/reentrancy.js';
import {
  ensureTopicSchema,
  getTopicMeta,
  getTopicSession,
  installTopicEdit,
  listTopicDocs,
  readTopicDoc,
  setTopicSessionStatus,
} from '../src/topic-db.js';
import { safeRmSync, suppressConsole } from './test-utils.js';

suppressConsole();

const NOW = new Date('2026-10-08T18:00:00.000Z');
const SINCE_OLD = '2026-10-01T00:00:00.000Z';
const KEYS = [
  'TEST_DB_PATH',
  'FLEET_GPU_RESERVATION',
  'EPISODIC_MEMORY_TOPICS',
  'EPISODIC_MEMORY_TOPICS_SINCE',
  'EPISODIC_MEMORY_TOPICS_MAX_SESSIONS',
  'EPISODIC_MEMORY_TOPICS_MAX_DOCS_CHARS',
  'EPISODIC_MEMORY_TOPICS_MAX_DOC_CHARS',
  'EPISODIC_MEMORY_TOPICS_MAX_DOCS',
  'EPISODIC_MEMORY_SUMMARIZER_BACKEND',
  'EPISODIC_MEMORY_OLLAMA_MAX_PROMPT_CHARS',
  SUMMARIZER_GUARD_ENV,
];
const saved: Record<string, string | undefined> = {};

/** The cache document, as a model answer writes it. The paragraph has no identifier yet. */
const FILE_CACHE = `=== FILE cache
# Cache

## Choice

Chose sqlite as the cache store.[^1]

[^1]: Time: 2026-10-08; Sources: 1
=== END`;

/** The stored form of the cache document, with the identifier that the runtime gives it. */
const STORED_CACHE =
  '# Cache\n\n## Choice\n\nChose sqlite as the cache store.[^1]\n^9f8e7d6c\n\n[^1]: Time: 2026-10-08; Sources: #e1\n';

/** The same document, edited in place: the paragraph keeps its identifier and its citation. */
const EDIT_CACHE =
  '=== FILE cache\n# Cache\n\n## Choice\n\nChose sqlite as the cache store.[^1]\n^9f8e7d6c\n\n[^1]: Time: 2026-10-08; Sources: #e1\n=== END';

/** A new document, which the prompt does not show. */
const FILE_OTHER = `=== FILE other
# Other

## Note

Chose B for the second task.[^1]

[^1]: Time: 2026-10-08; Sources: 1
=== END`;

function addExchange(
  db: Database.Database,
  id: string,
  session: string,
  ts: string,
  user = 'ALPHA question about the cache',
  agent = 'Chose sqlite because it ships with the plugin',
  project = 'proj-a'
) {
  db.prepare(
    `INSERT INTO exchanges (id, project, timestamp, user_message, assistant_message, archive_path, line_start, line_end, session_id)
     VALUES (?, ?, ?, ?, ?, '/a.jsonl', 1, 2, ?)`
  ).run(id, project, ts, user, agent, session);
}

/** A model fake that gives the replies in order. The last reply repeats. */
function replies(...texts: string[]) {
  let i = 0;
  return vi.fn(async (_prompt: string) => texts[Math.min(i++, texts.length - 1)]);
}

function tableNames(db: Database.Database): string[] {
  return (db.prepare("SELECT name FROM sqlite_master WHERE name LIKE 'topic_%'").all() as { name: string }[]).map(r => r.name);
}

/** Install the cache document with the given text, as an earlier run would have. */
function seedCache(db: Database.Database, text: string): void {
  ensureTopicSchema(db);
  installTopicEdit(db, 'proj-a', { files: [{ slug: 'cache', text }], deletes: [] }, new Map());
}

describe('runTopics', () => {
  let dir: string;
  let db: Database.Database;

  beforeEach(() => {
    for (const k of KEYS) saved[k] = process.env[k];
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'topic-job-'));
    process.env.TEST_DB_PATH = path.join(dir, 't.db');
    process.env.FLEET_GPU_RESERVATION = path.join(dir, 'gpu-reserved.json');
    process.env.EPISODIC_MEMORY_TOPICS = '1';
    process.env.EPISODIC_MEMORY_TOPICS_SINCE = SINCE_OLD;
    process.env.EPISODIC_MEMORY_SUMMARIZER_BACKEND = 'claude';
    delete process.env[SUMMARIZER_GUARD_ENV];
    delete process.env.EPISODIC_MEMORY_TOPICS_MAX_SESSIONS;
    delete process.env.EPISODIC_MEMORY_TOPICS_MAX_DOCS_CHARS;
    delete process.env.EPISODIC_MEMORY_TOPICS_MAX_DOC_CHARS;
    delete process.env.EPISODIC_MEMORY_TOPICS_MAX_DOCS;
    delete process.env.EPISODIC_MEMORY_OLLAMA_MAX_PROMPT_CHARS;
    db = initDatabase();
    addExchange(db, 'e1', 's1', '2026-10-08T09:00:00.000Z');
    addExchange(db, 'e2', 's1', '2026-10-08T09:05:00.000Z');
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

  describe('flag, guard and since', () => {
    it('writes nothing and creates no topic table with the flag off', async () => {
      delete process.env.EPISODIC_MEMORY_TOPICS;
      const model = replies(FILE_CACHE);
      const r = await runTopics(db, { model, now: NOW });
      expect(r).toMatchObject({ installed: 0, empty: 0, rejected: 0, failed: 0 });
      expect(model).not.toHaveBeenCalled();
      expect(tableNames(db)).toEqual([]);
    });

    it('is on only when the flag is exactly 1', async () => {
      process.env.EPISODIC_MEMORY_TOPICS = 'true';
      const model = replies(FILE_CACHE);
      await runTopics(db, { model, now: NOW });
      expect(model).not.toHaveBeenCalled();
    });

    it('returns zeros under the summarizer guard', async () => {
      process.env[SUMMARIZER_GUARD_ENV] = '1';
      const model = replies(FILE_CACHE);
      await runTopics(db, { model, now: NOW });
      expect(model).not.toHaveBeenCalled();
      expect(tableNames(db)).toEqual([]);
    });

    it('stores since = now on the first run when no SINCE is set', async () => {
      delete process.env.EPISODIC_MEMORY_TOPICS_SINCE;
      await runTopics(db, { model: replies(''), now: NOW });
      expect(getTopicMeta(db, 'since')).toBe(NOW.toISOString());
    });

    it('takes EPISODIC_MEMORY_TOPICS_SINCE on the first run and keeps it on later runs', async () => {
      process.env.EPISODIC_MEMORY_TOPICS_SINCE = '2026-10-08T09:02:00.000Z';
      await runTopics(db, { model: replies(''), now: NOW });
      expect(getTopicMeta(db, 'since')).toBe('2026-10-08T09:02:00.000Z');
      process.env.EPISODIC_MEMORY_TOPICS_SINCE = '2026-01-01T00:00:00.000Z';
      await runTopics(db, { model: replies(''), now: NOW });
      expect(getTopicMeta(db, 'since')).toBe('2026-10-08T09:02:00.000Z');
    });

    it('ignores an invalid SINCE with one log line and uses now', async () => {
      process.env.EPISODIC_MEMORY_TOPICS_SINCE = 'not a date';
      const log = vi.spyOn(console, 'error');
      await runTopics(db, { model: replies(''), now: NOW });
      expect(getTopicMeta(db, 'since')).toBe(NOW.toISOString());
      expect(log.mock.calls.filter(c => String(c[0]).includes('EPISODIC_MEMORY_TOPICS_SINCE is not a valid time, using now'))).toHaveLength(1);
      process.env.EPISODIC_MEMORY_TOPICS_SINCE = SINCE_OLD;
      await runTopics(db, { model: replies(''), now: NOW });
      expect(getTopicMeta(db, 'since')).toBe(NOW.toISOString());
      log.mockRestore();
    });

    it('does not organize a session that started before since', async () => {
      process.env.EPISODIC_MEMORY_TOPICS_SINCE = '2026-10-08T09:02:00.000Z';
      addExchange(db, 'e3', 's2', '2026-10-08T10:00:00.000Z', 'BRAVO question about the cache');
      addExchange(db, 'e4', 's2', '2026-10-08T10:05:00.000Z', 'BRAVO question about the cache');
      const model = replies('');
      const r = await runTopics(db, { model, now: NOW });
      expect(model).toHaveBeenCalledTimes(1);
      expect(model.mock.calls[0][0]).toContain('BRAVO');
      expect(r.empty).toBe(1);
    });
  });

  describe('gpu reservation', () => {
    it('defers with no request to the model, and stores since first', async () => {
      delete process.env.EPISODIC_MEMORY_TOPICS_SINCE;
      process.env.EPISODIC_MEMORY_SUMMARIZER_BACKEND = 'ollama';
      process.env.EPISODIC_MEMORY_OLLAMA_MAX_PROMPT_CHARS = '24000';
      fs.writeFileSync(process.env.FLEET_GPU_RESERVATION!, JSON.stringify({ holder: 'Starship' }));
      const fetchSpy = vi.fn();
      vi.stubGlobal('fetch', fetchSpy);

      const r = await runTopics(db, { now: NOW });

      expect(fetchSpy).not.toHaveBeenCalled();
      expect(r).toMatchObject({ installed: 0, failed: 0, deferred: 'fleet GPU reserved by Starship' });
      expect(getTopicMeta(db, 'since')).toBe(NOW.toISOString());
      expect(getTopicSession(db, 'proj-a', 's1')).toBeNull();
    });

    it('stops at a reservation that appears during the run, with no failure and no session row', async () => {
      const model = vi.fn(async () => {
        throw new GpuReservedError('fleet GPU reserved by Starship');
      });
      const r = await runTopics(db, { model, now: NOW });
      expect(model).toHaveBeenCalledTimes(1);
      expect(r).toMatchObject({ failed: 0, rejected: 0, deferred: 'fleet GPU reserved by Starship' });
      expect(getTopicSession(db, 'proj-a', 's1')).toBeNull();
    });
  });

  describe('session selection', () => {
    it('skips a session with a NULL session_id', async () => {
      const long = 'ALPHA question about the cache and the store. '.repeat(10);
      for (const id of ['n1', 'n2']) {
        db.prepare(
          `INSERT INTO exchanges (id, project, timestamp, user_message, assistant_message, archive_path, line_start, line_end)
           VALUES (?, 'proj-a', '2026-10-08T08:00:00.000Z', ?, ?, '/a.jsonl', 1, 2)`
        ).run(id, long, long);
      }
      db.prepare('DELETE FROM exchanges WHERE session_id = ?').run('s1');
      const model = replies('NOTHING');
      const r = await runTopics(db, { model, now: NOW });
      expect(model).not.toHaveBeenCalled();
      expect(r).toMatchObject({ empty: 0, installed: 0, failed: 0, skipped: 0 });
    });

    it('organizes the oldest session first, up to EPISODIC_MEMORY_TOPICS_MAX_SESSIONS', async () => {
      process.env.EPISODIC_MEMORY_TOPICS_MAX_SESSIONS = '1';
      addExchange(db, 'e3', 's2', '2026-10-08T10:00:00.000Z', 'BRAVO question about the cache');
      addExchange(db, 'e4', 's2', '2026-10-08T10:05:00.000Z', 'BRAVO question about the cache');
      const model = replies('');
      await runTopics(db, { model, now: NOW });
      expect(model).toHaveBeenCalledTimes(1);
      expect(model.mock.calls[0][0]).toContain('ALPHA');
      expect(model.mock.calls[0][0]).not.toContain('BRAVO');
    });

    it('skips a quiet session whose last exchange is inside the 30-minute window', async () => {
      addExchange(db, 'e5', 's3', '2026-10-08T17:50:00.000Z');
      addExchange(db, 'e6', 's3', '2026-10-08T17:55:00.000Z');
      const model = replies('');
      const r = await runTopics(db, { model, now: NOW });
      expect(model).toHaveBeenCalledTimes(1);
      expect(r.skipped).toBe(1);
      expect(getTopicSession(db, 'proj-a', 's3')).toBeNull();
    });

    it('skips a trivial one-exchange session', async () => {
      addExchange(db, 'e7', 's4', '2026-10-07T09:00:00.000Z', '/exit', 'bye');
      const model = replies('');
      const r = await runTopics(db, { model, now: NOW });
      expect(r.skipped).toBe(1);
      expect(model).toHaveBeenCalledTimes(1);
    });

    it('does not organize a session that already has a done or rejected row', async () => {
      ensureTopicSchema(db);
      setTopicSessionStatus(db, 'proj-a', 's1', 'done');
      const model = replies('');
      await runTopics(db, { model, now: NOW });
      expect(model).not.toHaveBeenCalled();
    });
  });

  describe('answers and installs', () => {
    it('installs a valid edit, stores the ids and the rewritten sources, and records done', async () => {
      const r = await runTopics(db, { model: replies(FILE_CACHE), now: NOW });
      expect(r).toMatchObject({ installed: 1, rejected: 0, failed: 0 });
      const doc = readTopicDoc(db, 'proj-a', 'cache');
      expect(doc).not.toBeNull();
      expect(doc!.text).toMatch(/\^[0-9a-f]{8}/);
      expect(doc!.text).toContain('Sources: #e1');
      expect(getTopicSession(db, 'proj-a', 's1')).toMatchObject({ status: 'done', attempts: 0 });
    });

    it('records an empty valid answer as done and writes no document', async () => {
      const r = await runTopics(db, { model: replies(''), now: NOW });
      expect(r).toMatchObject({ empty: 1, rejected: 0 });
      expect(getTopicSession(db, 'proj-a', 's1')).toMatchObject({ status: 'done' });
      expect(listTopicDocs(db, 'proj-a')).toEqual([]);
    });

    it('a parse error then a valid retry installs, and the retry carries the error', async () => {
      const broken = '=== FILE cache\n# Cache\n\nno end line';
      const model = replies(broken, FILE_CACHE);
      const r = await runTopics(db, { model, now: NOW });
      expect(r).toMatchObject({ installed: 1, rejected: 0 });
      expect(model).toHaveBeenCalledTimes(2);
      expect(model.mock.calls[1][0]).toContain('unterminated FILE block for cache');
      expect(readTopicDoc(db, 'proj-a', 'cache')).not.toBeNull();
    });

    it('a parse error twice rejects the session with the errors', async () => {
      const broken = '=== FILE cache\n# Cache\n\nno end line';
      const model = replies(broken, broken);
      const r = await runTopics(db, { model, now: NOW });
      expect(model).toHaveBeenCalledTimes(2);
      expect(r).toMatchObject({ rejected: 1, installed: 0 });
      const s = getTopicSession(db, 'proj-a', 's1');
      expect(s?.status).toBe('rejected');
      expect(s?.error).toContain('unterminated FILE block for cache');
      expect(listTopicDocs(db, 'proj-a')).toEqual([]);
    });

    it('a validation error then a valid retry installs', async () => {
      const noFootnote = '=== FILE cache\n# Cache\n\n## Choice\n\nChose sqlite as the cache store.\n=== END';
      const model = replies(noFootnote, FILE_CACHE);
      const r = await runTopics(db, { model, now: NOW });
      expect(r).toMatchObject({ installed: 1, rejected: 0 });
      expect(model.mock.calls[1][0]).toContain('check 5');
    });

    it('rejects an edit to a document that the prompt did not show in full', async () => {
      seedCache(db, STORED_CACHE);
      process.env.EPISODIC_MEMORY_TOPICS_MAX_DOCS_CHARS = '1';
      const model = replies(EDIT_CACHE);
      const r = await runTopics(db, { model, now: NOW });
      expect(r.rejected).toBe(1);
      const s = getTopicSession(db, 'proj-a', 's1');
      expect(s?.error).toContain('check 3');
      expect(readTopicDoc(db, 'proj-a', 'cache')!.text).toBe(STORED_CACHE);
    });

    it('rejects a citation of an exchange that the project does not hold', async () => {
      addExchange(db, 'other-e', 's9', '2026-10-08T09:00:00.000Z', 'ALPHA', 'ALPHA', 'proj-b');
      const cites = FILE_CACHE.replace('Sources: 1', 'Sources: #other-e');
      const r = await runTopics(db, { model: replies(cites, cites), now: NOW });
      expect(r.rejected).toBe(1);
      expect(getTopicSession(db, 'proj-a', 's1')?.error).toContain('unknown exchange id other-e');
    });

    it('stores the redacted text of the answer', async () => {
      const secret = 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGH';
      const leak = FILE_CACHE.replace('Chose sqlite as the cache store.', `Used ${secret} for the cache.`);
      await runTopics(db, { model: replies(leak), now: NOW });
      const text = readTopicDoc(db, 'proj-a', 'cache')!.text;
      expect(text).not.toContain('sk-ant-api03');
      expect(text).toContain('[redacted]');
    });

    it('rejects a document beyond EPISODIC_MEMORY_TOPICS_MAX_DOC_CHARS', async () => {
      process.env.EPISODIC_MEMORY_TOPICS_MAX_DOC_CHARS = '50';
      const r = await runTopics(db, { model: replies(FILE_CACHE, FILE_CACHE), now: NOW });
      expect(r.rejected).toBe(1);
      expect(getTopicSession(db, 'proj-a', 's1')?.error).toContain('check 10');
    });

    it('rejects a new document beyond EPISODIC_MEMORY_TOPICS_MAX_DOCS', async () => {
      process.env.EPISODIC_MEMORY_TOPICS_MAX_DOCS = '1';
      seedCache(db, STORED_CACHE);
      process.env.EPISODIC_MEMORY_TOPICS_MAX_DOCS_CHARS = '10000';
      const r = await runTopics(db, { model: replies(FILE_OTHER, FILE_OTHER), now: NOW });
      expect(r.rejected).toBe(1);
      expect(getTopicSession(db, 'proj-a', 's1')?.error).toContain('documents, the limit is 1');
      expect(listTopicDocs(db, 'proj-a').map(d => d.slug)).toEqual(['cache']);
    });

    it('a stale updated_at is retried next run with no session row', async () => {
      seedCache(db, STORED_CACHE);
      let mutated = false;
      const model = vi.fn(async (_p: string) => {
        if (!mutated) {
          mutated = true;
          db.prepare("UPDATE topic_doc SET updated_at = 'changed' WHERE project = 'proj-a' AND slug = 'cache'").run();
        }
        return EDIT_CACHE;
      });

      const first = await runTopics(db, { model, now: NOW });
      expect(first).toMatchObject({ stale: 1, installed: 0, rejected: 0 });
      expect(getTopicSession(db, 'proj-a', 's1')).toBeNull();

      const second = await runTopics(db, { model: replies(EDIT_CACHE), now: NOW });
      expect(second).toMatchObject({ installed: 1, stale: 0 });
      expect(getTopicSession(db, 'proj-a', 's1')?.status).toBe('done');
    });

    it('an edit that throws on install stays pending, the next session still runs, and a later run installs it', async () => {
      ensureTopicSchema(db);
      db.exec(
        "CREATE TRIGGER topic_poison BEFORE INSERT ON topic_unit WHEN NEW.text LIKE '%POISON%' BEGIN SELECT RAISE(ABORT, 'poison'); END;"
      );
      addExchange(db, 'e3', 's2', '2026-10-08T10:00:00.000Z', 'BRAVO question about the cache');
      addExchange(db, 'e4', 's2', '2026-10-08T10:05:00.000Z', 'BRAVO question about the cache');
      const poison = FILE_CACHE.replace('Chose sqlite', 'POISON chose sqlite');
      const r = await runTopics(db, { model: replies(poison, FILE_OTHER), now: NOW });
      expect(r).toMatchObject({ rejected: 0, failed: 1, installed: 1 });
      expect(getTopicSession(db, 'proj-a', 's1')).toMatchObject({ status: 'pending', attempts: 1 });
      expect(getTopicSession(db, 'proj-a', 's2')?.status).toBe('done');
      db.exec('DROP TRIGGER topic_poison');
      const again = await runTopics(db, { model: replies(EDIT_CACHE.replace('^9f8e7d6c\n', '')), now: NOW });
      expect(again).toMatchObject({ installed: 1, failed: 0 });
      expect(getTopicSession(db, 'proj-a', 's1')?.status).toBe('done');
    });
  });

  describe('model failures', () => {
    it('counts a failed call, retries it next run, and rejects it on the third failure', async () => {
      const failing = vi.fn(async (_p: string) => {
        throw new Error('connection refused');
      });

      const r1 = await runTopics(db, { model: failing, now: NOW });
      expect(r1).toMatchObject({ failed: 1, rejected: 0 });
      expect(getTopicSession(db, 'proj-a', 's1')).toMatchObject({ status: 'pending', attempts: 1 });

      const r2 = await runTopics(db, { model: failing, now: NOW });
      expect(r2).toMatchObject({ failed: 1, rejected: 0 });
      expect(getTopicSession(db, 'proj-a', 's1')).toMatchObject({ status: 'pending', attempts: 2 });

      const r3 = await runTopics(db, { model: failing, now: NOW });
      expect(r3).toMatchObject({ failed: 1, rejected: 1 });
      expect(getTopicSession(db, 'proj-a', 's1')).toMatchObject({ status: 'rejected', attempts: 3 });

      const later = vi.fn(async (_p: string) => FILE_CACHE);
      await runTopics(db, { model: later, now: NOW });
      expect(later).not.toHaveBeenCalled();
    });

    it('a failed retry call counts as a failed call and keeps the session pending', async () => {
      const broken = '=== FILE cache\n# Cache\n\nno end line';
      let n = 0;
      const model = vi.fn(async (_p: string) => {
        n++;
        if (n === 1) return broken;
        throw new Error('timeout');
      });
      const r = await runTopics(db, { model, now: NOW });
      expect(r).toMatchObject({ failed: 1, rejected: 0 });
      expect(getTopicSession(db, 'proj-a', 's1')).toMatchObject({ status: 'pending', attempts: 1 });
    });
  });

  describe('prompt budget', () => {
    it('skips a session that no budget room can hold, writes no row, and still runs the next session', async () => {
      process.env.EPISODIC_MEMORY_SUMMARIZER_BACKEND = 'ollama';
      process.env.EPISODIC_MEMORY_OLLAMA_MAX_PROMPT_CHARS = String(1000 + 2600);
      addExchange(db, 'e3', 's2', '2026-10-08T10:00:00.000Z');
      addExchange(db, 'e4', 's2', '2026-10-08T10:05:00.000Z');
      db.prepare("UPDATE exchanges SET assistant_message = ? WHERE session_id = 's1'").run('x'.repeat(1400));
      db.prepare("UPDATE exchanges SET user_message = ? WHERE session_id = 's1'").run('y'.repeat(1400));
      process.env.EPISODIC_MEMORY_TOPICS_MAX_SESSIONS = '1';
      const model = replies('NOTHING');
      const r = await runTopics(db, { model, now: NOW });
      expect(getTopicSession(db, 'proj-a', 's1')).toBeNull();
      expect(r).toMatchObject({ rejected: 0, empty: 1 });
      expect(model).toHaveBeenCalledTimes(1);
      expect(getTopicSession(db, 'proj-a', 's2')?.status).toBe('done');
    });

    it('fills the first prompt up to the retry reserve, and the retry still fits', async () => {
      process.env.EPISODIC_MEMORY_SUMMARIZER_BACKEND = 'ollama';
      process.env.EPISODIC_MEMORY_OLLAMA_MAX_PROMPT_CHARS = '8000';
      for (let i = 10; i < 200; i++) {
        addExchange(db, `f${i}`, 's1', `2026-10-08T09:${String(10 + (i % 40)).padStart(2, '0')}:00.000Z`, `q${i} about the cache`, `a${i}`);
      }
      process.env.EPISODIC_MEMORY_TOPICS_MAX_TRANSCRIPT_CHARS = '100000';
      const model = replies('=== FILE cache\n# Cache\n\nno end line', 'NOTHING');
      await runTopics(db, { model, now: NOW });
      expect(model).toHaveBeenCalledTimes(2);
      expect(model.mock.calls[0][0].length).toBeGreaterThan(8000 - 1000 - 120);
      for (const call of model.mock.calls) expect(call[0].length).toBeLessThanOrEqual(8000);
      delete process.env.EPISODIC_MEMORY_TOPICS_MAX_TRANSCRIPT_CHARS;
    });

    it('cuts a long error line so the retry fits the budget', async () => {
      process.env.EPISODIC_MEMORY_SUMMARIZER_BACKEND = 'ollama';
      process.env.EPISODIC_MEMORY_OLLAMA_MAX_PROMPT_CHARS = '8000';
      const model = replies(`=== FILE ${'s'.repeat(7000)}\n# S\n\nP.[^1]\n\n[^1]: Time: 2026; Sources: 1\n=== END`, 'NOTHING');
      await runTopics(db, { model, now: NOW });
      expect(model).toHaveBeenCalledTimes(2);
      expect(model.mock.calls[1][0].length).toBeLessThanOrEqual(8000);
    });

    it('never sends a prompt over promptBudgetChars(), including the retry', async () => {
      process.env.EPISODIC_MEMORY_SUMMARIZER_BACKEND = 'ollama';
      process.env.EPISODIC_MEMORY_OLLAMA_MAX_PROMPT_CHARS = '8000';
      const budget = promptBudgetChars();
      expect(budget).toBe(8000);
      seedCache(db, `# Cache\n\n## Choice\n\n${'Long fact about the cache. '.repeat(40)}[^1]\n^9f8e7d6c\n\n[^1]: Time: 2026-10-08; Sources: #e1\n`);
      for (let i = 3; i <= 6; i++) {
        addExchange(db, `x${i}`, 's1', `2026-10-08T09:0${i}:00.000Z`, 'ALPHA '.repeat(20), 'Agent '.repeat(60));
      }
      const broken = '=== FILE cache\n# Cache\n\nno end line';
      const model = replies(broken, '');
      const r = await runTopics(db, { model, now: NOW });
      expect(model).toHaveBeenCalledTimes(2);
      for (const call of model.mock.calls) expect(call[0].length).toBeLessThanOrEqual(budget);
      expect(model.mock.calls[1][0]).toContain('unterminated FILE block for cache');
      expect(r.empty).toBe(1);
    });
  });
});

describe('runTopics through callOllama', () => {
  const OKEYS = ['TEST_DB_PATH', 'FLEET_GPU_RESERVATION', 'EPISODIC_MEMORY_TOPICS', 'EPISODIC_MEMORY_TOPICS_SINCE',
    'EPISODIC_MEMORY_SUMMARIZER_BACKEND', 'EPISODIC_MEMORY_OLLAMA_MODEL', 'EPISODIC_MEMORY_OLLAMA_URL'];
  const kept: Record<string, string | undefined> = {};
  let dir: string;
  let db: Database.Database;

  beforeEach(() => {
    for (const k of OKEYS) kept[k] = process.env[k];
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'topic-ollama-'));
    process.env.TEST_DB_PATH = path.join(dir, 't.db');
    process.env.FLEET_GPU_RESERVATION = path.join(dir, 'gpu-reserved.json');
    process.env.EPISODIC_MEMORY_TOPICS = '1';
    process.env.EPISODIC_MEMORY_TOPICS_SINCE = SINCE_OLD;
    process.env.EPISODIC_MEMORY_SUMMARIZER_BACKEND = 'ollama';
    process.env.EPISODIC_MEMORY_OLLAMA_MODEL = 'fake-model';
    process.env.EPISODIC_MEMORY_OLLAMA_URL = 'http://127.0.0.1:11434';
    db = initDatabase();
    addExchange(db, 'e1', 's1', '2026-10-08T09:00:00.000Z');
    addExchange(db, 'e2', 's1', '2026-10-08T09:05:00.000Z');
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    db.close();
    for (const k of OKEYS) {
      if (kept[k] === undefined) delete process.env[k];
      else process.env[k] = kept[k];
    }
    safeRmSync(dir);
  });

  const reply = (response: string) =>
    vi.fn(async () => new Response(JSON.stringify({ response }), { status: 200, headers: { 'content-type': 'application/json' } }));

  it('records a NOTHING reply as done', async () => {
    vi.stubGlobal('fetch', reply('NOTHING'));
    const r = await runTopics(db, { now: NOW });
    expect(r).toMatchObject({ empty: 1, failed: 0 });
    expect(getTopicSession(db, 'proj-a', 's1')?.status).toBe('done');
  });

  it('counts an empty Ollama reply as a failed call', async () => {
    vi.stubGlobal('fetch', reply(''));
    const r = await runTopics(db, { now: NOW });
    expect(r).toMatchObject({ empty: 0, failed: 1 });
    expect(getTopicSession(db, 'proj-a', 's1')).toMatchObject({ status: 'pending', attempts: 1 });
  });
});
