import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { acquireLock, acquireRefreshedLock, releaseLock, isProcessAlive, keepLockFresh } from '../src/lockfile.js';
import { safeRmSync } from './test-utils.js';

let dir: string;
let lockPath: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'em-lock-'));
  lockPath = path.join(dir, 'x.lock');
});

afterEach(() => safeRmSync(dir));

const ONE_HOUR = 60 * 60 * 1000;

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

// A holder that runs longer than the stale window keeps the lock only when the holder refreshes the lock file.
// The tests use a short stale window. The holder is this process, so its PID is alive in every check.
describe('keepLockFresh', () => {
  const STALE_MS = 400;

  it('keeps a lock past the stale window while the holder refreshes the file', async () => {
    const held = acquireLock(lockPath, STALE_MS)!;
    expect(held).not.toBeNull();
    keepLockFresh(held, 50);
    try {
      await sleep(STALE_MS * 2);
      expect(Date.now() - fs.statSync(lockPath).mtimeMs).toBeLessThan(STALE_MS);
      expect(acquireLock(lockPath, STALE_MS)).toBeNull();
    } finally {
      releaseLock(held);
    }
  });

  it('loses a lock past the stale window without the refresh (the control)', async () => {
    const held = acquireLock(lockPath, STALE_MS)!;
    expect(held).not.toBeNull();
    await sleep(STALE_MS * 2);
    const second = acquireLock(lockPath, STALE_MS);
    expect(second).not.toBeNull();
    releaseLock(second!);
    releaseLock(held);
  });

  it('stops the refresh at release, so the closed descriptor is never touched again', async () => {
    // A descriptor number is reused after the close. A refresh after the release could touch another file.
    const touch = vi.spyOn(fs, 'futimesSync');
    try {
      const held = acquireLock(lockPath, STALE_MS)!;
      keepLockFresh(held, 20);
      await sleep(100);
      expect(touch.mock.calls.length).toBeGreaterThan(0);
      releaseLock(held);
      const atRelease = touch.mock.calls.length;
      await sleep(150);
      expect(touch.mock.calls.length).toBe(atRelease);
    } finally {
      touch.mockRestore();
    }
  });

  it('acquireRefreshedLock keeps its lock past the stale window, and returns null for a held lock', async () => {
    const held = acquireRefreshedLock(lockPath, STALE_MS)!;
    expect(held).not.toBeNull();
    try {
      await sleep(STALE_MS * 2);
      expect(acquireRefreshedLock(lockPath, STALE_MS)).toBeNull();
    } finally {
      releaseLock(held);
    }
  });

  it('the three holders of the sync lock take the refreshed lock', () => {
    // A wiring guard. No test can run a holder for an hour, so the test reads the call sites.
    for (const file of ['src/sync-cli.ts', 'src/index-cli.ts', 'src/backfill-cli.ts']) {
      const source = fs.readFileSync(path.join(__dirname, '..', file), 'utf-8');
      expect(source, file).toMatch(/acquireRefreshedLock\((getSyncLockPath\(\)|syncLockPath)\)/);
      expect(source, file).not.toMatch(/\bacquireLock\(/);
    }
  });

  it('does not keep the process alive', () => {
    const held = acquireLock(lockPath, STALE_MS)!;
    keepLockFresh(held, 20);
    try {
      expect(held.heartbeat?.hasRef()).toBe(false);
    } finally {
      releaseLock(held);
    }
  });
});

describe('lockfile', () => {
  it('acquires when free and blocks a second live holder, then re-acquires after release', () => {
    const a = acquireLock(lockPath);
    expect(a).not.toBeNull();
    const b = acquireLock(lockPath);
    expect(b).toBeNull();
    releaseLock(a!);
    const c = acquireLock(lockPath);
    expect(c).not.toBeNull();
    releaseLock(c!);
  });

  it('steals a lock held by a dead PID', () => {
    fs.writeFileSync(lockPath, '2147480000'); // a PID that is almost certainly not running
    const a = acquireLock(lockPath);
    expect(a).not.toBeNull();
    releaseLock(a!);
  });

  it('steals a lock older than the stale window even when its PID looks alive (PID-reuse guard, F12)', () => {
    fs.writeFileSync(lockPath, String(process.pid)); // our own PID => "alive"
    const old = new Date(Date.now() - 2 * ONE_HOUR);
    fs.utimesSync(lockPath, old, old);
    const a = acquireLock(lockPath, ONE_HOUR);
    expect(a).not.toBeNull();
    releaseLock(a!);
  });

  it('does NOT steal a fresh lock held by a live PID', () => {
    fs.writeFileSync(lockPath, String(process.pid));
    const a = acquireLock(lockPath, ONE_HOUR);
    expect(a).toBeNull();
  });

  // The holder creates the file, then writes its PID. A second process that reads the file between
  // the two steps sees no PID. The file is then a lock that its holder is still writing.
  it('does NOT steal a fresh lock file that holds no PID yet', () => {
    fs.writeFileSync(lockPath, '');
    expect(acquireLock(lockPath, ONE_HOUR)).toBeNull();
    expect(fs.readFileSync(lockPath, 'utf-8')).toBe('');
  });

  it('steals a lock file with no PID once the file is older than the write grace', () => {
    fs.writeFileSync(lockPath, '');
    const old = new Date(Date.now() - 60 * 1000);
    fs.utimesSync(lockPath, old, old);
    const a = acquireLock(lockPath, ONE_HOUR);
    expect(a).not.toBeNull();
    releaseLock(a!);
  });

  it('releaseLock does not delete a lock now owned by a different process (post-steal safety)', () => {
    const a = acquireLock(lockPath);
    expect(a).not.toBeNull();
    // Simulate our lock having gone stale and been stolen: the file now holds
    // another PID. Releasing our handle must NOT remove the new owner's lock.
    fs.writeFileSync(lockPath, '2147480001', 'utf-8');
    releaseLock(a!);
    expect(fs.existsSync(lockPath)).toBe(true);
  });

  it('isProcessAlive: true for the current process, false for an unused PID', () => {
    expect(isProcessAlive(process.pid)).toBe(true);
    expect(isProcessAlive(2147480000)).toBe(false);
  });
});
