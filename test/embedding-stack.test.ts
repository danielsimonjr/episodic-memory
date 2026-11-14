import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { Database } from '../src/sqlite.js';
import { embeddingStamp, readEmbeddingStack, reconcileEmbeddingStack, stampEmptyIndex } from '../src/embedding-stack.js';
import { initDatabase } from '../src/db.js';
import { safeRmSync } from './test-utils.js';

function writePkg(dir: string, name: string, version: string): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name, version }));
}

describe('readEmbeddingStack', () => {
  let root: string;
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'em-stack-')); });
  afterEach(() => safeRmSync(root));

  it('reads the hoisted versions of the three packages', () => {
    const nm = join(root, 'node_modules');
    writePkg(join(nm, 'onnxruntime-node'), 'onnxruntime-node', '1.24.3');
    writePkg(join(nm, 'onnxruntime-common'), 'onnxruntime-common', '1.24.3');
    writePkg(join(nm, '@huggingface', 'tokenizers'), '@huggingface/tokenizers', '0.1.3');
    expect(readEmbeddingStack(root)).toBe(
      'onnxruntime-node@1.24.3 onnxruntime-common@1.24.3 @huggingface/tokenizers@0.1.3');
  });

  it('prefers the copy nested under its dependent, as Node resolution does', () => {
    const nm = join(root, 'node_modules');
    const ort = join(nm, 'onnxruntime-node');
    writePkg(ort, 'onnxruntime-node', '1.30.0');
    writePkg(join(ort, 'node_modules', 'onnxruntime-common'), 'onnxruntime-common', '1.30.0');
    writePkg(join(nm, 'onnxruntime-common'), 'onnxruntime-common', '1.24.3');
    writePkg(join(nm, '@huggingface', 'tokenizers'), '@huggingface/tokenizers', '0.1.3');
    expect(readEmbeddingStack(root)).toBe(
      'onnxruntime-node@1.30.0 onnxruntime-common@1.30.0 @huggingface/tokenizers@0.1.3');
  });

  it('names a missing package as missing', () => {
    expect(readEmbeddingStack(root)).toBe(
      'onnxruntime-node@missing onnxruntime-common@missing @huggingface/tokenizers@missing');
  });
});

describe('embeddingStamp', () => {
  it('adds the pinned model revision to the installed packages', () => {
    expect(embeddingStamp()).toBe(
      readEmbeddingStack() + ' model=Xenova/bge-small-en-v1.5@ea104dacec62c0de699686887e3f920caeb4f3e3');
  });
});

describe('reconcileEmbeddingStack', () => {
  let dir: string;
  let db: Database;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'em-stack-db-'));
    db = new Database(join(dir, 'x.db'));
    db.exec('CREATE TABLE exchanges (id TEXT PRIMARY KEY, embedding_version INTEGER NOT NULL DEFAULT 0)');
    db.exec("INSERT INTO exchanges VALUES ('a', 1), ('b', 1)");
  });
  afterEach(() => { db.close(); safeRmSync(dir); });

  const versions = () =>
    (db.prepare('SELECT embedding_version AS v FROM exchanges ORDER BY id').all() as { v: number }[]).map(r => r.v);

  it('marks every row stale when the index has no stamp', () => {
    expect(reconcileEmbeddingStack(db, 'stack-A')).toBe(true);
    expect(versions()).toEqual([0, 0]);
  });

  it('leaves the rows alone when the stamp matches', () => {
    reconcileEmbeddingStack(db, 'stack-A');
    db.exec('UPDATE exchanges SET embedding_version = 1');
    expect(reconcileEmbeddingStack(db, 'stack-A')).toBe(false);
    expect(versions()).toEqual([1, 1]);
  });

  it('marks every row stale when the stack changes', () => {
    reconcileEmbeddingStack(db, 'stack-A');
    db.exec('UPDATE exchanges SET embedding_version = 1');
    expect(reconcileEmbeddingStack(db, 'stack-B')).toBe(true);
    expect(versions()).toEqual([0, 0]);
    expect(reconcileEmbeddingStack(db, 'stack-B')).toBe(false);
  });
});

describe('stampEmptyIndex', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'em-stack-empty-')); });
  afterEach(() => { delete process.env.TEST_DB_PATH; safeRmSync(dir); });

  it('stamps an index with no rows, so the first sync embeds each row once', () => {
    const db = new Database(join(dir, 'x.db'));
    db.exec('CREATE TABLE exchanges (id TEXT PRIMARY KEY, embedding_version INTEGER NOT NULL DEFAULT 0)');
    stampEmptyIndex(db, 'stack-A');
    db.exec("INSERT INTO exchanges VALUES ('a', 1)");
    expect(reconcileEmbeddingStack(db, 'stack-A')).toBe(false);
    db.close();
  });

  it('leaves an index with rows and no stamp for the migration to mark stale', () => {
    const db = new Database(join(dir, 'x.db'));
    db.exec('CREATE TABLE exchanges (id TEXT PRIMARY KEY, embedding_version INTEGER NOT NULL DEFAULT 0)');
    db.exec("INSERT INTO exchanges VALUES ('a', 1)");
    stampEmptyIndex(db, 'stack-A');
    expect(reconcileEmbeddingStack(db, 'stack-A')).toBe(true);
    db.close();
  });

  it('runs when initDatabase creates a new index', () => {
    process.env.TEST_DB_PATH = join(dir, 'fresh.db');
    const db = initDatabase();
    expect(reconcileEmbeddingStack(db, embeddingStamp())).toBe(false);
    db.close();
  });
});
