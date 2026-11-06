import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
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

    fs.writeFileSync(missing, 'not-a-pid\n\n33\n', 'utf-8');
    expect(readLearnPids(getIndexDir())).toEqual(new Set([33]));

    fs.writeFileSync(missing, 'abc\n-5\n0\n77', 'utf-8');
    expect(readLearnPids(getIndexDir())).toEqual(new Set([77]));
  });
});
