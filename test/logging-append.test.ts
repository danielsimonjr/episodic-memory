import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { appendLogLine, getSyncLogPath, getSyncErrorsLogPath } from '../src/logging.js';
import { safeRmSync } from './test-utils.js';

describe('appendLogLine', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'em-append-log-'));
    process.env.EPISODIC_MEMORY_CONFIG_DIR = testDir;
  });

  afterEach(() => {
    delete process.env.EPISODIC_MEMORY_CONFIG_DIR;
    safeRmSync(testDir);
  });

  it('appends a formatted line to the sync log', () => {
    appendLogLine('warn', 'something happened');
    const text = fs.readFileSync(getSyncLogPath(), 'utf-8');
    expect(text).toMatch(/\[warn\] something happened/);
    expect(getSyncErrorsLogPath()).toBe(path.join(testDir, 'sync-errors.log'));
  });
});
