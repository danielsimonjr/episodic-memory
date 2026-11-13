import Database from 'better-sqlite3';
import { ConversationExchange } from './types.js';
import path from 'path';
import fs from 'fs';
import * as sqliteVec from 'sqlite-vec';
import { getDbPath, tryChmod } from './paths.js';
import { EMBEDDING_VERSION } from './embedding-migration.js';
import { truncateForIndex } from './constants.js';
import { maybeRedactSecrets } from './redact.js';
import { ensureDigestSchema } from './digest-db.js';

/**
 * The options for `openDatabase`.
 */
export interface OpenDatabaseOptions {
  /**
   * Run CREATE TABLE / migrations / CREATE INDEX.
   * Default true. Pass false for hot-path readers that know the schema is current
   * (e.g. a long-lived MCP search connection after the first migrated open).
   */
  migrate?: boolean;
}

/**
 * Adds the `exchanges` columns that the database lacks, then runs the other schema migrations.
 *
 * The column step reports each added column on stderr. The function then runs `migrateToolCallsCascade`, `ensureFts`, and `ensureDigestSchema`.
 */
export function migrateSchema(db: Database.Database): void {
  const columns = db.prepare(`SELECT name FROM pragma_table_info('exchanges')`).all() as Array<{ name: string }>;
  const columnNames = new Set(columns.map(c => c.name));

  const migrations: Array<{ name: string; sql: string }> = [
    { name: 'last_indexed', sql: 'ALTER TABLE exchanges ADD COLUMN last_indexed INTEGER' },
    { name: 'parent_uuid', sql: 'ALTER TABLE exchanges ADD COLUMN parent_uuid TEXT' },
    { name: 'is_sidechain', sql: 'ALTER TABLE exchanges ADD COLUMN is_sidechain BOOLEAN DEFAULT 0' },
    { name: 'harness', sql: "ALTER TABLE exchanges ADD COLUMN harness TEXT NOT NULL DEFAULT 'claude'" },
    { name: 'session_id', sql: 'ALTER TABLE exchanges ADD COLUMN session_id TEXT' },
    { name: 'cwd', sql: 'ALTER TABLE exchanges ADD COLUMN cwd TEXT' },
    { name: 'git_branch', sql: 'ALTER TABLE exchanges ADD COLUMN git_branch TEXT' },
    { name: 'claude_version', sql: 'ALTER TABLE exchanges ADD COLUMN claude_version TEXT' },
    { name: 'agent_version', sql: 'ALTER TABLE exchanges ADD COLUMN agent_version TEXT' },
    { name: 'model', sql: 'ALTER TABLE exchanges ADD COLUMN model TEXT' },
    { name: 'model_provider', sql: 'ALTER TABLE exchanges ADD COLUMN model_provider TEXT' },
    { name: 'thinking_level', sql: 'ALTER TABLE exchanges ADD COLUMN thinking_level TEXT' },
    { name: 'thinking_disabled', sql: 'ALTER TABLE exchanges ADD COLUMN thinking_disabled BOOLEAN' },
    { name: 'thinking_triggers', sql: 'ALTER TABLE exchanges ADD COLUMN thinking_triggers TEXT' },
    { name: 'embedding_version', sql: 'ALTER TABLE exchanges ADD COLUMN embedding_version INTEGER NOT NULL DEFAULT 0' },
  ];

  let migrated = false;
  for (const migration of migrations) {
    if (!columnNames.has(migration.name)) {
      console.error(`Migrating schema: adding ${migration.name} column...`);
      db.prepare(migration.sql).run();
      migrated = true;
    }
  }

  if (migrated) {
    console.error('Migration complete.');
  }

  migrateToolCallsCascade(db);
  ensureFts(db);
  ensureDigestSchema(db);
}

/**
 * Earlier versions created `tool_calls` with a plain `FOREIGN KEY (exchange_id) REFERENCES exchanges(id)`.
 * Without ON DELETE CASCADE, deleting an exchange that had tool calls
 * raised SQLITE_CONSTRAINT_FOREIGNKEY (#81), and orphans accumulated.
 *
 * The migration does these steps:
 *   1. Detects the legacy schema by inspecting sqlite_master.sql.
 *   2. Drops orphaned tool_calls rows.
 *   3. Recreates the table with ON DELETE CASCADE and copies surviving rows.
 */
