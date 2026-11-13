import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { Database } from '../src/sqlite.js';
import {
  closeSharedReaderDatabase,
  deleteExchange,
  ensureVectorTable,
  initDatabase,
  insertExchange,
  migrateVec0Vectors,
  registerVectorFunctions,
} from '../src/db.js';
import type { ConversationExchange } from '../src/types.js';
import { getFixturePath, safeRmSync } from './test-utils.js';
import { countStale, pickStaleBatch } from '../src/embedding-migration.js';
import { pruneProjects } from '../src/prune.js';

const DIM = 384;
const BYTES = DIM * 4;

function vector(seed: number): Float32Array {
  const v = new Float32Array(DIM);
  for (let i = 0; i < DIM; i++) v[i] = Math.sin(seed * 7.1 + i * 0.37);
  return v;
}

function blob(v: Float32Array): Buffer {
  return Buffer.from(v.buffer, v.byteOffset, v.byteLength);
}

function floats(b: Uint8Array): number[] {
  return Array.from(new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)));
}

function l2(a: Float32Array, b: Float32Array): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += (a[i] - b[i]) ** 2;
  return Math.sqrt(s);
}

function sample(id: string): ConversationExchange {
  return {
    id,
    project: 'p',
    timestamp: '2026-01-01T00:00:00.000Z',
    userMessage: 'hello world',
    assistantMessage: 'hi there',
    archivePath: '/archive/p/a.jsonl',
    lineStart: 1,
    lineEnd: 2,
  };
}

/**
 * Write vec0 shadow tables with the documented layout of sqlite-vec 0.1.9.
 * Each slot is [id, chunk, offset, valid, vector]. The chunk size is 8.
 */
function writeShadow(db: Database, slots: Array<[string, number, number, boolean, Float32Array]>): void {
  db.exec(`
    CREATE TABLE vec_exchanges_rowids(rowid INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE NOT NULL, chunk_id INTEGER, chunk_offset INTEGER);
    CREATE TABLE vec_exchanges_chunks(chunk_id INTEGER PRIMARY KEY AUTOINCREMENT, size INTEGER NOT NULL, validity BLOB NOT NULL, rowids BLOB NOT NULL);
    CREATE TABLE vec_exchanges_vector_chunks00(rowid INTEGER PRIMARY KEY, vectors BLOB NOT NULL);
  `);
  const chunks = [...new Set(slots.map(s => s[1]))];
  for (const c of chunks) {
    const validity = new Uint8Array(1);
    const vectors = new Uint8Array(8 * BYTES);
    for (const [, chunk, offset, valid, v] of slots) {
      if (chunk !== c) continue;
      if (valid) validity[0] |= 1 << offset;
      vectors.set(new Uint8Array(v.buffer), offset * BYTES);
    }
    db.prepare('INSERT INTO vec_exchanges_chunks(chunk_id, size, validity, rowids) VALUES (?, 8, ?, ?)').run(c, validity, new Uint8Array(64));
    db.prepare('INSERT INTO vec_exchanges_vector_chunks00(rowid, vectors) VALUES (?, ?)').run(c, vectors);
  }
  for (const [id, chunk, offset] of slots) {
    db.prepare('INSERT INTO vec_exchanges_rowids(id, chunk_id, chunk_offset) VALUES (?, ?, ?)').run(id, chunk, offset);
  }
}

