import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import {
  buildDoctorReport,
  readRecentLogErrors,
  collectDoctorSnapshot,
} from '../src/doctor.js';
import { formatLogLine } from '../src/logging.js';
import { safeRmSync } from './test-utils.js';

const healthy = {
  configDir: '/tmp/cfg',
  archiveDir: '/tmp/cfg/conversation-archive',
  archiveExists: true,
  indexDir: '/tmp/cfg/conversation-index',
  dbPath: '/tmp/cfg/conversation-index/db.sqlite',
  dbExists: true,
  dbSizeBytes: 2048,
  exchangeCount: 10,
  conversationCount: 4,
  currentEmbeddingVersion: 1,
  staleEmbeddingCount: 0,
  syncLogPath: '/tmp/cfg/logs/episodic-memory.log',
  syncErrorsLogPath: '/tmp/cfg/sync-errors.log',
  recentSyncErrors: [] as string[],
  nodeModulesHealthy: true as const,
  pluginRoot: '/tmp/plugin',
};

describe('general doctor report', () => {
  it('is ok when archive, db, and node_modules are healthy', () => {
    const report = buildDoctorReport(healthy);
    expect(report.ok).toBe(true);
    expect(report.text).toContain('Episodic Memory Doctor');
    expect(report.text).toContain('node_modules: healthy');
    expect(report.json.ok).toBe(true);
    expect(report.json.exchangeCount).toBe(10);
  });

  it('fails when the archive or database is missing', () => {
    const report = buildDoctorReport({
      ...healthy,
      archiveExists: false,
      dbExists: false,
    });
    expect(report.ok).toBe(false);
    expect(report.text).toContain('Issues:');
    expect(report.text).toMatch(/archive directory is missing/);
    expect(report.text).toMatch(/Index database not found/);
  });

  it('warns on stale embeddings and fails on hook errors or unhealthy deps', () => {
    const report = buildDoctorReport({
      ...healthy,
      staleEmbeddingCount: 3,
      recentSyncErrors: ['2026-08-30T00:00:00.000Z [error] hook failed'],
      nodeModulesHealthy: false,
    });
    expect(report.ok).toBe(false);
    expect(report.text).toContain('Warnings:');
    expect(report.text).toContain('3 exchange(s)');
    expect(report.text).toContain('Recent hook errors:');
    expect(report.text).toContain('node_modules: unhealthy');
  });

  it('treats unknown node_modules as non-fatal', () => {
    const report = buildDoctorReport({
      ...healthy,
      nodeModulesHealthy: 'unknown',
      pluginRoot: undefined,
    });
    expect(report.ok).toBe(true);
    expect(report.text).toContain('node_modules: unknown');
  });
});

describe('readRecentLogErrors', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'em-doctor-log-'));
  });

  afterEach(() => {
    safeRmSync(testDir);
  });

  it('returns the last N [error] lines and empty for missing files', () => {
    const logPath = path.join(testDir, 'sync-errors.log');
    expect(readRecentLogErrors(logPath)).toEqual([]);

    const body = [
      formatLogLine('info', 'ok'),
      formatLogLine('error', 'one'),
      formatLogLine('error', 'two'),
      formatLogLine('error', 'three'),
    ].join('');
    fs.writeFileSync(logPath, body, 'utf-8');
    const errors = readRecentLogErrors(logPath, 2);
    expect(errors).toHaveLength(2);
    expect(errors[1]).toContain('three');
  });
});

describe('collectDoctorSnapshot', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'em-doctor-snap-'));
    process.env.EPISODIC_MEMORY_CONFIG_DIR = testDir;
    delete process.env.TEST_DB_PATH;
    delete process.env.CLAUDE_PLUGIN_ROOT;
    delete process.env.PLUGIN_ROOT;
  });

  afterEach(() => {
    delete process.env.EPISODIC_MEMORY_CONFIG_DIR;
    delete process.env.CLAUDE_PLUGIN_ROOT;
    safeRmSync(testDir);
  });

  it('reads config paths and reports missing db on a fresh config dir', () => {
    const snap = collectDoctorSnapshot();
    expect(snap.configDir).toBe(testDir);
    expect(snap.archiveDir).toContain('conversation-archive');
    expect(snap.dbExists).toBe(false);
    expect(snap.currentEmbeddingVersion).toBeGreaterThanOrEqual(1);
    expect(snap.nodeModulesHealthy).toBe('unknown');
  });

  it('detects unhealthy node_modules when PLUGIN_ROOT is set', () => {
    const plugin = path.join(testDir, 'plugin');
    fs.mkdirSync(path.join(plugin, 'node_modules'), { recursive: true });
    process.env.CLAUDE_PLUGIN_ROOT = plugin;
    const snap = collectDoctorSnapshot();
    expect(snap.nodeModulesHealthy).toBe(false);
  });
});
