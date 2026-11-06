import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'child_process';
import Database from 'better-sqlite3';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { runLearnCli } from '../../src/learn/cli-main.js';
import { openLearningDb } from '../../src/learn/learning-store.js';
import { openKnowledgeStore, type KnowledgeStore } from '../../src/learn/knowledge-store.js';
import { insertKnowledgeEntry } from '../../src/learn/knowledge-db.js';
import { createRun, listTasks, listAttempts, getRun } from '../../src/learn/learning-db.js';
import { acquireLock, releaseLock } from '../../src/lockfile.js';
import { getLearnLockPath } from '../../src/learn/learn-lock.js';
import { getIndexDir } from '../../src/paths.js';
import type { LearnDbs } from '../../src/learn/types.js';
import { safeRmSync, suppressConsole } from '../test-utils.js';

const REPO_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const LEARN_CLI = path.join(REPO_ROOT, 'dist', 'learn-cli.js');
const FORBID = path.join(REPO_ROOT, 'test', 'helpers', 'forbid-modules.mjs');

const HEX = 'e'.repeat(32);
const LONG_USER = 'How do I make the release build stop rewriting the bundled native module? '.repeat(2);
const LONG_ASSISTANT =
  'The wrapper now verifies a sentinel file in node_modules before it declares the dependency tree healthy. '.repeat(3);