describe('exchange vectors on node:sqlite', () => {
  let dir: string;
  let file: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'em-vectors-'));
    file = path.join(dir, 'db.sqlite');
    process.env.TEST_DB_PATH = file;
    closeSharedReaderDatabase();
  });
  afterEach(() => {
    closeSharedReaderDatabase();
    delete process.env.TEST_DB_PATH;
    safeRmSync(dir);
  });

  describe('vec_distance_l2', () => {
    it('returns the L2 distance of two stored vectors', () => {
      const db = new Database(':memory:');
      try {
        registerVectorFunctions(db);
        const a = vector(1);
        const b = vector(2);
        const { d } = db.prepare('SELECT vec_distance_l2(?, ?) AS d').get(blob(a), blob(b)) as { d: number };
        expect(d).toBeCloseTo(l2(a, b), 4);
        expect((db.prepare('SELECT vec_distance_l2(?, ?) AS d').get(blob(a), blob(a)) as { d: number }).d).toBe(0);
      } finally {
        db.close();
      }
    });

    it('throws when the two vectors differ in length', () => {
      const db = new Database(':memory:');
      try {
        registerVectorFunctions(db);
        expect(() => db.prepare('SELECT vec_distance_l2(?, ?)').get(blob(vector(1)), blob(new Float32Array(3)))).toThrow();
      } finally {
        db.close();
      }
    });
  });

  describe('the exchange_vectors table', () => {
    it('stores the vector of an inserted exchange and drops it with the exchange', () => {
      const db = initDatabase();
      try {
        const v = vector(3);
        insertExchange(db, sample('e1'), Array.from(v));
        const row = db.prepare('SELECT embedding FROM exchange_vectors WHERE id = ?').get('e1') as { embedding: Uint8Array };
        expect(row.embedding.byteLength).toBe(BYTES);
        expect(floats(row.embedding)).toEqual(Array.from(v));
        insertExchange(db, sample('e1'), Array.from(vector(4)));
        expect(db.prepare('SELECT COUNT(*) AS n FROM exchange_vectors').get()).toEqual({ n: 1 });
        deleteExchange(db, 'e1');
        expect(db.prepare('SELECT COUNT(*) AS n FROM exchange_vectors').get()).toEqual({ n: 0 });
      } finally {
        db.close();
      }
    });

    it('refuses a vector of the wrong width and a vector without an exchange', () => {
      const db = initDatabase();
      try {
        insertExchange(db, sample('e1'), Array.from(vector(3)));
        expect(() => db.prepare('INSERT OR REPLACE INTO exchange_vectors VALUES (?, ?)').run('e1', new Uint8Array(8))).toThrow();
        expect(() => db.prepare('INSERT INTO exchange_vectors VALUES (?, ?)').run('nope', blob(vector(1)))).toThrow();
      } finally {
        db.close();
      }
    });
  });

  describe('migrateVec0Vectors', () => {
    let db: Database;
    beforeEach(() => {
      db = new Database(file);
      db.exec('CREATE TABLE exchanges (id TEXT PRIMARY KEY, embedding_version INTEGER NOT NULL DEFAULT 1)');
      ensureVectorTable(db);
    });
    afterEach(() => db.close());

    const stored = (id: string) =>
      db.prepare('SELECT embedding FROM exchange_vectors WHERE id = ?').get(id) as { embedding: Uint8Array } | undefined;

    it('copies the valid slots of exchanges that exist, byte for byte, and only once', () => {
      for (const id of ['a', 'b', 'c', 'cleared', 'missing']) db.prepare('INSERT INTO exchanges (id) VALUES (?)').run(id);
      writeShadow(db, [
        ['a', 1, 0, true, vector(10)],
        ['b', 1, 5, true, vector(11)],
        ['c', 2, 7, true, vector(12)],
        ['cleared', 2, 1, false, vector(13)],
        ['orphan', 2, 2, true, vector(14)],
      ]);
      const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
      try {
        expect(migrateVec0Vectors(db)).toBe(3);
        expect(floats(stored('a')!.embedding)).toEqual(Array.from(vector(10)));
        expect(floats(stored('b')!.embedding)).toEqual(Array.from(vector(11)));
        expect(floats(stored('c')!.embedding)).toEqual(Array.from(vector(12)));
        expect(stored('cleared')).toBeUndefined();
        expect(stored('orphan')).toBeUndefined();
        expect(migrateVec0Vectors(db)).toBe(0);
        expect(errors.mock.calls.some(c => String(c[0]).includes('copied 3 vector(s)'))).toBe(true);
      } finally {
        errors.mockRestore();
      }
    });

    it('marks an exchange with no vector as stale, so the embedding migration embeds it again', () => {
      for (const id of ['a', 'missing']) db.prepare('INSERT INTO exchanges (id) VALUES (?)').run(id);
      writeShadow(db, [['a', 1, 0, true, vector(10)]]);
      migrateVec0Vectors(db);
      const version = (id: string) =>
        (db.prepare('SELECT embedding_version AS v FROM exchanges WHERE id = ?').get(id) as { v: number }).v;
      expect(version('a')).toBe(1);
      expect(version('missing')).toBe(0);
    });

    it('copies nothing and changes nothing when only some shadow tables exist', () => {
      db.prepare('INSERT INTO exchanges (id) VALUES (?)').run('a');
      db.exec('CREATE TABLE vec_exchanges_rowids(rowid INTEGER PRIMARY KEY, id TEXT, chunk_id INTEGER, chunk_offset INTEGER)');
      const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
      try {
        expect(migrateVec0Vectors(db)).toBe(0);
        expect(errors).toHaveBeenCalled();
      } finally {
        errors.mockRestore();
      }
      expect((db.prepare('SELECT embedding_version AS v FROM exchanges').get() as { v: number }).v).toBe(1);
    });

    it('does nothing on a file that never had vec0 tables', () => {
      db.prepare('INSERT INTO exchanges (id) VALUES (?)').run('a');
      expect(migrateVec0Vectors(db)).toBe(0);
    });
  });

  describe('migrateVec0Vectors on an open that has nothing to copy', () => {
    it('takes no write lock when every vector is already copied', () => {
      initDatabase().close();
      const raw = new Database(file);
      raw.exec('PRAGMA busy_timeout = 0');
      writeShadow(raw, [['x', 1, 0, true, vector(30)]]);
      raw.close();
      // No exchange 'x' exists, so nothing is copyable. Another connection holds the write lock.
      const holder = new Database(file);
      const db = new Database(file);
      try {
        db.exec('PRAGMA busy_timeout = 0');
        holder.exec('BEGIN IMMEDIATE');
        expect(() => migrateVec0Vectors(db)).not.toThrow();
      } finally {
        holder.exec('ROLLBACK');
        holder.close();
        db.close();
      }
    });

    it('takes no write lock for an exchange whose only slot has a cleared validity bit', () => {
      initDatabase().close();
      const raw = new Database(file);
      raw.prepare("INSERT INTO exchanges (id, project, timestamp, user_message, assistant_message, archive_path, line_start, line_end, embedding_version) VALUES ('z', 'p', 't', 'u', 'a', '/x.jsonl', 1, 2, 1)").run();
      writeShadow(raw, [['z', 1, 2, false, vector(32)]]);
      raw.close();
      const holder = new Database(file);
      const db = new Database(file);
      try {
        db.exec('PRAGMA busy_timeout = 0');
        holder.exec('BEGIN IMMEDIATE');
        expect(migrateVec0Vectors(db)).toBe(0);
      } finally {
        holder.exec('ROLLBACK');
        holder.close();
        db.close();
      }
    });

    it('ignores a slot whose rowids row is gone, as sqlite-vec leaves it after a delete', () => {
      const db = initDatabase();
      try {
        db.prepare("INSERT INTO exchanges (id, project, timestamp, user_message, assistant_message, archive_path, line_start, line_end, embedding_version) VALUES ('g', 'p', 't', 'u', 'a', '/x.jsonl', 1, 2, 1)").run();
        writeShadow(db, [['g', 1, 0, true, vector(31)]]);
        db.exec('DELETE FROM vec_exchanges_rowids');
        expect(migrateVec0Vectors(db)).toBe(0);
      } finally {
        db.close();
      }
    });
  });

  describe('an exchange without a vector', () => {
    it('counts as stale and is picked for re-embedding, whatever its version', () => {
      const db = initDatabase();
      try {
        insertExchange(db, sample('has'), Array.from(vector(40)));
        insertExchange(db, sample('lost'), Array.from(vector(41)));
        db.exec("DELETE FROM exchange_vectors WHERE id = 'lost'");
        expect(countStale(db)).toBe(1);
        expect(pickStaleBatch(db, 10).map(r => r.id)).toEqual(['lost']);
      } finally {
        db.close();
      }
    });
  });

  describe('insertExchange atomicity', () => {
    it('writes nothing and keeps the old row when the vector has the wrong width', () => {
      const db = initDatabase();
      try {
        insertExchange(db, sample('e1'), Array.from(vector(50)));
        const bad = { ...sample('e1'), userMessage: 'changed' };
        expect(() => insertExchange(db, bad, [1, 2, 3])).toThrow(/384/);
        const row = db.prepare("SELECT user_message AS m FROM exchanges WHERE id = 'e1'").get() as { m: string };
        expect(row.m).toBe('hello world');
        expect(db.prepare("SELECT COUNT(*) AS n FROM exchange_vectors WHERE id = 'e1'").get()).toEqual({ n: 1 });
        expect(() => insertExchange(db, sample('e2'), [1, 2, 3])).toThrow();
        expect(db.prepare("SELECT COUNT(*) AS n FROM exchanges WHERE id = 'e2'").get()).toEqual({ n: 0 });
      } finally {
        db.close();
      }
    });
  });

  describe('pruneProjects', () => {
    it('reports the vectors that it deletes, not the exchanges', () => {
      const db = initDatabase();
      try {
        insertExchange(db, sample('p1'), Array.from(vector(60)));
        insertExchange(db, { ...sample('p2'), id: 'p2' }, Array.from(vector(61)));
        db.exec("DELETE FROM exchange_vectors WHERE id = 'p2'");
        const result = pruneProjects(db, ['p']);
        expect(result.exchangesDeleted).toBe(2);
        expect(result.vectorsDeleted).toBe(1);
      } finally {
        db.close();
      }
    });
  });

  it('reads the vectors of a file that the sqlite-vec extension wrote', () => {
    fs.copyFileSync(getFixturePath('vec0-v0.1.9.sqlite'), file);
    const db = new Database(file);
    try {
      ensureVectorTable(db);
      expect(migrateVec0Vectors(db)).toBe(3);
      for (let k = 0; k < 3; k++) {
        const want = Array.from({ length: DIM }, (_, i) => Math.fround((k + 1) * 0.001 * (i + 1)));
        const row = db.prepare('SELECT embedding FROM exchange_vectors WHERE id = ?').get('fx' + k) as { embedding: Uint8Array };
        expect(floats(row.embedding)).toEqual(want);
      }
    } finally {
      db.close();
    }
  });

  it('copies the vectors when initDatabase opens a file of the earlier version', () => {
    initDatabase().close();
    const raw = new Database(file);
    try {
      raw.prepare("INSERT INTO exchanges (id, project, timestamp, user_message, assistant_message, archive_path, line_start, line_end, embedding_version) VALUES ('old', 'p', 't', 'u', 'a', '/x.jsonl', 1, 2, 1)").run();
      raw.exec('DELETE FROM exchange_vectors');
      writeShadow(raw, [['old', 1, 3, true, vector(20)]]);
    } finally {
      raw.close();
    }
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const db = initDatabase();
    try {
      const row = db.prepare("SELECT embedding FROM exchange_vectors WHERE id = 'old'").get() as { embedding: Uint8Array };
      expect(floats(row.embedding)).toEqual(Array.from(vector(20)));
    } finally {
      db.close();
      errors.mockRestore();
    }
  });
});
