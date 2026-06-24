import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import fs from 'fs';
import os from 'os';
import { safeRmSync } from './test-utils.js';
import { getSyncLockPath } from '../src/logging.js';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SYNC_CLI = join(REPO_ROOT, 'dist', 'sync-cli.js');

// Integration test against the built dist artifact (like sync-cli-reentrancy).
describe('sync-cli concurrency lock', () => {
  let dir: string;
  let prevConfigDir: string | undefined;

  beforeEach(() => {
    dir = fs.mkdtempSync(join(os.tmpdir(), 'em-synclock-'));
    prevConfigDir = process.env.EPISODIC_MEMORY_CONFIG_DIR;
    process.env.EPISODIC_MEMORY_CONFIG_DIR = dir;
  });

  afterEach(() => {
    if (prevConfigDir === undefined) delete process.env.EPISODIC_MEMORY_CONFIG_DIR;
    else process.env.EPISODIC_MEMORY_CONFIG_DIR = prevConfigDir;
    safeRmSync(dir);
  });

  it('bails out fast (exit 0) when a live lock is already held, without starting the heavy sync', () => {
    // Pre-place a lock held by THIS (live) process so the spawned worker must skip.
    const lockPath = getSyncLockPath();
    fs.mkdirSync(dirname(lockPath), { recursive: true });
    fs.writeFileSync(lockPath, String(process.pid), 'utf-8');

    const result = spawnSync(process.execPath, [SYNC_CLI], {
      env: { ...process.env, EPISODIC_MEMORY_CONFIG_DIR: dir },
      timeout: 15000,
      encoding: 'utf-8',
    });

    expect(result.status).toBe(0);
    expect(result.stderr).toMatch(/another sync is already running/i);
    expect(result.stdout).not.toMatch(/Syncing conversations/);
  });
});
