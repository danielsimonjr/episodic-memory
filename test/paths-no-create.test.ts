import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { archiveDirPath, getDbPath, getIndexDir, indexDirPath, superpowersDirPath } from '../src/paths.js';
import { syncErrorsLogPath, syncLogPath } from '../src/logging.js';
import { safeRmSync } from './test-utils.js';

describe('the path functions that create nothing', () => {
  let cfg: string;
  const saved = { cfg: process.env.EPISODIC_MEMORY_CONFIG_DIR, db: process.env.TEST_DB_PATH, archive: process.env.TEST_ARCHIVE_DIR };

  beforeEach(() => {
    cfg = mkdtempSync(join(tmpdir(), 'em-paths-'));
    process.env.EPISODIC_MEMORY_CONFIG_DIR = cfg;
    delete process.env.TEST_DB_PATH;
    delete process.env.TEST_ARCHIVE_DIR;
  });

  afterEach(() => {
    for (const [key, value] of [['EPISODIC_MEMORY_CONFIG_DIR', saved.cfg], ['TEST_DB_PATH', saved.db], ['TEST_ARCHIVE_DIR', saved.archive]] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    safeRmSync(cfg);
  });

  it('return the paths under the config folder and leave the folder empty', () => {
    expect(superpowersDirPath()).toBe(cfg);
    expect(archiveDirPath()).toBe(join(cfg, 'conversation-archive'));
    expect(indexDirPath()).toBe(join(cfg, 'conversation-index'));
    expect(getDbPath()).toBe(join(cfg, 'conversation-index', 'db.sqlite'));
    expect(syncLogPath()).toBe(join(cfg, 'logs', 'episodic-memory.log'));
    expect(syncErrorsLogPath()).toBe(join(cfg, 'sync-errors.log'));
    expect(readdirSync(cfg)).toEqual([]);
  });

  it('getIndexDir still creates its folder for a writer', () => {
    expect(getIndexDir()).toBe(indexDirPath());
    expect(readdirSync(cfg)).toEqual(['conversation-index']);
  });
});