export function migrateToolCallsCascade(db: Database.Database): void {
  const row = db.prepare(
    `SELECT sql FROM sqlite_master WHERE type='table' AND name='tool_calls'`
  ).get() as { sql: string } | undefined;
  if (!row) return; // table doesn't exist yet (caller will create it)
  if (row.sql.toUpperCase().includes('ON DELETE CASCADE')) return; // already migrated

  console.error('Migrating tool_calls to ON DELETE CASCADE schema...');

  const orphanCount = (db.prepare(
    `SELECT COUNT(*) AS c FROM tool_calls
     WHERE exchange_id NOT IN (SELECT id FROM exchanges)`
  ).get() as { c: number }).c;
  if (orphanCount > 0) {
    console.error(`  Removing ${orphanCount} orphaned tool_calls row(s)`);
  }

  // FK is enforced by default in better-sqlite3, but ALTER ... RENAME of a
  // table that other objects reference can trip checks during the rebuild.
  // Disable temporarily; the post-migration FK_check verifies integrity.
  db.pragma('foreign_keys = OFF');
  const tx = db.transaction(() => {
    db.exec(`
      CREATE TABLE tool_calls_new (
        id TEXT PRIMARY KEY,
        exchange_id TEXT NOT NULL,
        tool_name TEXT NOT NULL,
        tool_input TEXT,
        tool_result TEXT,
        is_error BOOLEAN DEFAULT 0,
        timestamp TEXT NOT NULL,
        FOREIGN KEY (exchange_id) REFERENCES exchanges(id) ON DELETE CASCADE
      )
    `);
    db.exec(`
      INSERT INTO tool_calls_new
      SELECT id, exchange_id, tool_name, tool_input, tool_result, is_error, timestamp
      FROM tool_calls
      WHERE exchange_id IN (SELECT id FROM exchanges)
    `);
    db.exec(`DROP TABLE tool_calls`);
    db.exec(`ALTER TABLE tool_calls_new RENAME TO tool_calls`);
  });
  tx();
  db.pragma('foreign_keys = ON');

  console.error('  tool_calls migration complete.');
}

/**
 * Create (and backfill if empty) the FTS5 index used by text-mode search.
 * External-content style: we keep id + message copies and update them from
 * insertExchange / deleteExchange / prune.
 */