function indexDbWith(count: number, project = 'proj-a'): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE exchanges (
      id TEXT PRIMARY KEY,
      project TEXT NOT NULL,
      timestamp TEXT NOT NULL,
      user_message TEXT NOT NULL,
      assistant_message TEXT NOT NULL,
      archive_path TEXT NOT NULL,
      line_start INTEGER NOT NULL,
      line_end INTEGER NOT NULL,
      is_sidechain BOOLEAN DEFAULT 0,
      harness TEXT NOT NULL DEFAULT 'claude',
      session_id TEXT
    )
  `);
  const stmt = db.prepare(`
    INSERT INTO exchanges
      (id, project, timestamp, user_message, assistant_message, archive_path,
       line_start, line_end, is_sidechain, harness, session_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 'claude', ?)
  `);
  for (let i = 0; i < count; i += 1) {
    stmt.run(
      `${project}-${String(i).padStart(4, '0')}`.padEnd(32, '0'),
      project,
      `2026-03-${String(1 + (i % 20)).padStart(2, '0')}T10:00:00.000Z`,
      LONG_USER,
      LONG_ASSISTANT,
      `/archive/${project}/s-${i}.jsonl`,
      1 + i * 10,
      9 + i * 10,
      `session-${i}`
    );
  }
  return db;
}

function fakeGenerateModel(): (prompt: string) => Promise<string> {
  return async () => [
    '<tier1>',
    'locate: Find the release build that rewrote the native module.',
    'recall: Find the release build that rewrote the native module and state the outcome.',
    'when: When did the release build rewrite the native module?',
    'multi: What did the wrapper change and why did the native module fail?',
    '</tier1>',
    '<tier2>',
    'locate: Which session covered the packaging step that rewrites the binary?',
    'recall: Which session covered the packaging step that rewrites the binary? State the outcome.',
    'when: What month held the packaging work on the binary?',
    'multi: What did the packaging change do and why did the binary break?',
    '</tier2>',
    '<tier3>',
    'locate: Which session covered the packaging step that rewrites the binary, the one that shipped in February?',
    'recall: Which session covered the packaging step that rewrites the binary, shipped in February? State the outcome.',
    'when: What month held the packaging work on the binary, February?',
    'multi: What did the packaging change do to the vendored library and why did the binary break?',
    '</tier3>',
  ].join('\n');
}

function fakeRunAgent(text = `path: /archive/proj-a/s-1.jsonl\nlines: 11-19\nproject: proj-a\ndate: 2026-03-04`) {
  const calls: Array<{ prompt: string; model: string }> = [];
  const fn = async (options: any) => {
    calls.push({ prompt: options.prompt, model: options.model });
    return {
      text,
      trace: [],
      cost: { turns: 2, inputTokens: 1, outputTokens: 1, usd: 0.01 },
      outcome: 'graded' as const,
      toolsSeen: [],
    };
  };
  return { fn, calls };
}

function capture() {
  const out: string[] = [];
  const err: string[] = [];
  return {
    deps: { stdout: (s: string) => out.push(s), stderr: (s: string) => err.push(s) },
    out,
    err,
    stdout: () => out.join(''),
    stderr: () => err.join(''),
  };
}

let dir: string;
let learning: Database.Database;
let index: Database.Database;
let store: KnowledgeStore;
let dbs: LearnDbs;
const savedConfig = process.env.EPISODIC_MEMORY_CONFIG_DIR;
const savedFlag = process.env.EPISODIC_MEMORY_LEARN;

beforeEach(() => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'em-learn-cli-')));
  process.env.EPISODIC_MEMORY_CONFIG_DIR = dir;
  process.env.EPISODIC_MEMORY_LEARN = '1';
  learning = openLearningDb({ path: path.join(dir, 'learned', 'learning.sqlite') });
  store = openKnowledgeStore({ dbPath: path.join(dir, 'learned', 'knowledge.db') });
  index = indexDbWith(30);
  dbs = { store, learning, index };
});

afterEach(() => {
  try {
    store.close();
  } finally {
    learning.close();
    index.close();
    if (savedConfig === undefined) delete process.env.EPISODIC_MEMORY_CONFIG_DIR;
    else process.env.EPISODIC_MEMORY_CONFIG_DIR = savedConfig;
    if (savedFlag === undefined) delete process.env.EPISODIC_MEMORY_LEARN;
    else process.env.EPISODIC_MEMORY_LEARN = savedFlag;
    safeRmSync(dir);
  }
});

describe('runLearnCli', () => {
  it('tasks then solve writes tasks and attempts with a fake model and run agent', async () => {
    const first = capture();
    const tasksCode = await runLearnCli(['tasks', '--per-project', '2', '--seed', '7'], {
      ...first.deps,
      dbs,
      generateModel: fakeGenerateModel(),
    });
    expect(tasksCode).toBe(0);
    expect((first.deps as any).stderr).toBeDefined();
    expect(first.stderr()).toMatch(/task/i);

    const train = listTasks(learning, { split: 'train' });
    const test = listTasks(learning, { split: 'test' });
    expect(train.length + test.length).toBeGreaterThan(0);

    const agent = fakeRunAgent();
    const second = capture();
    const solveCode = await runLearnCli(['solve', '--split', 'train'], {
      ...second.deps,
      dbs,
      runAgent: agent.fn,
      model: 'test-model',
    });

    expect(solveCode).toBe(0);
    expect(agent.calls.length).toBeGreaterThan(0);
    expect(agent.calls[0].model).toBe('test-model');
    // Progress goes to stderr, never stdout.
    expect(second.stdout()).toBe('');
    expect(second.stderr()).toMatch(/solv/i);

    const runs = learning.prepare('SELECT * FROM learning_run ORDER BY rowid').all() as any[];
    const solveRun = runs[runs.length - 1];
    const attempts = listAttempts(learning, { runId: solveRun.id });
    expect(attempts.length).toBe(agent.calls.length);
    expect(attempts.every(a => a.runId === solveRun.id)).toBe(true);
  });

  it('tasks --check marks a task whose source range moved stale', async () => {
    const runId = createRun(learning, { phase: 'improve', seed: 1, budget: {} });
    learning
      .prepare(
        `INSERT INTO learning_task (run_id, kind, tier, split, project, prompt, truth, status)
         VALUES (?, 'locate', 2, 'train', 'proj-a', 'which session?', ?, 'ok')`
      )
      .run(
        runId,
        JSON.stringify({
          exchanges: [{ id: HEX, path: '/archive/proj-a/gone.jsonl', lineStart: 100, lineEnd: 120, sessionId: 'x' }],
          sessionDateRange: ['2026-03-01', '2026-03-01'],
          project: 'proj-a',
          assistantMessage: 'gone',
        })
      );

    const cap = capture();
    const code = await runLearnCli(['tasks', '--check'], { ...cap.deps, dbs });

    expect(code).toBe(0);
    expect(cap.stderr()).toMatch(/1 stale/);
    const stale = listTasks(learning, { split: 'train', includeStale: true });
    expect(stale[0].status).toBe('stale');
    expect(listTasks(learning, { split: 'train' })).toEqual([]);
  });

  it('refuses to start a solve whose baseline exceeds the call budget', async () => {
    const previous = process.env.EPISODIC_MEMORY_LEARN_MAX_CALLS;
    process.env.EPISODIC_MEMORY_LEARN_MAX_CALLS = '2';
    try {
      const runId = createRun(learning, { phase: 'improve', seed: 1, budget: {} });
      for (let i = 0; i < 4; i += 1) {
        learning
          .prepare(
            `INSERT INTO learning_task (run_id, kind, tier, split, project, prompt, truth, status)
             VALUES (?, 'locate', 2, 'train', 'proj-a', ?, ?, 'ok')`
          )
          .run(
            runId,
            `prompt ${i}`,
            JSON.stringify({
              exchanges: [{ id: HEX, path: '/archive/proj-a/s-0.jsonl', lineStart: 1, lineEnd: 9, sessionId: 's0' }],
              sessionDateRange: ['2026-03-01', '2026-03-01'],
              project: 'proj-a',
              assistantMessage: 'x',
            })
          );
      }

      const cap = capture();
      const code = await runLearnCli(['solve', '--split', 'train'], { ...cap.deps, dbs, runAgent: fakeRunAgent().fn });

      expect(code).toBe(1);
      expect(cap.stderr()).toMatch(/baseline/i);
      expect(cap.stderr()).toMatch(/4/);
      expect(cap.stderr()).toMatch(/2/);
      // Nothing was solved.
      expect(learning.prepare('SELECT COUNT(*) AS n FROM learning_attempt').get()).toEqual({ n: 0 });
    } finally {
      if (previous === undefined) delete process.env.EPISODIC_MEMORY_LEARN_MAX_CALLS;
      else process.env.EPISODIC_MEMORY_LEARN_MAX_CALLS = previous;
    }
  });

  it('refuses to start a bootstrap whose doubled baseline exceeds the call budget', async () => {
    const previous = process.env.EPISODIC_MEMORY_LEARN_MAX_CALLS;
    process.env.EPISODIC_MEMORY_LEARN_MAX_CALLS = '3';
    try {
      const runId = createRun(learning, { phase: 'improve', seed: 1, budget: {} });
      for (let i = 0; i < 2; i += 1) {
        learning
          .prepare(
            `INSERT INTO learning_task (run_id, kind, tier, split, project, prompt, truth, status)
             VALUES (?, 'locate', 2, 'train', 'proj-a', ?, ?, 'ok')`
          )
          .run(
            runId,
            `prompt ${i}`,
            JSON.stringify({
              exchanges: [
                { id: HEX, path: '/archive/proj-a/s-0.jsonl', lineStart: 1, lineEnd: 9, sessionId: 's0' },
              ],
              sessionDateRange: ['2026-03-01', '2026-03-01'],
              project: 'proj-a',
              assistantMessage: 'x',
            })
          );
      }

      const cap = capture();
      const agent = fakeRunAgent();
      const code = await runLearnCli(['bootstrap'], { ...cap.deps, dbs, runAgent: agent.fn });

      expect(code).toBe(1);
      // 2 signal tasks × 2 solves = 4 calls, above MAX_CALLS=3.
      expect(cap.stderr()).toMatch(/baseline/i);
      expect(cap.stderr()).toMatch(/4/);
      expect(cap.stderr()).toMatch(/3/);
      // No bootstrapper ran.
      expect(agent.calls).toHaveLength(0);
    } finally {
      if (previous === undefined) delete process.env.EPISODIC_MEMORY_LEARN_MAX_CALLS;
      else process.env.EPISODIC_MEMORY_LEARN_MAX_CALLS = previous;
    }
  });

  it('bootstrap runs under the lock, finishes a run and prints the report', async () => {
    const cap = capture();
    const agent = fakeRunAgent();
    const code = await runLearnCli(['bootstrap', '--per-project', '2'], {
      ...cap.deps,
      dbs,
      runAgent: agent.fn,
      model: 'test-model',
      generateModel: fakeGenerateModel(),
    });

    expect(code).toBe(0);
    expect(cap.stderr()).toMatch(/bootstrap/i);
    expect(cap.stdout()).toMatch(/run /);
    const runs = learning.prepare("SELECT * FROM learning_run WHERE phase = 'bootstrap'").all() as any[];
    expect(runs).toHaveLength(1);
    expect(runs[0].status).toBe('done');
    // Progress is on stderr, the report on stdout.
    expect(cap.stdout()).not.toMatch(/bootstrapping with concurrency/);
  });

  it('improve --dry-run solves the train split, writes attempts and no entries', async () => {
    const gen = capture();
    await runLearnCli(['tasks', '--per-project', '2', '--seed', '3'], {
      ...gen.deps,
      dbs,
      generateModel: fakeGenerateModel(),
    });
    expect(listTasks(learning, { split: 'train' }).length).toBeGreaterThan(0);

    const agent = fakeRunAgent();
    const cap = capture();
    const code = await runLearnCli(['improve', '--dry-run'], {
      ...cap.deps,
      dbs,
      runAgent: agent.fn,
      model: 'test-model',
    });

    expect(code).toBe(0);
    expect(agent.calls.length).toBeGreaterThan(0);
    expect(cap.stderr()).toMatch(/dry run/i);
    expect(cap.stdout()).toMatch(/run /);
    // Attempts exist: a dry run measures.
    const runs = learning
      .prepare("SELECT * FROM learning_run WHERE phase = 'improve' ORDER BY rowid DESC")
      .all() as any[];
    const runId = runs[0].id;
    expect(listAttempts(learning, { runId }).length).toBeGreaterThan(0);
    // No entries: a dry run learns nothing.
    expect(await store.listByStatus(['candidate', 'active', 'retired'])).toEqual([]);
  });

  it('improve refuses to start when the baseline exceeds the call budget', async () => {
    const gen = capture();
    await runLearnCli(['tasks', '--per-project', '2', '--seed', '3'], {
      ...gen.deps,
      dbs,
      generateModel: fakeGenerateModel(),
    });
    const saved = process.env.EPISODIC_MEMORY_LEARN_MAX_CALLS;
    process.env.EPISODIC_MEMORY_LEARN_MAX_CALLS = '1';
    try {
      const cap = capture();
      const code = await runLearnCli(['improve'], { ...cap.deps, dbs, runAgent: fakeRunAgent().fn });
      expect(code).toBe(1);
      expect(cap.stderr()).toMatch(/baseline needs/i);
    } finally {
      if (saved === undefined) delete process.env.EPISODIC_MEMORY_LEARN_MAX_CALLS;
      else process.env.EPISODIC_MEMORY_LEARN_MAX_CALLS = saved;
    }
  });

  it('report defaults to the latest run and prints rejected entries and rates', async () => {
    const older = createRun(learning, { phase: 'improve', seed: 1, budget: {} });
    const newer = createRun(learning, { phase: 'improve', seed: 2, budget: {} });
    learning
      .prepare("UPDATE learning_run SET status = 'done', rejections = ? WHERE id = ?")
      .run(JSON.stringify([{ slug: 'bad-skill', reason: 'screened: url' }]), newer);

    const cap = capture();
    const code = await runLearnCli(['report'], { ...cap.deps, dbs });

    expect(code).toBe(0);
    expect(cap.stdout()).toContain(newer);
    expect(cap.stdout()).not.toContain(older);
    expect(cap.stdout()).toContain('bad-skill: screened: url');
    expect(cap.stdout()).toMatch(/train/);
  });

  it('report --json parses', async () => {
    const runId = createRun(learning, { phase: 'improve', seed: 1, budget: {} });
    const cap = capture();
    expect(await runLearnCli(['report', '--run', runId, '--json'], { ...cap.deps, dbs })).toBe(0);
    expect(JSON.parse(cap.stdout()).run.id).toBe(runId);
  });

  it('status prints the flag, candidates awaiting approval and the latest run', async () => {
    await insertKnowledgeEntry(store, {
      kind: 'instruction',
      project: 'proj-a',
      slug: 'search-first',
      title: 'Search first',
      description: 'Search before reading',
      body: `mode text for release notes [#${HEX}]`,
      scope: 'proj-a release work',
      confidence: 'medium',
      trust: 'unverified',
      sources: [],
      status: 'candidate',
      runId: 'run-1',
    });
    const runId = createRun(learning, { phase: 'improve', seed: 4, budget: { maxCalls: 9 } });
    learning.prepare("UPDATE learning_run SET status = 'done' WHERE id = ?").run(runId);

    const cap = capture();
    expect(await runLearnCli(['status'], { ...cap.deps, dbs })).toBe(0);

    const text = cap.stdout();
    expect(text).toMatch(/EPISODIC_MEMORY_LEARN/);
    expect(text).toMatch(/candidate/i);
    expect(text).toContain('search-first');
    expect(text).toContain(runId);
    expect(text).toMatch(/improve/);
  });

  it('render rewrites the learned-hints block from the active entries and lists what it wrote', async () => {
    await insertKnowledgeEntry(store, {
      kind: 'instruction',
      project: 'proj-a',
      slug: 'search-first',
      title: 'Search first',
      description: 'Search before reading',
      body: `mode text for release notes [#${HEX}]`,
      scope: 'proj-a release work',
      confidence: 'medium',
      trust: 'verified',
      sources: [],
      status: 'active',
      runId: 'run-1',
    });
    // A stale row for a project with no active entry must be cleared by the render.
    learning
      .prepare("INSERT INTO learned_block (project, text, rendered_at) VALUES ('gone', 'old text', '2020-01-01T00:00:00.000Z')")
      .run();

    const cap = capture();
    expect(await runLearnCli(['render'], { ...cap.deps, dbs })).toBe(0);

    const rows = learning
      .prepare('SELECT project, text FROM learned_block ORDER BY project')
      .all() as Array<{ project: string; text: string }>;
    // The shared `*` block is empty here, so no row is kept for it.
    expect(rows.map(r => r.project)).toEqual(['proj-a']);
    expect(rows.find(r => r.project === 'proj-a')?.text).toContain('release notes');
    expect(cap.stdout()).toMatch(/rendered 1 learned-hints block\(s\)/);
    expect(cap.stdout()).toMatch(/proj-a: \d+ chars/);
    expect(cap.stderr()).toBe('');
  });

  it('render --project prints that block after rendering', async () => {
    await insertKnowledgeEntry(store, {
      kind: 'instruction',
      project: 'proj-a',
      slug: 'search-first',
      title: 'Search first',
      description: 'Search before reading',
      body: `mode text for release notes [#${HEX}]`,
      scope: 'proj-a release work',
      confidence: 'medium',
      trust: 'verified',
      sources: [],
      status: 'active',
      runId: 'run-1',
    });
    const cap = capture();
    expect(await runLearnCli(['render', '--project', 'proj-a'], { ...cap.deps, dbs })).toBe(0);
    expect(cap.stdout()).toContain('release notes');

    const missing = capture();
    expect(await runLearnCli(['render', '--project', 'nope'], { ...missing.deps, dbs })).toBe(1);
    expect(missing.stderr()).toMatch(/no learned-hints block for project 'nope'/);
  });

  it('the flag being off wins over every subcommand', async () => {
    process.env.EPISODIC_MEMORY_LEARN = '';
    for (const command of ['tasks', 'status', 'bootstrap', 'improve', 'render']) {
      const cap = capture();
      const code = await runLearnCli([command], { ...cap.deps, dbs });
      expect(code, command).toBe(0);
      expect(cap.stderr()).toMatch(/learning is off/i);
      expect(cap.stdout()).toBe('');
    }
    // Nothing was created or written.
    expect(learning.prepare('SELECT COUNT(*) AS n FROM learning_run').get()).toEqual({ n: 0 });
  });

  it('an unknown command prints usage and exits 2', async () => {
    const cap = capture();
    expect(await runLearnCli(['wat'], { ...cap.deps, dbs })).toBe(2);
    expect(cap.stderr()).toMatch(/usage/i);
  });

  it('--help prints usage to stdout and exits 0', async () => {
    const cap = capture();
    expect(await runLearnCli(['--help'], { ...cap.deps, dbs })).toBe(0);
    expect(cap.stdout()).toMatch(/learn tasks/);
  });

  it('a second instance under a live lock exits naming the holder PID', async () => {
    const lock = acquireLock(getLearnLockPath(getIndexDir()), 60_000);
    expect(lock).not.toBeNull();
    try {
      const cap = capture();
      const code = await runLearnCli(['tasks'], { ...cap.deps, dbs, generateModel: fakeGenerateModel() });
      expect(code).toBe(1);
      expect(cap.stderr()).toContain(String(process.pid));
    } finally {
      releaseLock(lock!);
    }
  });
});

