import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { acquireLock, releaseLock, isProcessAlive } from '../src/lockfile.js';
import { safeRmSync } from './test-utils.js';

let dir: string;
let lockPath: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'em-lock-'));
  lockPath = path.join(dir, 'x.lock');
});

afterEach(() => safeRmSync(dir));

const ONE_HOUR = 60 * 60 * 1000;

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
