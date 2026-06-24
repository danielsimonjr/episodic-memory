import { describe, expect, it, afterEach } from 'vitest';
import fs from 'fs';
import { mkdtempSync, rmSync } from 'fs';
import { join, basename } from 'path';
import { tmpdir } from 'os';
import {
  formatLogLine,
  getLogDir,
  getSyncLogPath,
  getSyncLockPath,
  rotateSyncLogIfNeeded,
} from '../src/logging.js';

describe('diagnostic logging paths', () => {
  let testDir: string | undefined;
  const originalConfigDir = process.env.EPISODIC_MEMORY_CONFIG_DIR;

  afterEach(() => {
    if (originalConfigDir === undefined) delete process.env.EPISODIC_MEMORY_CONFIG_DIR;
    else process.env.EPISODIC_MEMORY_CONFIG_DIR = originalConfigDir;
    if (testDir) rmSync(testDir, { recursive: true, force: true });
    testDir = undefined;
  });

  it('stores hook and background sync logs under the memory config directory', () => {
    testDir = mkdtempSync(join(tmpdir(), 'em-logs-'));
    process.env.EPISODIC_MEMORY_CONFIG_DIR = testDir;

    expect(getLogDir()).toBe(join(testDir, 'logs'));
    expect(getSyncLogPath()).toBe(join(testDir, 'logs', 'episodic-memory.log'));
  });

  it('formats log lines with timestamp, level, and message', () => {
    const line = formatLogLine('error', 'Codex hook failed');

    expect(line).toMatch(/^\d{4}-\d{2}-\d{2}T.*Z \[error\] Codex hook failed\n$/);
  });

  it('points the sync lock at a .sync.lock under the index dir', () => {
    testDir = mkdtempSync(join(tmpdir(), 'em-logs-'));
    process.env.EPISODIC_MEMORY_CONFIG_DIR = testDir;

    expect(basename(getSyncLockPath())).toBe('.sync.lock');
    expect(getSyncLockPath()).toContain('conversation-index');
  });

  it('rotates the sync log to .1 once it exceeds the size cap (F4)', () => {
    testDir = mkdtempSync(join(tmpdir(), 'em-logs-'));
    process.env.EPISODIC_MEMORY_CONFIG_DIR = testDir;
    const logPath = getSyncLogPath();
    getLogDir(); // ensure the logs dir exists
    fs.writeFileSync(logPath, 'x'.repeat(2000), 'utf-8');

    rotateSyncLogIfNeeded(1000);

    expect(fs.existsSync(logPath + '.1')).toBe(true);
    expect(fs.existsSync(logPath)).toBe(false); // moved aside; next append recreates it
  });

  it('leaves a small sync log untouched and is a no-op when none exists', () => {
    testDir = mkdtempSync(join(tmpdir(), 'em-logs-'));
    process.env.EPISODIC_MEMORY_CONFIG_DIR = testDir;
    getLogDir();
    expect(() => rotateSyncLogIfNeeded(1000)).not.toThrow(); // no log yet

    const logPath = getSyncLogPath();
    fs.writeFileSync(logPath, 'small', 'utf-8');
    rotateSyncLogIfNeeded(1000);

    expect(fs.existsSync(logPath)).toBe(true);
    expect(fs.existsSync(logPath + '.1')).toBe(false);
  });
});