describe('dist/learn-cli.js early exits', () => {
  function runCli(args: string[], env: Record<string, string> = {}) {
    return spawnSync(process.execPath, [LEARN_CLI, ...args], {
      env: { ...process.env, EPISODIC_MEMORY_CONFIG_DIR: dir, ...env },
      encoding: 'utf-8',
      timeout: 60000,
    });
  }

  it('the guard exits 0 before importing cli-main or the SDK', () => {
    const run = runCli(['tasks'], {
      EPISODIC_MEMORY_SUMMARIZER_GUARD: '1',
      EPISODIC_MEMORY_LEARN: '1',
      FORBID_MODULES: '@anthropic-ai/claude-agent-sdk',
      NODE_OPTIONS: `--import=file://${FORBID.replace(/\\/g, '/')}`,
    });

    expect(run.status).toBe(0);
    expect(run.stderr).toMatch(/skipping learn/i);
    expect(run.stderr).not.toMatch(/forbidden module loaded/);
  });

  it('the flag being off exits 0 with the off message', () => {
    const run = runCli(['tasks'], {
      EPISODIC_MEMORY_LEARN: '',
      FORBID_MODULES: '@anthropic-ai/claude-agent-sdk',
      NODE_OPTIONS: `--import=file://${FORBID.replace(/\\/g, '/')}`,
    });

    expect(run.status).toBe(0);
    expect(run.stderr).toMatch(/learning is off/i);
    expect(run.stderr).not.toMatch(/forbidden module loaded/);
  });

  it('a held GPU reservation defers with exit 0', () => {
    const reservation = path.join(dir, 'gpu-reserved.json');
    fs.writeFileSync(reservation, JSON.stringify({ holder: 'Starship', why: 'benchmark' }));

    const run = runCli(['status'], {
      EPISODIC_MEMORY_LEARN: '1',
      FLEET_GPU_RESERVATION: reservation,
    });

    expect(run.status).toBe(0);
    expect(run.stderr).toMatch(/deferred/i);
    expect(run.stderr).toContain('Starship');
  });

  it('--help works with the flag off', () => {
    const run = runCli(['--help'], { EPISODIC_MEMORY_LEARN: '' });
    expect(run.status).toBe(0);
    expect(run.stdout).toMatch(/learn tasks/);
  });
});

describe('learn subcommand in cli/episodic-memory.js', () => {
  it('dispatches learn and lists it in the help', () => {
    const cli = path.join(REPO_ROOT, 'cli', 'episodic-memory.js');
    const help = spawnSync(process.execPath, [cli, '--help'], { encoding: 'utf-8', timeout: 30000 });
    expect(help.stdout).toMatch(/learn\s+Self-improving memory/i);

    const run = spawnSync(process.execPath, [cli, 'learn', '--help'], {
      env: { ...process.env, EPISODIC_MEMORY_CONFIG_DIR: dir, EPISODIC_MEMORY_LEARN: '' },
      encoding: 'utf-8',
      timeout: 60000,
    });
    expect(run.status).toBe(0);
    expect(run.stdout).toMatch(/learn tasks/);
  });
});