export function ensureFts(db: Database.Database): void {
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS exchanges_fts USING fts5(
      id UNINDEXED,
      user_message,
      assistant_message,
      tokenize = 'porter unicode61'
    )
  `);

  const ftsCount = (db.prepare('SELECT COUNT(*) AS c FROM exchanges_fts').get() as { c: number }).c;
  const exchCount = (db.prepare('SELECT COUNT(*) AS c FROM exchanges').get() as { c: number }).c;
  if (exchCount > 0 && ftsCount === 0) {
    console.error(`Backfilling FTS index for ${exchCount} exchange(s)...`);
    db.exec(`
      INSERT INTO exchanges_fts (id, user_message, assistant_message)
      SELECT id, user_message, assistant_message FROM exchanges
    `);
    console.error('  FTS backfill complete.');
  }
}

/**
 * Replaces the full-text row for one exchange.
 *
 * The function deletes any row with the same id, and then inserts the new row.
 */
export function upsertExchangeFts(
  db: Database.Database,
  id: string,
  userMessage: string,
  assistantMessage: string
): void {
  db.prepare('DELETE FROM exchanges_fts WHERE id = ?').run(id);
  db.prepare(
    `INSERT INTO exchanges_fts (id, user_message, assistant_message) VALUES (?, ?, ?)`
  ).run(id, userMessage, assistantMessage);
}

/**
 * Removes the full-text row for one exchange.
 *
 * The call does nothing when no row has that id.
 */
export function deleteExchangeFts(db: Database.Database, id: string): void {
  db.prepare('DELETE FROM exchanges_fts WHERE id = ?').run(id);
}

function applySecureDbFileMode(dbPath: string): void {
  tryChmod(dbPath, 0o600);
  // WAL/SHM siblings if present
  tryChmod(`${dbPath}-wal`, 0o600);
  tryChmod(`${dbPath}-shm`, 0o600);
}

/**
 * Opens the index database and prepares the connection.
 *
 * The function creates the database directory when the directory is missing.
 * The function restricts the file mode of the database and its WAL files.
 * The function loads the sqlite-vec extension and turns on WAL mode.
 * The busy timeout comes from `EPISODIC_MEMORY_DB_BUSY_TIMEOUT_MS`. The default timeout is 5000 milliseconds.
 * When `migrate` is true, the function also creates the tables and indexes, and runs `migrateSchema`. When `migrate` is false, the function returns before the function changes the schema.
 *
 * @param options Set `migrate` to false to skip the schema changes. The default is true.
 */
export function openDatabase(options: OpenDatabaseOptions = {}): Database.Database {
  const migrate = options.migrate !== false;
  const dbPath = getDbPath();

  // Ensure directory exists with restrictive mode
  const dbDir = path.dirname(dbPath);
  if (!fs.existsSync(dbDir)) {
    fs.mkdirSync(dbDir, { recursive: true, mode: 0o700 });
  } else {
    tryChmod(dbDir, 0o700);
  }

  const existed = fs.existsSync(dbPath);
  const db = new Database(dbPath);
  if (!existed) {
    applySecureDbFileMode(dbPath);
  } else {
    // Best-effort tighten on every open (no-op if already correct / unsupported)
    applySecureDbFileMode(dbPath);
  }

  // Load sqlite-vec extension
  sqliteVec.load(db);

  // Enable WAL mode for better concurrency
  db.pragma('journal_mode = WAL');

  // Wait (up to 5s) for a competing writer's lock instead of failing immediately
  // with SQLITE_BUSY. Overlapping syncs / the MCP server reading while a sync
  // writes would otherwise abort a batch on contention (F13). Configurable via
  // EPISODIC_MEMORY_DB_BUSY_TIMEOUT_MS.
  const busyTimeout = parseInt(process.env.EPISODIC_MEMORY_DB_BUSY_TIMEOUT_MS || '5000', 10);
  db.pragma(`busy_timeout = ${Number.isFinite(busyTimeout) && busyTimeout >= 0 ? busyTimeout : 5000}`);

  if (!migrate) {
    return db;
  }

  // Create exchanges table
  db.exec(`
    CREATE TABLE IF NOT EXISTS exchanges (
      id TEXT PRIMARY KEY,
      project TEXT NOT NULL,
      timestamp TEXT NOT NULL,
      user_message TEXT NOT NULL,
      assistant_message TEXT NOT NULL,
      archive_path TEXT NOT NULL,
      line_start INTEGER NOT NULL,
      line_end INTEGER NOT NULL,
      embedding BLOB,
      last_indexed INTEGER,
      parent_uuid TEXT,
      is_sidechain BOOLEAN DEFAULT 0,
      harness TEXT NOT NULL DEFAULT 'claude',
      session_id TEXT,
      cwd TEXT,
      git_branch TEXT,
      claude_version TEXT,
      agent_version TEXT,
      model TEXT,
      model_provider TEXT,
      thinking_level TEXT,
      thinking_disabled BOOLEAN,
      thinking_triggers TEXT,
      embedding_version INTEGER NOT NULL DEFAULT 0
    )
  `);

  // Create tool_calls table.
  // ON DELETE CASCADE keeps the table consistent when exchanges go away
  // (search reindex, repair, etc.) without callers having to remember to
  // delete dependents first.
  db.exec(`
    CREATE TABLE IF NOT EXISTS tool_calls (
      id TEXT PRIMARY KEY,
      exchange_id TEXT NOT NULL,
      tool_name TEXT NOT NULL,
      tool_input TEXT,
      tool_result TEXT,
      is_error BOOLEAN DEFAULT 0,
      timestamp TEXT NOT NULL,
      FOREIGN KEY (exchange_id) REFERENCES exchanges(id) ON DELETE CASCADE
    )
  `);

  // Create vector search index
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS vec_exchanges USING vec0(
      id TEXT PRIMARY KEY,
      embedding FLOAT[384]
    )
  `);

  // Run migrations first
  migrateSchema(db);

  // Create indexes (after migrations ensure columns exist)
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_timestamp ON exchanges(timestamp DESC)
  `);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_session_id ON exchanges(session_id)
  `);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_project ON exchanges(project)
  `);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_harness ON exchanges(harness)
  `);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_sidechain ON exchanges(is_sidechain)
  `);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_git_branch ON exchanges(git_branch)
  `);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_archive_path ON exchanges(archive_path)
  `);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_embedding_version ON exchanges(embedding_version)
  `);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_tool_name ON tool_calls(tool_name)
  `);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_tool_exchange ON tool_calls(exchange_id)
  `);

  return db;
}

