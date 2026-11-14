import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Database } from '../src/sqlite.js';
import fs from 'fs';
import path from 'path';
import os from 'os';
import {
  buildDoctorReport,
  readRecentLogErrors,
  collectDoctorSnapshot,
  formatSqliteLine,
} from '../src/doctor.js';
import { emptyLearnSection, collectLearnDoctorSection } from '../src/doctor-learn.js';
import { formatLogLine } from '../src/logging.js';
import { openKnowledgeStore } from '../src/learn/knowledge-store.js';
import { openLearningDb } from '../src/learn/learning-store.js';
import { insertKnowledgeEntry, activate } from '../src/learn/knowledge-db.js';
import { createRun, finishRun } from '../src/learn/learning-db.js';
import type { NewKnowledgeEntry } from '../src/learn/types.js';
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
    // `npm install` does not restore one missing file inside an installed package.
    expect(report.text).toContain('delete node_modules/onnxruntime-node first');
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

describe('doctor embedding model section', () => {
  const modelReady = { dir: '/tmp/models', state: 'ready' as const, bad: [], fetchFailed: false };

  it('prints the model state and keeps ok when the model is ready', () => {
    const report = buildDoctorReport({ ...healthy, model: modelReady });
    expect(report.ok).toBe(true);
    expect(report.text).toContain('Embedding model: ready (/tmp/models)');
    expect(report.text).not.toContain('embedding model is not ready');
    expect(report.json.model).toEqual(modelReady);
  });

  it('warns, without failing, when a model file is missing', () => {
    const report = buildDoctorReport({
      ...healthy,
      model: { dir: '/tmp/models', state: 'missing', bad: ['tokenizer.json'], fetchFailed: false },
    });
    expect(report.ok).toBe(true);
    expect(report.text).toContain('Embedding model: missing (/tmp/models)');
    expect(report.text).toMatch(/embedding model is not ready at \/tmp\/models \(1 file\(s\) missing or changed\)/);
    expect(report.text).toContain('episodic-memory model fetch');
  });

  it('warns when the last download failed', () => {
    const report = buildDoctorReport({
      ...healthy,
      model: { dir: '/tmp/models', state: 'missing', bad: [], fetchFailed: true },
    });
    expect(report.ok).toBe(true);
    expect(report.text).toMatch(/last embedding model download failed/);
  });

  it('prints no model line when the section was not collected', () => {
    const report = buildDoctorReport(healthy);
    expect(report.text).not.toContain('Embedding model:');
    expect(report.json.model).toBeUndefined();
  });

  it('collectDoctorSnapshot reads the model folder and the failed-download marker', async () => {
    const saved = process.env.EPISODIC_MEMORY_MODEL_DIR;
    const modelFolder = fs.mkdtempSync(path.join(os.tmpdir(), 'em-doctor-model-'));
    process.env.EPISODIC_MEMORY_MODEL_DIR = modelFolder;
    try {
      const missing = await collectDoctorSnapshot();
      expect(missing.model).toEqual({
        dir: modelFolder,
        state: 'missing',
        bad: ['tokenizer.json', 'tokenizer_config.json', 'onnx/model_quantized.onnx'],
        fetchFailed: false,
      });
      fs.writeFileSync(path.join(modelFolder, '.model-fetch-failed'), 'fetch failed');
      const failed = await collectDoctorSnapshot();
      expect(failed.model?.fetchFailed).toBe(true);
    } finally {
      if (saved === undefined) delete process.env.EPISODIC_MEMORY_MODEL_DIR;
      else process.env.EPISODIC_MEMORY_MODEL_DIR = saved;
      safeRmSync(modelFolder);
    }
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

  it('reads config paths and reports missing db on a fresh config dir', async () => {
    const snap = await collectDoctorSnapshot();
    expect(snap.configDir).toBe(testDir);
    expect(snap.archiveDir).toContain('conversation-archive');
    expect(snap.dbExists).toBe(false);
    expect(snap.currentEmbeddingVersion).toBeGreaterThanOrEqual(1);
    expect(snap.nodeModulesHealthy).toBe('unknown');
    // No `learned/` yet: the section is present but empty.
    expect(snap.learn?.present).toBe(false);
    expect(snap.learn?.candidatesAwaitingApproval).toBe(0);
  });

  it('detects unhealthy node_modules when PLUGIN_ROOT is set', async () => {
    const plugin = path.join(testDir, 'plugin');
    fs.mkdirSync(path.join(plugin, 'node_modules'), { recursive: true });
    process.env.CLAUDE_PLUGIN_ROOT = plugin;
    const snap = await collectDoctorSnapshot();
    expect(snap.nodeModulesHealthy).toBe(false);
  });
});

const HEX = 'c'.repeat(32);

function nk(over: Partial<NewKnowledgeEntry> = {}): NewKnowledgeEntry {
  return {
    kind: 'skill',
    project: 'proj-a',
    slug: 'alpha',
    title: 'Alpha skill',
    description: 'Use when looking for the alpha service',
    body: `alpha lives in the archive [#${HEX}]`,
    scope: 'proj-a repository work',
    confidence: 'medium',
    trust: 'unverified',
    sources: [],
    status: 'candidate',
    runId: 'run-1',
    ...over,
  };
}

describe('doctor learn section', () => {
  let testDir: string;
  const savedConfig = process.env.EPISODIC_MEMORY_CONFIG_DIR;

  beforeEach(() => {
    testDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'em-doctor-learn-')));
    process.env.EPISODIC_MEMORY_CONFIG_DIR = testDir;
    delete process.env.TEST_DB_PATH;
    delete process.env.CLAUDE_PLUGIN_ROOT;
    delete process.env.PLUGIN_ROOT;
  });

  afterEach(() => {
    if (savedConfig === undefined) delete process.env.EPISODIC_MEMORY_CONFIG_DIR;
    else process.env.EPISODIC_MEMORY_CONFIG_DIR = savedConfig;
    delete process.env.CLAUDE_PLUGIN_ROOT;
    safeRmSync(testDir);
  });

  /** A store with one active skill, one candidate instruction and one run. */
  async function seed(): Promise<void> {
    const store = openKnowledgeStore({ dbPath: path.join(testDir, 'learned', 'knowledge.db') });
    try {
      const skill = await insertKnowledgeEntry(store, nk());
      await activate(store, skill, null, 'verified');
      await insertKnowledgeEntry(
        store,
        nk({
          kind: 'instruction',
          slug: 'search-first',
          body: `mode text for release notes [#${HEX}]`,
        })
      );
    } finally {
      store.close();
    }

    const learning = openLearningDb({ path: path.join(testDir, 'learned', 'learning.sqlite') });
    try {
      const runId = createRun(learning, {
        phase: 'improve',
        seed: 1,
        budget: { maxCalls: 10 },
      });
      finishRun(learning, runId, 'done', {
        train: { before: { passed: 1, total: 3 }, after: { passed: 2, total: 3 } },
        kept: 1,
        rejected: 0,
      });
    } finally {
      learning.close();
    }

    // An exported tree, so the size item has something to measure.
    fs.mkdirSync(path.join(testDir, 'learned-skills', 'proj-a', 'alpha'), { recursive: true });
    fs.writeFileSync(
      path.join(testDir, 'learned-skills', 'proj-a', 'alpha', 'SKILL.md'),
      '---\nname: alpha\n---\n',
      'utf-8'
    );
  }

  it('doctor reports the learn section, unresolved sources and the json shape', async () => {
    await seed();

    // No exchanges table anywhere the section can see, so the skill's one cited
    // id is unresolved.
    const learn = await collectLearnDoctorSection();
    expect(learn.present).toBe(true);
    expect(learn.entryCounts.skill.active).toBe(1);
    expect(learn.entryCounts.instruction.candidate).toBe(1);
    expect(learn.candidatesAwaitingApproval).toBe(1);
    expect(learn.latestRun?.status).toBe('done');
    expect(learn.latestRun?.metrics).toContain('train 1/3 → 2/3');
    expect(learn.exportTree.present).toBe(true);
    expect(learn.exportTree.files).toBe(1);
    expect(learn.unresolvedSources.map(entry => entry.id)).toEqual([
      'learned:instruction:proj-a:search-first:v1',
      'learned:skill:proj-a:alpha:v1',
    ]);
    expect(learn.sqliteVersion).toMatch(/^3\.\d+\.\d+$/);

    const report = buildDoctorReport({ ...(await collectDoctorSnapshot()), learn });
    const text = report.text;
    expect(text).toContain('Learn (Recursa):');
    expect(text).toContain('learned dir:');
    expect(text).toContain('knowledge.db:');
    expect(text).toContain('learning.sqlite:');
    expect(text).toContain('skill: 1 active, 0 candidate, 0 retired');
    expect(text).toContain('instruction: 0 active, 1 candidate, 0 retired');
    expect(text).toContain('candidates awaiting approval: 1');
    expect(text).toContain('latest run:');
    expect(text).toContain('unresolved sources: 2');
    expect(text).toContain('learned-skills: found (1 file(s)');
    expect(text).toMatch(/node:sqlite: SQLite 3\.\d+\.\d+, Node v\d+/);
    expect(text).not.toContain('better-sqlite3');
    expect(text).toContain('Warnings:');
    expect(text).toMatch(/exchange id\(s\) the index no longer has/);

    const json = report.json.learn as Record<string, unknown>;
    expect(json.present).toBe(true);
    expect((json.entryCounts as Record<string, Record<string, number>>).skill.active).toBe(1);
    expect(json.candidatesAwaitingApproval).toBe(1);
    expect((json.latestRun as Record<string, unknown>).id).toMatch(/^run-/);
    expect(Array.isArray(json.unresolvedSources)).toBe(true);
    expect(json.unresolvedSources).toHaveLength(2);
    expect((json.exportTree as Record<string, unknown>).files).toBe(1);
    expect(json.sqliteVersion).toMatch(/^3\.\d+\.\d+$/);
    // No audit-chain item: the store keeps no governance chain.
    expect(report.text).not.toMatch(/audit/i);
    expect(Object.keys(json)).not.toContain('auditChain');
  });

  it('counts a resolved citation as resolved when the index has the row', async () => {
    await seed();

    // Point the section at a real index by giving the config dir a db.sqlite
    // with the cited exchange (initDatabase creates the schema).
    const { initDatabase } = await import('../src/db.js');
    const index = initDatabase();
    try {
      index
        .prepare(
          `INSERT INTO exchanges (id, project, timestamp, user_message, assistant_message,
             archive_path, line_start, line_end, is_sidechain, harness, session_id)
           VALUES (?, 'proj-a', '2026-03-01T10:00:00.000Z', 'q', 'a',
             '/archive/proj-a/s-1.jsonl', 1, 9, 0, 'claude', 's1')`
        )
        .run(HEX);
    } finally {
      index.close();
    }

    const learn = await collectLearnDoctorSection();
    expect(learn.unresolvedSources).toEqual([]);
  });

  it('is absent, not an error, on a config dir with no learned/', async () => {
    const learn = await collectLearnDoctorSection();
    expect(learn.present).toBe(false);
    expect(learn.learningDbSizeBytes).toBeNull();
    expect(learn.latestRun).toBeNull();
    expect(learn.unresolvedSources).toEqual([]);
    expect(learn.exportTree.present).toBe(false);
  });

  it('doctor never creates knowledge.db when only learning.sqlite exists', async () => {
    // A half-written `learned/` (the trace db landed, the knowledge store did
    // not, or a user removed knowledge.db) must stay half-written: doctor is a
    // read-only probe (spec §7 rule 1 — the databases appear on a flag-on
    // write only).
    fs.mkdirSync(path.join(testDir, 'learned'), { recursive: true });
    fs.writeFileSync(path.join(testDir, 'learned', 'learning.sqlite'), '');

    const learn = await collectLearnDoctorSection();
    expect(learn.present).toBe(true);
    expect(fs.existsSync(path.join(testDir, 'learned', 'knowledge.db'))).toBe(false);
  });

  it('an empty section prints an absent dir and no warnings', () => {
    const report = buildDoctorReport({
      ...healthy,
      learn: emptyLearnSection('/tmp/cfg/learned'),
    });
    expect(report.text).toContain('Learn (Recursa):');
    expect(report.text).toContain('learned dir: /tmp/cfg/learned (absent)');
    expect(report.text).toContain('latest run: none');
    expect(report.text).not.toContain('Warnings:');
    expect(report.ok).toBe(true);
  });

  it('prints the SQLite version of node:sqlite in the learn section', () => {
    const section = {
      ...emptyLearnSection('/tmp/cfg/learned'),
      present: true,
      sqliteVersion: '3.50.1',
    };
    const report = buildDoctorReport({ ...healthy, learn: section });
    expect(report.text).toContain(`node:sqlite: SQLite 3.50.1, Node ${process.version}`);
    expect(report.text).not.toContain('better-sqlite3');
    expect(report.text).not.toContain('Warnings:');
  });

  it('prints a FAIL line for node:sqlite below the Node floor', () => {
    expect(formatSqliteLine('3.49.1', 'v22.15.1')).toMatch(/^  node:sqlite: FAIL .*22\.16\.0/);
    expect(formatSqliteLine('3.50.1', 'v24.1.0')).toBe('  node:sqlite: SQLite 3.50.1, Node v24.1.0');
  });

  it('omits the section entirely when doctor was given none', () => {
    const report = buildDoctorReport(healthy);
    expect(report.text).not.toContain('Learn (Recursa):');
    expect(report.json.learn).toBeUndefined();
  });
});
