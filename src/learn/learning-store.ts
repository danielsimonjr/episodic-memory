/**
 * The learning trace database: `<configDir>/learned/learning.sqlite`.
 *
 * The file is the plugin's own database. The module opens the file directly with
 * the node:sqlite adapter. A SessionStart hook can then read the rendered learned block
 * without opening the
 * knowledge store (§6.3 of the Recursa spec). The file sits beside `knowledge.db` under
 * `learned/`, a sibling of `conversation-index/`, so an index reset never
 * reaches the file.
 *
 * The module creates `knowledge_snapshot` and `learned_block`. The function
 * `ensureLearningSchema` in `learning-db.ts` creates the `learning_*` tables (runs,
 * tasks and attempts).
 */

import { Database } from '../sqlite.js';
import fs from 'fs';
import path from 'path';
import { getLearningDbPath, tryChmod } from '../paths.js';
import { ensureLearningSchema } from './learning-db.js';

/** The tables of the learning trace database, in the order that migrateLearningSchema creates them. */
export const LEARNING_TABLES = [
  'knowledge_snapshot',
  'learned_block',
  'learning_run',
  'learning_task',
  'learning_attempt',
] as const;

/** Options for openLearningDb. */
export interface OpenLearningDbOptions {
  /** Open read-only. Implies `migrate: false`. */
  readonly?: boolean;
  /** Override the file path (tests, and the hook's explicit path). */
  path?: string;
  /**
   * `openLearningDb` runs the schema statements when this value is true, which is the
   * default for a writable handle. A read-only handle always skips them, because
   * `CREATE TABLE` against a read-only handle raises SQLITE_READONLY.
   */
  migrate?: boolean;
}

function applySecureFileMode(dbPath: string): void {
  tryChmod(dbPath, 0o600);
  tryChmod(`${dbPath}-wal`, 0o600);
  tryChmod(`${dbPath}-shm`, 0o600);
}

/**
 * Create the learning tables if they do not exist.
 *
 * The function creates `knowledge_snapshot` and `learned_block`, and then the `learning_*` tables.
 * Running the function again has no effect.
 */
export function migrateLearningSchema(db: Database): void {
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
 * never migrates. The hook opens the file read-only, and the file may pre-date a
 * schema change. SQLite refuses DDL on a read-only connection.
 */
export function openLearningDb(options: OpenLearningDbOptions = {}): Database {
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