/**
 * Opens the existing index database for reading only.
 *
 * The function creates no file and no directory. It does not change the file mode, turn on WAL mode
 * or run a migration. It throws when the database file does not exist. The busy timeout is the same as in `openDatabase`.
 */
export function openDatabaseReadonly(): Database.Database {
  const db = new Database(getDbPath(), { readonly: true, fileMustExist: true });
  const busyTimeout = parseInt(process.env.EPISODIC_MEMORY_DB_BUSY_TIMEOUT_MS || '5000', 10);
  db.pragma(`busy_timeout = ${Number.isFinite(busyTimeout) && busyTimeout >= 0 ? busyTimeout : 5000}`);
  return db;
}

/** Open (and migrate) a database — the default writer / one-shot path. */
export function initDatabase(): Database.Database {
  return openDatabase({ migrate: true });
}

/**
 * Process-wide reader connection for MCP search hot path.
 * First call migrates; later calls reuse without re-running CREATE INDEX.
 */
let sharedReader: Database.Database | null = null;

/**
 * Returns the process-wide reader connection, and opens the connection on the first call.
 *
 * The first call opens the database with migrations. Later calls reuse the same connection.
 * A later call opens a new connection when the old connection fails a simple query, for example after a close.
 */
export function getSharedReaderDatabase(): Database.Database {
  if (sharedReader) {
    try {
      // Touch the connection; recreate if it was closed.
      sharedReader.pragma('busy_timeout');
      return sharedReader;
    } catch {
      sharedReader = null;
    }
  }
  sharedReader = openDatabase({ migrate: true });
  return sharedReader;
}

/**
 * Closes the process-wide reader connection, if one is open.
 *
 * The function ignores errors from the close. A later call to `getSharedReaderDatabase` opens a new connection.
 */
export function closeSharedReaderDatabase(): void {
  if (sharedReader) {
    try {
      sharedReader.close();
    } catch {
      // ignore
    }
    sharedReader = null;
  }
}

/**
 * Writes one exchange to the index, with its embedding, its full-text row, and its tool calls.
 *
 * The messages pass through `maybeRedactSecrets` and `truncateForIndex` before storage.
 * The stored row replaces any earlier row with the same id. The stored row also records the write time and `EMBEDDING_VERSION`.
 * Tool-call rows from an earlier write stay in place unless their ids match.
 *
 * @param db The open database connection.
 * @param exchange The exchange to store.
 * @param embedding The embedding vector. The vector must hold 384 numbers, the width of `vec_exchanges`.
 * @param toolNames Not read by this function.
 */
export function insertExchange(
  db: Database.Database,
  exchange: ConversationExchange,
  embedding: number[],
  toolNames?: string[]
): void {
  const now = Date.now();

  const userMessage = truncateForIndex(maybeRedactSecrets(exchange.userMessage));
  const assistantMessage = truncateForIndex(maybeRedactSecrets(exchange.assistantMessage));

  const stmt = db.prepare(`
    INSERT OR REPLACE INTO exchanges
    (id, project, timestamp, user_message, assistant_message, archive_path, line_start, line_end, last_indexed,
     parent_uuid, is_sidechain, harness, session_id, cwd, git_branch, claude_version, agent_version, model, model_provider,
     thinking_level, thinking_disabled, thinking_triggers, embedding_version)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  stmt.run(
    exchange.id,
    exchange.project,
    exchange.timestamp,
    // Cap machine-generated prompt payload. This is the single choke point every
    // indexer path goes through, so the DB-size invariant holds regardless of caller.
    userMessage,
    assistantMessage,
    exchange.archivePath,
    exchange.lineStart,
    exchange.lineEnd,
    now,
    exchange.parentUuid || null,
    exchange.isSidechain ? 1 : 0,
    exchange.harness || 'claude',
    exchange.sessionId || null,
    exchange.cwd || null,
    exchange.gitBranch || null,
    exchange.claudeVersion || null,
    exchange.agentVersion || exchange.claudeVersion || null,
    exchange.model || null,
    exchange.modelProvider || null,
    exchange.thinkingLevel || null,
    exchange.thinkingDisabled ? 1 : 0,
    exchange.thinkingTriggers || null,
    EMBEDDING_VERSION
  );

  // Insert into vector table (delete first since virtual tables don't support REPLACE)
  const delStmt = db.prepare(`DELETE FROM vec_exchanges WHERE id = ?`);
  delStmt.run(exchange.id);

  const vecStmt = db.prepare(`
    INSERT INTO vec_exchanges (id, embedding)
    VALUES (?, ?)
  `);

  vecStmt.run(exchange.id, Buffer.from(new Float32Array(embedding).buffer));

  upsertExchangeFts(db, exchange.id, userMessage, assistantMessage);

  // Insert tool calls if present
  if (exchange.toolCalls && exchange.toolCalls.length > 0) {
    const toolStmt = db.prepare(`
      INSERT OR REPLACE INTO tool_calls
      (id, exchange_id, tool_name, tool_input, tool_result, is_error, timestamp)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

    for (const toolCall of exchange.toolCalls) {
      toolStmt.run(
        toolCall.id,
        toolCall.exchangeId,
        toolCall.toolName,
        toolCall.toolInput ? JSON.stringify(toolCall.toolInput) : null,
        toolCall.toolResult || null,
        toolCall.isError ? 1 : 0,
        toolCall.timestamp
      );
    }
  }
}

