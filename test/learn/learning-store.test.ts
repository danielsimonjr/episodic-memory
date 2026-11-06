import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  getLearnedDir,
  getLearningDbPath,
  getKnowledgeDbPath,
  getIndexDir,
} from '../../src/paths.js';
import {
  openLearningDb,
  migrateLearningSchema,
  LEARNING_TABLES,
} from '../../src/learn/learning-store.js';
import { openKnowledgeStore } from '../../src/learn/knowledge-store.js';
import { safeRmSync, suppressConsole } from '../test-utils.js';

suppressConsole();

function makeTempDir(prefix: string): string {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

function tables(db: Database.Database): string[] {
  return (
    db.prepare("SELECT name FROM sqlite_master WHERE type IN ('table','view')").all() as Array<{
      name: string;
    }>
  ).map(r => r.name);
}

describe('learning store', () => {
  let configDir: string;
  let db: Database.Database | null = null;
  const saved = {
    config: process.env.EPISODIC_MEMORY_CONFIG_DIR,
    testDbPath: process.env.TEST_DB_PATH,
  };

  beforeEach(() => {
    configDir = makeTempDir('em-learn-trace-');
    process.env.EPISODIC_MEMORY_CONFIG_DIR = configDir;
    // Learning paths honour EPISODIC_MEMORY_CONFIG_DIR only, never TEST_DB_PATH.
    delete process.env.TEST_DB_PATH;
  });

  afterEach(() => {
    try {
      db?.close();
    } finally {
      db = null;
      if (saved.config === undefined) delete process.env.EPISODIC_MEMORY_CONFIG_DIR;
      else process.env.EPISODIC_MEMORY_CONFIG_DIR = saved.config;
      if (saved.testDbPath === undefined) delete process.env.TEST_DB_PATH;
      else process.env.TEST_DB_PATH = saved.testDbPath;
      safeRmSync(configDir);
    }
  });

  it('openLearningDb creates learned/learning.sqlite and the learning tables idempotently', () => {
    db = openLearningDb();
    const names = tables(db);
    for (const table of LEARNING_TABLES) expect(names).toContain(table);
    expect(names).toContain('knowledge_snapshot');
    expect(names).toContain('learned_block');
    expect(fs.existsSync(getLearningDbPath())).toBe(true);
    expect(path.normalize(getLearningDbPath())).toBe(
      path.normalize(path.join(getLearnedDir(), 'learning.sqlite'))
    );

    // A second call over the same file does not throw.
    db.close();
    db = openLearningDb();
    expect(tables(db)).toContain('learned_block');
  });

  it('migrateLearningSchema is idempotent on an in-memory database', () => {
    const mem = new Database(':memory:');
    try {
      migrateLearningSchema(mem);
      migrateLearningSchema(mem);
      const names = tables(mem);
      for (const table of LEARNING_TABLES) expect(names).toContain(table);
    } finally {
      mem.close();
    }
  });

  it('openLearningDb({ readonly: true }) does not migrate and does not throw when the file exists with schema already applied', () => {
    db = openLearningDb();
    db.close();
    db = null;

    const ro = openLearningDb({ readonly: true });
    try {
      expect(tables(ro)).toContain('learned_block');
      // A readonly handle cannot write. A migration reaching this handle would throw here.
      expect(() =>
        ro.exec("INSERT INTO learned_block (project, text, rendered_at) VALUES ('*','x','now')")
      ).toThrow(/readonly/i);
    } finally {
      ro.close();
    }
  });

  it('explicit migrate: false on a writable handle skips schema creation', () => {
    const target = path.join(configDir, 'learned', 'empty.sqlite');
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const raw = openLearningDb({ path: target, migrate: false });
    try {
      expect(tables(raw)).not.toContain('learned_block');
    } finally {
      raw.close();
    }
  });

  it('the index database and learning.sqlite have no memoryjs tables and the index has no learning tables', async () => {
    const store = openKnowledgeStore();
    try {
      await store.putEntry({
        id: 'learned:skill:proj-a:alpha:v1',
        kind: 'skill',
        project: 'proj-a',
        slug: 'alpha',
        version: 1,
        title: 'Alpha skill',
        description: 'Use when the user asks about alpha',
        body: 'alpha lives in the archive',
        scope: 'proj-a repository work',
        confidence: 'medium',
        trust: 'unverified',
        sources: [],
        status: 'candidate',
        runId: 'run-1',
        createdAt: '2026-11-05T00:00:00.000Z',
        supersededBy: null,
        validation: null,
        heuristicIds: [],
        decisionId: null,
        procedureId: null,
      });
    } finally {
      store.close();
    }

    db = openLearningDb();

    const knowledge = new Database(getKnowledgeDbPath(), { readonly: true });
    try {
      const names = tables(knowledge);
      expect(names).toContain('entities');
      expect(names).toContain('relations');
      expect(names).not.toContain('learning_task');
      expect(names).not.toContain('learning_attempt');
      expect(names).not.toContain('learned_block');
      expect(names).not.toContain('knowledge_snapshot');
    } finally {
      knowledge.close();
    }

    const learningNames = tables(db);
    expect(learningNames).not.toContain('entities');
    expect(learningNames).not.toContain('relations');

    // The index database carries exchanges and digest tables but no memoryjs or learning tables.
    const index = new Database(path.join(getIndexDir(), 'probe.db'));
    try {
      index.exec('CREATE TABLE exchanges (id TEXT PRIMARY KEY)');
      const indexNames = tables(index);
      expect(indexNames).not.toContain('entities');
      expect(indexNames).not.toContain('learning_task');
      expect(indexNames).not.toContain('knowledge_snapshot');
    } finally {
      index.close();
    }
  });

  it('removing conversation-index/ leaves learned/ intact', async () => {
    const store = openKnowledgeStore();
    try {
      await store.putEntry({
        id: 'learned:skill:proj-a:alpha:v1',
        kind: 'skill',
        project: 'proj-a',
        slug: 'alpha',
        version: 1,
        title: 'Alpha skill',
        description: 'Use when the user asks about alpha',
        body: 'alpha lives in the archive',
        scope: 'proj-a repository work',
        confidence: 'medium',
        trust: 'unverified',
        sources: [],
        status: 'active',
        runId: 'run-1',
        createdAt: '2026-11-05T00:00:00.000Z',
        supersededBy: null,
        validation: null,
        heuristicIds: [],
        decisionId: null,
        procedureId: null,
      });
    } finally {
      store.close();
    }
    db = openLearningDb();
    db.prepare('INSERT INTO learned_block (project, text, rendered_at) VALUES (?, ?, ?)').run(
      '*',
      'block text',
      '2026-11-05T00:00:00.000Z'
    );
    db.close();
    db = null;

    const indexDir = getIndexDir();
    expect(fs.existsSync(indexDir)).toBe(true);
    safeRmSync(indexDir);
    expect(fs.existsSync(indexDir)).toBe(false);

    // Rebuild the index directory; learned/ is untouched either way.
    fs.mkdirSync(indexDir, { recursive: true, mode: 0o700 });
    expect(fs.existsSync(getKnowledgeDbPath())).toBe(true);
    expect(fs.existsSync(getLearningDbPath())).toBe(true);

    const reopened = openKnowledgeStore();
    try {
      const entry = await reopened.getEntry('learned:skill:proj-a:alpha:v1');
      expect(entry?.title).toBe('Alpha skill');
    } finally {
      reopened.close();
    }

    db = openLearningDb({ readonly: true, migrate: false });
    const row = db.prepare('SELECT text FROM learned_block WHERE project = ?').get('*') as {
      text: string;
    };
    expect(row.text).toBe('block text');
  });

  it('learned_block is keyed by project and upsertable', () => {
    db = openLearningDb();
    const stmt = db.prepare(
      'INSERT INTO learned_block (project, text, rendered_at) VALUES (?, ?, ?) ' +
        'ON CONFLICT(project) DO UPDATE SET text = excluded.text, rendered_at = excluded.rendered_at'
    );
    stmt.run('proj-a', 'first', '2026-11-05T00:00:00.000Z');
    stmt.run('proj-a', 'second', '2026-11-05T01:00:00.000Z');
    stmt.run('*', 'global', '2026-11-05T01:00:00.000Z');
    const rows = db.prepare('SELECT project, text FROM learned_block ORDER BY project').all() as Array<{
      project: string;
      text: string;
    }>;
    expect(rows).toEqual([
      { project: '*', text: 'global' },
      { project: 'proj-a', text: 'second' },
    ]);
  });

  it('knowledge_snapshot stores entry names as a JSON list', () => {
    db = openLearningDb();
    db.prepare(
      'INSERT INTO knowledge_snapshot (run_id, created_at, entry_names) VALUES (?, ?, ?)'
    ).run('run-1', '2026-11-05T00:00:00.000Z', JSON.stringify(['a', 'b']));
    const row = db.prepare('SELECT entry_names FROM knowledge_snapshot').get() as {
      entry_names: string;
    };
    expect(JSON.parse(row.entry_names)).toEqual(['a', 'b']);
  });
});
