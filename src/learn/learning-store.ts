/**
 * The learning trace database: `<configDir>/learned/learning.sqlite`.
 *
 * This is the plugin's own database, opened with `better-sqlite3` directly, so
 * a SessionStart hook can read the rendered learned block without loading
 * memoryjs (§6.3 of the Recursa spec). It sits beside `knowledge.db` under
 * `learned/`, a sibling of `conversation-index/`, so an index reset never
 * reaches it.
 *
 * Task 1 creates `knowledge_snapshot` and `learned_block`; the `learning_*`
 * tables (runs, tasks, attempts) are added with their code.
 */

import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { getLearningDbPath, tryChmod } from '../paths.js';
import { ensureLearningSchema } from './learning-db.js';

/** Tables this module owns. Later tasks extend the list. */
export const LEARNING_TABLES = [
  'knowledge_snapshot',
  'learned_block',
  'learning_run',
  'learning_task',
  'learning_attempt',
] as const;

export interface OpenLearningDbOptions {
  /** Open read-only. Implies `migrate: false`. */
  readonly?: boolean;
  /** Override the file path (tests, and the hook's explicit path). */
  path?: string;
  /**
   * Run the schema statements. Defaults to true for a writable handle and is
   * forced to false for a read-only one: `CREATE TABLE` against a read-only
   * handle raises SQLITE_READONLY.
   */
  migrate?: boolean;
}

function applySecureFileMode(dbPath: string): void {
  tryChmod(dbPath, 0o600);
  tryChmod(`${dbPath}-wal`, 0o600);
  tryChmod(`${dbPath}-shm`, 0o600);
}

/**
 * Create the learning tables. Idempotent.
 */
export function migrateLearningSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS knowledge_snapshot (
      id INTEGER PRIMARY KEY,
      run_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      entry_names TEXT NOT NULL   -- JSON array of entity names
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS learned_block (
      project TEXT PRIMARY KEY,   -- project key, or '*' for the shared block
      text TEXT NOT NULL,
      rendered_at TEXT NOT NULL
    )
  `);

  // The learning trace: runs, tasks, attempts (spec §5.3).
  ensureLearningSchema(db);
}

/**
 * Open the learning trace database.
 *
 * Same pragmas and directory modes as `src/db.ts`. With `readonly`, the handle
 * never migrates — the hook opens it read-only on a file that may pre-date a
 * schema change, and SQLite refuses DDL on a read-only connection.
 */
export function openLearningDb(options: OpenLearningDbOptions = {}): Database.Database {
  const readonly = options.readonly === true;
  const migrate = readonly ? false : options.migrate !== false;
  const dbPath = options.path ?? getLearningDbPath();

  if (!readonly) {
    const dbDir = path.dirname(dbPath);
    if (!fs.existsSync(dbDir)) {
      fs.mkdirSync(dbDir, { recursive: true, mode: 0o700 });
    } else {
      tryChmod(dbDir, 0o700);
    }
  }

  const db = new Database(dbPath, readonly ? { readonly: true } : undefined);
  try {
    // Best-effort tighten; no-op when already correct or unsupported.
    applySecureFileMode(dbPath);

    if (!readonly) {
      db.pragma('journal_mode = WAL');
    }

    const busyTimeout = parseInt(process.env.EPISODIC_MEMORY_DB_BUSY_TIMEOUT_MS || '5000', 10);
    db.pragma(
      `busy_timeout = ${Number.isFinite(busyTimeout) && busyTimeout >= 0 ? busyTimeout : 5000}`
    );

    if (migrate) {
      migrateLearningSchema(db);
    }

    return db;
  } catch (err) {
    db.close();
    throw err;
  }
}
