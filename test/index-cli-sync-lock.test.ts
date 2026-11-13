import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { acquireLock, releaseLock, type LockHandle } from '../src/lockfile.js';
import { safeRmSync } from './test-utils.js';

// index-cli and the sync worker write the same index and archive. While one of them runs, the other must not start.
// Ported from upstream f1bcef6. The fork exits 75 (EX_TEMPFAIL) where upstream exits 0, because the exit code of
// index-cli reaches the caller and a skipped rebuild or repair is not a success.

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const INDEX_CLI = join(REPO_ROOT, 'dist', 'index-cli.js');

let home: string;
let held: LockHandle | null = null;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'em-index-lock-'));
});

afterEach(() => {
  if (held) {
    releaseLock(held);
    held = null;
  }
  safeRmSync(home);
});

/**
 * The lock file of the sync worker. The test names the file independently of getSyncLockPath, because the name is
 * an on-disk contract between installed versions. The fork keeps the lock in the index folder, not in logs/.
 */
const lockPath = () => join(home, 'cfg', 'conversation-index', '.sync.lock');

/** Run index-cli in an empty home. Every path variable points into the temporary folder. */
function run(args: string[]) {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    EPISODIC_MEMORY_CONFIG_DIR: join(home, 'cfg'),
    CLAUDE_CONFIG_DIR: join(home, 'claude'),
    CODEX_HOME: join(home, 'codex'),
    XDG_CONFIG_HOME: join(home, 'xdg'),
  };
  for (const key of ['EPISODIC_MEMORY_SUMMARIZER_GUARD', 'EPISODIC_MEMORY_DB_PATH', 'PERSONAL_SUPERPOWERS_DIR',
    'TEST_DB_PATH', 'TEST_ARCHIVE_DIR', 'TEST_PROJECTS_DIR', 'CONVERSATION_SEARCH_EXCLUDE_PROJECTS']) {
    delete env[key];
  }
  return spawnSync(process.execPath, [INDEX_CLI, ...args], { env, timeout: 60000, encoding: 'utf-8' });
}

/** Plant a marker index file and a summary file. rebuild deletes both; a skipped run leaves both. */
function plantIndex(): { db: string; summary: string } {
  mkdirSync(join(home, 'cfg', 'conversation-index'), { recursive: true });
  mkdirSync(join(home, 'cfg', 'conversation-archive', 'proj'), { recursive: true });
  const db = join(home, 'cfg', 'conversation-index', 'db.sqlite');
  const summary = join(home, 'cfg', 'conversation-archive', 'proj', 'x-summary.txt');
  writeFileSync(db, 'marker');
  writeFileSync(summary, 'a summary');
  return { db, summary };
}

function holdSyncLock(): void {
  mkdirSync(dirname(lockPath()), { recursive: true });
  held = acquireLock(lockPath());
  expect(held).not.toBeNull();
}

describe('index-cli takes the sync lock', () => {
  it('skips rebuild with exit 75 while a sync holds the lock, and deletes nothing', () => {
    const planted = plantIndex();
    holdSyncLock();
    const r = run(['rebuild', '--yes', '--no-summaries']);
    expect(r.status).toBe(75);
    expect(r.stderr).toContain(`pid ${process.pid}`);
    expect(r.stdout).not.toMatch(/Rebuilding entire index/);
    expect(readFileSync(planted.db, 'utf-8')).toBe('marker');
    expect(existsSync(planted.summary)).toBe(true);
  });

  it('skips verify, which opens and migrates the database, while a sync holds the lock', () => {
    holdSyncLock();
    const r = run(['verify']);
    expect(r.status).toBe(75);
    expect(r.stdout).not.toMatch(/Verifying conversation index/);
    expect(existsSync(join(home, 'cfg', 'conversation-index', 'db.sqlite'))).toBe(false);
  });

  it('runs and releases the lock when no sync holds the lock', () => {
    const r = run(['verify']);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/Verification Results/);
    expect(existsSync(lockPath())).toBe(false);
  });

  it('releases the lock when a command exits non-zero', () => {
    const failed = run(['index-session']);
    expect(failed.status).toBe(1);
    expect(failed.stderr).toMatch(/Usage: index-cli index-session <session-id>/);
    expect(existsSync(lockPath())).toBe(false);
    const next = run(['verify']);
    expect(next.status).toBe(0);
  });

  it('checks the arguments before the lock, so a refusal exits 2 also while a sync runs', () => {
    holdSyncLock();
    const r = run(['no-such-command']);
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/unknown command no-such-command/);
  });
});
