import fs from 'fs';
import path from 'path';
import os from 'os';
import Database from 'better-sqlite3';
import { ensureDigestSchema, insertDigestEntry } from '../src/digest-db.js';

/**
 * Suppress console output during test execution.
 */
export function suppressConsole(): () => void {
  const originalLog = console.log;
  const originalError = console.error;
  const originalWarn = console.warn;

  console.log = () => {};
  console.error = () => {};
  console.warn = () => {};

  return () => {
    console.log = originalLog;
    console.error = originalError;
    console.warn = originalWarn;
  };
}

/**
 * Create a temporary test database that will be cleaned up automatically.
 */
export function createTestDb(): { db: Database.Database; cleanup: () => void } {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'episodic-memory-test-'));
  const dbPath = path.join(tmpDir, 'test.db');

  const db = new Database(dbPath);

  const cleanup = () => {
    try {
      db.close();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch (e) {
      // Ignore cleanup errors
    }
  };

  return { db, cleanup };
}

/**
 * Recursively remove a directory, tolerating transient Windows file-locking.
 *
 * On Windows, fs.rmSync({recursive:true, force:true}) can throw EPERM/EBUSY.
 * The EPERM/EBUSY error occurs while the OS has not finished releasing SQLite WAL files
 * (.db-wal, .db-shm) or just-closed handles. Short retries with backoff hide the race without
 * leaking handles or test temp dirs. Use this in afterEach in place of a
 * bare fs.rmSync when the test touches a real on-disk SQLite database.
 */
export function safeRmSync(dirPath: string, maxRetries = 5): void {
  let lastErr: unknown;
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      fs.rmSync(dirPath, { recursive: true, force: true });
      return;
    } catch (err) {
      lastErr = err;
      // Brief synchronous backoff: 20ms, 40ms, 80ms, 160ms, 320ms.
      const start = Date.now();
      const delayMs = 20 * 2 ** attempt;
      while (Date.now() - start < delayMs) {
        // spin — Vitest's afterEach is sync, so we can't await here
      }
    }
  }
  // Final attempt: swallow the error rather than failing the whole suite
  // over a temp-dir lock. The OS will reclaim it.
  try {
    fs.rmSync(dirPath, { recursive: true, force: true });
  } catch {
    console.error(`safeRmSync: gave up on ${dirPath} after ${maxRetries} retries:`, lastErr);
  }
}

/**
 * Get path to test fixture file.
 */
export function getFixturePath(filename: string): string {
  return path.join(__dirname, 'fixtures', filename);
}

/**
 * Read a test fixture file.
 */
export function readFixture(filename: string): string {
  return fs.readFileSync(getFixturePath(filename), 'utf-8');
}

/**
 * Count lines in a file.
 */
export function countLines(filePath: string): number {
  const content = fs.readFileSync(filePath, 'utf-8');
  return content.trim().split('\n').length;
}

/**
 * Write one session digest entry with one line for each indexed archive file, and return a reader of the lines.
 * Each line names the file and cites the exchange ids of that file.
 */
export function seedDigest(dbPath: string): () => string[] {
  const db = new Database(dbPath);
  try {
    ensureDigestSchema(db);
    const rows = db.prepare('SELECT id, archive_path FROM exchanges').all() as Array<{ id: string; archive_path: string }>;
    const byFile = new Map<string, string[]>();
    for (const r of rows) byFile.set(r.archive_path, [...(byFile.get(r.archive_path) ?? []), r.id]);
    const lines = [...byFile].map(([file, ids]) => `Fact of ${path.basename(file, '.jsonl')} [${ids.map(i => `#${i}`).join(',')}]`);
    insertDigestEntry(db, {
      tier: 'session', project: 'p', periodStart: '2025-10-01T12:00:00Z', periodEnd: '2025-10-01T12:05:00Z',
      text: lines.join('\n'), sources: rows.map(r => r.id), model: 'haiku', handoff: false,
    });
  } finally {
    db.close();
  }
  return () => {
    const db = new Database(dbPath, { readonly: true });
    try {
      return (db.prepare('SELECT text FROM digest_entry').all() as Array<{ text: string }>).flatMap(r => r.text.split('\n'));
    } finally {
      db.close();
    }
  };
}
