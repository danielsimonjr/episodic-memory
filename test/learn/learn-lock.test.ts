import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import { spawnSync } from 'child_process';
import os from 'os';
import path from 'path';
import {
  withLearnLock,
  readLearnPids,
  LearnLockHeld,
  getLearnLockPath,
  getLearnPidsPath,
} from '../../src/learn/learn-lock.js';
import { getIndexDir } from '../../src/paths.js';
import { safeRmSync } from '../test-utils.js';

let dir: string;
const savedConfig = process.env.EPISODIC_MEMORY_CONFIG_DIR;

beforeEach(() => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'em-learn-lock-')));
  process.env.EPISODIC_MEMORY_CONFIG_DIR = dir;
});

afterEach(() => {
  if (savedConfig === undefined) delete process.env.EPISODIC_MEMORY_CONFIG_DIR;
  else process.env.EPISODIC_MEMORY_CONFIG_DIR = savedConfig;
  safeRmSync(dir);
});

describe('.learn.lock', () => {
  it('lives in the index directory and is released when the work finishes', async () => {
    const lockPath = getLearnLockPath(getIndexDir());
    expect(path.dirname(lockPath)).toBe(path.join(dir, 'conversation-index'));

    const seen = await withLearnLock(async () => fs.existsSync(lockPath));
    expect(seen).toBe(true);
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  it('a second run while the first is live throws LearnLockHeld naming the holder PID', async () => {
    const first = withLearnLock(async () => {
      await new Promise(resolve => setTimeout(resolve, 120));
    });

    const error = await withLearnLock(async () => 'never').catch(err => err);

    expect(error).toBeInstanceOf(LearnLockHeld);
    expect((error as Error).message).toContain(String(process.pid));
    expect((error as LearnLockHeld).holderPid).toBe(process.pid);

    await first;
    // Free again once the holder released it.
    await expect(withLearnLock(async () => 'ok')).resolves.toBe('ok');
  });

  it('refreshes the lock file while the work runs, so a run longer than the steal age keeps its lock', async () => {
    // A learn run has no hard stop. Without the refresh, a run older than LEARN_LOCK_STALE_MS loses its lock.
    const lockPath = getLearnLockPath(getIndexDir());
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'], now: Date.now() });
    try {
      const moved = await withLearnLock(async () => {
        const before = fs.statSync(lockPath).mtimeMs;
        vi.advanceTimersByTime(31 * 60 * 1000);
        return fs.statSync(lockPath).mtimeMs - before;
      });
      // The refresh at 30 minutes sets the mtime from the fake clock. The file got its first mtime a few ms after the clock started.
      expect(moved).toBeGreaterThan(25 * 60 * 1000);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('releases the lock even when the work throws', async () => {
    await expect(
      withLearnLock(async () => {
        throw new Error('boom');
      })
    ).rejects.toThrow('boom');
    await expect(withLearnLock(async () => 'ok')).resolves.toBe('ok');
  });
});

describe('.learn.pids', () => {
  it('writes one PID per line on add and remove, and removes the file on release', async () => {
    let pidsPath = '';
    await withLearnLock(async pids => {
      pidsPath = getLearnPidsPath(getIndexDir());
      pids.add(1111);
      pids.add(2222);
      expect(fs.readFileSync(pidsPath, 'utf-8').trim().split('\n')).toEqual(['1111', '2222']);

      pids.remove(1111);
      expect(readLearnPids(getIndexDir())).toEqual(new Set([2222]));
    });

    expect(fs.existsSync(pidsPath)).toBe(false);
    expect(readLearnPids(getIndexDir())).toEqual(new Set());
  });

  it('removes the file even when the work throws', async () => {
    await expect(
      withLearnLock(async pids => {
        pids.add(4242);
        throw new Error('boom');
      })
    ).rejects.toThrow('boom');
    expect(readLearnPids(getIndexDir())).toEqual(new Set());
  });

  it('readLearnPids is empty when the file is absent or garbage', () => {
    const missing = getLearnPidsPath(getIndexDir());
    expect(readLearnPids(getIndexDir())).toEqual(new Set());

    // A live run holds the lock, so the file is read.
    fs.writeFileSync(getLearnLockPath(getIndexDir()), String(process.pid), 'utf-8');

    fs.writeFileSync(missing, 'not-a-pid\n\n33\n', 'utf-8');
    expect(readLearnPids(getIndexDir())).toEqual(new Set([33]));

    fs.writeFileSync(missing, 'abc\n-5\n0\n77', 'utf-8');
    expect(readLearnPids(getIndexDir())).toEqual(new Set([77]));
  });

  it('readLearnPids is empty when no live run holds the lock', () => {
    const pidsPath = getLearnPidsPath(getIndexDir());
    const lockPath = getLearnLockPath(getIndexDir());
    fs.mkdirSync(path.dirname(pidsPath), { recursive: true });
    fs.writeFileSync(pidsPath, '555\n', 'utf-8');

    // A killed run leaves the file and no lock.
    expect(readLearnPids(getIndexDir())).toEqual(new Set());

    // A killed run leaves the file and a lock whose holder is dead.
    const dead = spawnSync(process.execPath, ['-e', '']).pid as number;
    fs.writeFileSync(lockPath, String(dead), 'utf-8');
    expect(readLearnPids(getIndexDir())).toEqual(new Set());

    // A live holder makes the file count again.
    fs.writeFileSync(lockPath, String(process.pid), 'utf-8');
    expect(readLearnPids(getIndexDir())).toEqual(new Set([555]));
  });

  it('readLearnPids keeps protecting a live run whose lock is older than the steal age', () => {
    const pidsPath = getLearnPidsPath(getIndexDir());
    const lockPath = getLearnLockPath(getIndexDir());
    fs.mkdirSync(path.dirname(pidsPath), { recursive: true });
    fs.writeFileSync(pidsPath, '555\n', 'utf-8');
    fs.writeFileSync(lockPath, String(process.pid), 'utf-8');
    // One step of a run can outlast the two-hour steal age while its holder is alive.
    const old = new Date(Date.now() - 3 * 60 * 60 * 1000);
    fs.utimesSync(lockPath, old, old);

    expect(readLearnPids(getIndexDir())).toEqual(new Set([555]));
  });

  it('withLearnLock deletes a pid file that a killed run left before the work starts', async () => {
    const pidsPath = getLearnPidsPath(getIndexDir());
    fs.mkdirSync(path.dirname(pidsPath), { recursive: true });
    fs.writeFileSync(pidsPath, '555\n', 'utf-8');

    const leftOver = await withLearnLock(async () => fs.existsSync(pidsPath));
    expect(leftOver).toBe(false);
  });
});
