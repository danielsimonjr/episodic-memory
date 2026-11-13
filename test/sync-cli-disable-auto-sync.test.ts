import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import fs from 'fs';
import os from 'os';
import { safeRmSync } from './test-utils.js';
import { getSyncLockPath, getSyncLogPath } from '../src/logging.js';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SYNC_CLI = join(REPO_ROOT, 'dist', 'sync-cli.js');

// EPISODIC_MEMORY_DISABLE_AUTO_SYNC=1 stops the background sync that the SessionStart hook starts.
// A sync that runs in the foreground still works. Ported from upstream fd8f839.
// Each test places a held sync lock first. A worker that starts by mistake therefore exits at once.
describe('sync-cli EPISODIC_MEMORY_DISABLE_AUTO_SYNC', () => {
  let dir: string;
  let prevConfigDir: string | undefined;

  beforeEach(() => {
    dir = fs.mkdtempSync(join(os.tmpdir(), 'em-noautosync-'));
    prevConfigDir = process.env.EPISODIC_MEMORY_CONFIG_DIR;
    process.env.EPISODIC_MEMORY_CONFIG_DIR = dir;
    const lockPath = getSyncLockPath();
    fs.mkdirSync(dirname(lockPath), { recursive: true });
    fs.writeFileSync(lockPath, String(process.pid), 'utf-8');
  });

  // A background run starts a detached worker. The worker writes to the sync log. The worker exits on the held lock.
  // The wait keeps the cleanup from deleting a folder that a worker still uses.
  async function waitForWorkerExit(): Promise<string> {
    const deadline = Date.now() + 15000;
    let log = '';
    while (Date.now() < deadline) {
      log = fs.existsSync(getSyncLogPath()) ? fs.readFileSync(getSyncLogPath(), 'utf-8') : '';
      if (log === '' || /another sync or index command is running/.test(log)) return log;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    return log;
  }

  afterEach(async () => {
    await waitForWorkerExit();
    if (prevConfigDir === undefined) delete process.env.EPISODIC_MEMORY_CONFIG_DIR;
    else process.env.EPISODIC_MEMORY_CONFIG_DIR = prevConfigDir;
    safeRmSync(dir);
  });

  function runSync(args: string[], value: string) {
    return spawnSync(process.execPath, [SYNC_CLI, ...args], {
      env: { ...process.env, EPISODIC_MEMORY_CONFIG_DIR: dir, EPISODIC_MEMORY_DISABLE_AUTO_SYNC: value },
      timeout: 15000,
      encoding: 'utf-8',
    });
  }

  it('exits 0 for sync --background and starts no worker', () => {
    const result = runSync(['--background'], '1');

    expect(result.status).toBe(0);
    expect(result.stderr).toMatch(/auto-sync is off \(EPISODIC_MEMORY_DISABLE_AUTO_SYNC=1\)/);
    expect(result.stdout).not.toMatch(/Sync started in background/);
    expect(fs.existsSync(getSyncLogPath())).toBe(false);
  });

  it('does not stop a sync in the foreground', () => {
    // The held lock makes the foreground worker exit at once.
    // The message from the foreground worker shows that the switch let the sync start.
    const result = runSync([], '1');

    expect(result.status).toBe(0);
    expect(result.stderr).not.toMatch(/auto-sync is off/);
    expect(result.stderr).toMatch(/another sync or index command is running/);
  });

  it('a value other than 1 does not stop the background sync', async () => {
    const result = runSync(['--background'], 'true');

    expect(result.status).toBe(0);
    expect(result.stderr).not.toMatch(/auto-sync is off/);
    expect(result.stdout).toMatch(/Sync started in background/);
    expect(await waitForWorkerExit()).toMatch(/another sync or index command is running/);
  }, 20000);
});
