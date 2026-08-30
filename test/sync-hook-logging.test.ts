import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { getSyncErrorsLogPath, formatLogLine } from '../src/logging.js';
import { safeRmSync } from './test-utils.js';

describe('sync hook error logging', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'em-sync-errors-'));
    process.env.EPISODIC_MEMORY_CONFIG_DIR = testDir;
  });

  afterEach(() => {
    delete process.env.EPISODIC_MEMORY_CONFIG_DIR;
    safeRmSync(testDir);
  });

  it('writes sync-errors.log under the config dir', () => {
    const logPath = getSyncErrorsLogPath();
    expect(logPath).toBe(path.join(testDir, 'sync-errors.log'));
    fs.appendFileSync(logPath, formatLogLine('error', 'test failure'), 'utf-8');
    expect(fs.readFileSync(logPath, 'utf-8')).toContain('test failure');
  });
});
