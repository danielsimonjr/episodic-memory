import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawn } from 'child_process';
import { Database, requireTransactionState, sqliteLoadError } from '../src/sqlite.js';
import { NODE_FLOOR } from '../src/node-floor.js';
import { safeRmSync } from './test-utils.js';

// This block runs first, before any other test of the file opens a database, so node:sqlite loads inside it.
describe('the experimental warning of node:sqlite', () => {
  it('drops only the SQLite warning and delivers every other warning', async () => {
    const seen: string[] = [];
    const onWarning = (w: Error) => seen.push(w.message);
    process.on('warning', onWarning);
    try {
      const db = new Database(':memory:');
      db.close();
      process.emitWarning('unrelated warning of the adapter test');
      await new Promise(r => setImmediate(r));
      await new Promise(r => setImmediate(r));
    } finally {
      process.off('warning', onWarning);
    }
    expect(seen.filter(m => m.startsWith('SQLite is an experimental feature'))).toEqual([]);
    expect(seen).toContain('unrelated warning of the adapter test');
  });
});

describe('Database adapter over node:sqlite', () => {
  let dir: string;
  let file: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sqlite-adapter-'));
    file = path.join(dir, 'a.db');
  });
  afterEach(() => safeRmSync(dir));

  describe('open options', () => {
    it('throws for a read-only open of a missing file and creates no file', () => {
      expect(() => new Database(file, { readonly: true, fileMustExist: true })).toThrow(/unable to open database file/);
      expect(fs.existsSync(file)).toBe(false);
    });

    it('refuses a write on a read-only connection', () => {
      new Database(file).close();
      const ro = new Database(file, { readonly: true });
      try {
        expect(() => ro.exec('CREATE TABLE t(x)')).toThrow();
      } finally {
        ro.close();
      }
    });

    it('turns foreign keys on, so a child row without a parent throws', () => {
      const db = new Database(file);
      try {
        expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
        db.exec('CREATE TABLE p(id TEXT PRIMARY KEY); CREATE TABLE c(pid TEXT REFERENCES p(id))');
        expect(() => db.prepare('INSERT INTO c VALUES (?)').run('missing')).toThrow();
      } finally {
        db.close();
      }
    });

    it('closes twice without an error', () => {
      const db = new Database(':memory:');
      db.close();
      expect(() => db.close()).not.toThrow();
      expect(db.open).toBe(false);
    });

    it('reports the path it opened as name', () => {
      const db = new Database(file);
      try {
        expect(db.name).toBe(file);
      } finally {
        db.close();
      }
    });

    it('reports open and inTransaction', () => {
      const db = new Database(file);
      expect(db.open).toBe(true);
      expect(db.inTransaction).toBe(false);
      db.exec('BEGIN');
      expect(db.inTransaction).toBe(true);
      db.exec('COMMIT');
      db.close();
      expect(db.open).toBe(false);
    });
  });

  describe('binding', () => {
    let db: Database;
    beforeEach(() => {
      db = new Database(':memory:');
      db.exec('CREATE TABLE t(n, s TEXT)');
    });
    afterEach(() => db.close());

    it('binds undefined as NULL, positional and named', () => {
      db.prepare('INSERT INTO t VALUES (?, ?)').run(undefined, 'a');
      db.prepare('INSERT INTO t VALUES (:n, :s)').run({ n: undefined, s: 'b' });
      expect(db.prepare('SELECT n FROM t WHERE n IS NULL').all()).toHaveLength(2);
    });

    it('binds a safe integer Number as INTEGER, positional and named', () => {
      db.prepare('INSERT INTO t VALUES (?, ?)').run(7, 'a');
      db.prepare('INSERT INTO t VALUES (@n, @s)').run({ n: 8, s: 'b' });
      const rows = db.prepare('SELECT typeof(n) AS k, s FROM t ORDER BY s').all() as Array<{ k: string }>;
      expect(rows.map(r => r.k)).toEqual(['integer', 'integer']);
      expect((db.prepare("SELECT s FROM t WHERE s = 'a'").get() as { s: string }).s).toBe('a');
    });

    it('keeps a fractional Number as REAL', () => {
      db.prepare('INSERT INTO t VALUES (?, ?)').run(1.5, 'a');
      expect(db.prepare('SELECT typeof(n) AS k FROM t').get()).toEqual({ k: 'real' });
    });

    it('stores an integer in a TEXT column as its integer text', () => {
      db.prepare('INSERT INTO t VALUES (?, ?)').run(1, 7);
      expect(db.prepare('SELECT s FROM t').get()).toEqual({ s: '7' });
    });

    it('concatenates an integer Number without a decimal point', () => {
      expect(db.prepare("SELECT 'v' || ? AS s").get(7)).toEqual({ s: 'v7' });
    });

    it('binds a missing positional value as NULL', () => {
      expect(db.prepare('SELECT ? AS a, ? AS b').get(1)).toEqual({ a: 1, b: null });
    });

    it('keeps the rowid condition of an FTS5 match', () => {
      db.exec("CREATE VIRTUAL TABLE f USING fts5(body); INSERT INTO f(rowid, body) VALUES (1, 'x'), (2, 'x')");
      const rows = db.prepare('SELECT rowid AS r FROM f WHERE f MATCH ? AND rowid = ?').all('x', 2) as Array<{ r: number }>;
      expect(rows.map(r => Number(r.r))).toEqual([2]);
    });

    it('returns run() counts as numbers', () => {
      const info = db.prepare('INSERT INTO t VALUES (?, ?)').run(1, 'a');
      expect(info.changes).toBe(1);
      expect(typeof info.lastInsertRowid).toBe('number');
    });

    it('supports get, all and iterate', () => {
      const ins = db.prepare('INSERT INTO t VALUES (?, ?)');
      ins.run(1, 'a');
      ins.run(2, 'b');
      expect(db.prepare('SELECT n FROM t WHERE s = ?').get('b')).toEqual({ n: 2 });
      expect(db.prepare('SELECT n FROM t WHERE s = ?').get('zz')).toBeUndefined();
      expect([...db.prepare('SELECT n FROM t ORDER BY n').iterate()].map(r => (r as { n: number }).n)).toEqual([1, 2]);
    });

    it('round-trips a vector BLOB as a Uint8Array with an equal Float32Array view', () => {
      db.exec('CREATE TABLE v(e BLOB)');
      const input = new Float32Array([0.25, -1.5, 3]);
      db.prepare('INSERT INTO v VALUES (?)').run(Buffer.from(input.buffer));
      const { e } = db.prepare('SELECT e FROM v').get() as { e: Uint8Array };
      expect(e).toBeInstanceOf(Uint8Array);
      expect(Array.from(new Float32Array(e.buffer, e.byteOffset, e.byteLength / 4))).toEqual(Array.from(input));
    });
  });

  describe('pragma', () => {
    it('runs the write form and reads the value back in both read forms', () => {
      const db = new Database(file);
      try {
        db.pragma('busy_timeout = 1234');
        expect(db.pragma('busy_timeout', { simple: true })).toBe(1234);
        const rows = db.pragma('busy_timeout') as Array<Record<string, unknown>>;
        expect(rows).toHaveLength(1);
        expect(Object.values(rows[0])).toEqual([1234]);
        db.pragma('journal_mode = WAL');
        expect(db.pragma('journal_mode', { simple: true })).toBe('wal');
      } finally {
        db.close();
      }
    });
  });

  describe('transaction', () => {
    let db: Database;
    beforeEach(() => {
      db = new Database(':memory:');
      db.exec('CREATE TABLE t(n INTEGER)');
    });
    afterEach(() => db.close());
    const count = () => (db.prepare('SELECT COUNT(*) AS c FROM t').get() as { c: number }).c;

    it('passes the arguments, returns the value and commits', () => {
      const tx = db.transaction((a: number, b: number) => {
        db.prepare('INSERT INTO t VALUES (?)').run(a);
        db.prepare('INSERT INTO t VALUES (?)').run(b);
        return a + b;
      });
      expect(tx(2, 3)).toBe(5);
      expect(count()).toBe(2);
      expect(db.inTransaction).toBe(false);
    });

    it('rolls back on throw and rethrows the original error', () => {
      class Boom extends Error {}
      const tx = db.transaction(() => {
        db.prepare('INSERT INTO t VALUES (1)').run();
        throw new Boom('x');
      });
      expect(() => tx()).toThrow(Boom);
      expect(count()).toBe(0);
      expect(db.inTransaction).toBe(false);
    });

    it('rolls back only the inner savepoint of a nested call', () => {
      const inner = db.transaction(() => {
        db.prepare('INSERT INTO t VALUES (2)').run();
        throw new Error('inner');
      });
      const outer = db.transaction(() => {
        db.prepare('INSERT INTO t VALUES (1)').run();
        try {
          inner();
        } catch {
          // the inner failure is handled here
        }
        expect(db.inTransaction).toBe(true);
      });
      outer();
      expect(db.prepare('SELECT n FROM t').all()).toEqual([{ n: 1 }]);
    });

    it('nests inside a manual BEGIN as a savepoint, also for immediate', () => {
      const tx = db.transaction(() => db.prepare('INSERT INTO t VALUES (1)').run());
      db.exec('BEGIN');
      tx.immediate();
      expect(db.inTransaction).toBe(true);
      db.exec('ROLLBACK');
      expect(count()).toBe(0);
    });

    it('keeps the original error when SQLite already ended the transaction', () => {
      const tx = db.transaction(() => {
        db.exec('ROLLBACK');
        throw new RangeError('original');
      });
      expect(() => tx()).toThrow(RangeError);
      expect(db.inTransaction).toBe(false);
    });

    it('refuses an async function when it wraps it, and never runs the body', () => {
      let ran = false;
      expect(() =>
        db.transaction(async () => {
          ran = true;
        }),
      ).toThrow(TypeError);
      expect(ran).toBe(false);
    });

    it('refuses a function that returns a promise, after a rollback', () => {
      const tx = db.transaction(() => {
        db.prepare('INSERT INTO t VALUES (1)').run();
        return Promise.resolve();
      });
      expect(() => tx()).toThrow(TypeError);
      expect(count()).toBe(0);
      expect(db.inTransaction).toBe(false);
    });

    it('offers deferred and exclusive forms', () => {
      const tx = db.transaction(() => db.prepare('INSERT INTO t VALUES (1)').run());
      tx.deferred();
      tx.exclusive();
      expect(count()).toBe(2);
    });
  });

  describe('immediate transaction across processes', () => {
    it('waits for the write lock and fails when another process holds it', async () => {
      new Database(file).close();
      const holder = `
        const { DatabaseSync } = require('node:sqlite');
        const db = new DatabaseSync(process.argv[1]);
        db.exec('BEGIN IMMEDIATE');
        process.stdout.write('locked\\n');
        setTimeout(() => { db.exec('COMMIT'); db.close(); }, 3000);
      `;
      const child = spawn(process.execPath, ['-e', holder, file], { stdio: ['ignore', 'pipe', 'pipe'] });
      try {
        await new Promise<void>((resolve, reject) => {
          child.stdout.on('data', d => String(d).includes('locked') && resolve());
          child.on('exit', code => reject(new Error(`holder exited ${code}`)));
        });
        const db = new Database(file);
        try {
          db.pragma('busy_timeout = 200');
          // The body only reads, so a deferred BEGIN would never ask for the write lock.
          const tx = db.transaction(() => db.prepare('SELECT 1').get());
          expect(() => tx.immediate()).toThrow(/locked|busy/i);
          expect(db.inTransaction).toBe(false);
        } finally {
          db.close();
        }
      } finally {
        if (child.exitCode === null) {
          const exited = new Promise(r => child.once('exit', r));
          child.kill();
          await exited;
        }
      }
    }, 15000);
  });

  describe('function', () => {
    it('registers a deterministic SQL function', () => {
      const db = new Database(':memory:');
      try {
        db.function('twice', { deterministic: true }, (x: unknown) => Number(x) * 2);
        expect(db.prepare('SELECT twice(21) AS v').get()).toEqual({ v: 42 });
      } finally {
        db.close();
      }
    });
  });
});

describe('a node:sqlite without isTransaction (Node below the floor)', () => {
  it('closes the handle and throws an error that names the floor', () => {
    let closed = false;
    const old = { close: () => { closed = true; } };
    expect(() => requireTransactionState(old)).toThrow(NODE_FLOOR);
    expect(closed).toBe(true);
  });

  it('accepts the handle of this Node', () => {
    const db = new Database(':memory:');
    try {
      expect(db.inTransaction).toBe(false);
    } finally {
      db.close();
    }
  });
});

describe('a Node that has no node:sqlite module', () => {
  it('names the floor instead of the unknown built-in module', () => {
    const original = Object.assign(new Error('No such built-in module: node:sqlite'), { code: 'ERR_UNKNOWN_BUILTIN_MODULE' });
    const err = sqliteLoadError(original, '22.12.0');
    expect(err.message).toContain(NODE_FLOOR);
    expect(err.cause).toBe(original);
  });

  it('keeps the original error on a Node at or above the floor', () => {
    const original = new Error('other');
    expect(sqliteLoadError(original, '24.0.0')).toBe(original);
  });
});