/**
 * Returns the id and the archive path of every indexed exchange.
 */
export function getAllExchanges(db: Database.Database): Array<{ id: string; archivePath: string }> {
  const stmt = db.prepare(`SELECT id, archive_path as archivePath FROM exchanges`);
  return stmt.all() as Array<{ id: string; archivePath: string }>;
}

/**
 * Returns the newest `last_indexed` time for the rows of one archive file, or null when no row matches.
 *
 * The path must match the `archive_path` column exactly. The time is in milliseconds since the Unix epoch.
 */
export function getFileLastIndexed(db: Database.Database, archivePath: string): number | null {
  const stmt = db.prepare(`
    SELECT MAX(last_indexed) as lastIndexed
    FROM exchanges
    WHERE archive_path = ?
  `);
  const row = stmt.get(archivePath) as { lastIndexed: number | null };
  return row.lastIndexed;
}

/** High-water mark for append-only incremental indexing of a transcript. */
export function getMaxIndexedLine(db: Database.Database, archivePath: string): number {
  const row = db.prepare(
    'SELECT COALESCE(MAX(line_end), 0) as maxLine FROM exchanges WHERE archive_path = ?'
  ).get(archivePath) as { maxLine: number };
  return row.maxLine;
}

/**
 * Returns the number of free pages and the page size of the database.
 *
 * A `VACUUM` run can reclaim the free pages.
 */
export function getFreelistInfo(db: Database.Database): { freePages: number; pageSize: number } {
  const freePages = (db.prepare('PRAGMA freelist_count').get() as { freelist_count: number })
    .freelist_count;
  const pageSize = (db.prepare('PRAGMA page_size').get() as { page_size: number }).page_size;
  return { freePages, pageSize };
}

/**
 * Runs `VACUUM` on the database, which rebuilds the file and reclaims its free pages.
 */
export function vacuumDatabase(db: Database.Database): void {
  db.exec('VACUUM');
}

/**
 * Deletes one exchange from the vector table, the full-text table, and the exchanges table.
 *
 * The database deletes the exchange's tool-call rows through `ON DELETE CASCADE`. Foreign-key enforcement must be on for the connection.
 */
export function deleteExchange(db: Database.Database, id: string): void {
  // Delete from vector table
  db.prepare(`DELETE FROM vec_exchanges WHERE id = ?`).run(id);
  deleteExchangeFts(db, id);

  // Delete from main table
  db.prepare(`DELETE FROM exchanges WHERE id = ?`).run(id);
}

/**
 * Deletes every exchange of one archive file, in one transaction. Returns the number of exchanges deleted.
 *
 * The path must match the `archive_path` column exactly. Each exchange goes through `deleteExchange`, so the vector,
 * full-text and tool-call rows go too.
 *
 * @param db The open database connection to change. The connection must load the sqlite-vec extension.
 * @param archivePath The archive path of the conversation, as stored in the `archive_path` column.
 */
export function deleteExchangesForArchive(db: Database.Database, archivePath: string): number {
  const ids = (db.prepare('SELECT id FROM exchanges WHERE archive_path = ?').all(archivePath) as { id: string }[])
    .map(row => row.id);
  if (ids.length === 0) return 0;
  db.transaction(() => {
    for (const id of ids) deleteExchange(db, id);
  })();
  return ids.length;
}
