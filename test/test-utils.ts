import fs from 'fs';
import path from 'path';
import os from 'os';
import Database from 'better-sqlite3';

/**
 * Suppress console output during test execution
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
 * Create a temporary test database that will be cleaned up automatically
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
 * On Windows, fs.rmSync({recursive:true, force:true}) can throw EPERM/EBUSY
 * when SQLite WAL files (.db-wal, .db-shm) or just-closed handles are still
 * being released by the OS. Short retries with backoff hide the race without
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
 * Get path to test fixture file
 */
export function getFixturePath(filename: string): string {
  return path.join(__dirname, 'fixtures', filename);
}

/**
 * Read a test fixture file
 */
export function readFixture(filename: string): string {
  return fs.readFileSync(getFixturePath(filename), 'utf-8');
}

/**
 * Count lines in a file
 */
export function countLines(filePath: string): number {
  const content = fs.readFileSync(filePath, 'utf-8');
  return content.trim().split('\n').length;
}
