import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'child_process';
import Database from 'better-sqlite3';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { runLearnCli } from '../../src/learn/cli-main.js';
import { openLearningDb } from '../../src/learn/learning-store.js';
import { createRun, getRun, listAttempts } from '../../src/learn/learning-db.js';
import type { LearnDbs } from '../../src/learn/types.js';
import { safeRmSync, suppressConsole } from '../test-utils.js';

const REPO_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const LEARN_CLI = path.join(REPO_ROOT, 'dist', 'learn-cli.js');
const FORBID = path.join(REPO_ROOT, 'test', 'helpers', 'forbid-modules.mjs');

function capture() {
  const out: string[] = [];
  const err: string[] = [];
  return {
    deps: { stdout: (s: string) => out.push(s), stderr: (s: string) => err.push(s) },
    stdout: () => out.join(''),
    stderr: () => err.join(''),
  };
}

function fakeRunAgent() {
  return async () => ({
    text: 'path: /archive/proj-a/s-0.jsonl\nlines: 1-9\nproject: proj-a\ndate: 2026-03-01',
    trace: [],
    cost: { turns: 2, inputTokens: 1, outputTokens: 1, usd: 0.01 },
    outcome: 'graded' as const,
    toolsSeen: [],
  });
}

let dir: string;
const savedConfig = process.env.EPISODIC_MEMORY_CONFIG_DIR;
const savedFlag = process.env.EPISODIC_MEMORY_LEARN;

beforeEach(() => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'em-relay-task6-')));
  process.env.EPISODIC_MEMORY_CONFIG_DIR = dir;
  process.env.EPISODIC_MEMORY_LEARN = '1';
});

afterEach(() => {
  if (savedConfig === undefined) delete process.env.EPISODIC_MEMORY_CONFIG_DIR;
  else process.env.EPISODIC_MEMORY_CONFIG_DIR = savedConfig;
  if (savedFlag === undefined) delete process.env.EPISODIC_MEMORY_LEARN;
  else process.env.EPISODIC_MEMORY_LEARN = savedFlag;
  safeRmSync(dir);
});

describe('relay task 6 findings', () => {
  // Finding 1: `--help` is served by importing dist/learn/cli-main.js, whose static
  // import chain reaches src/summarizer.js and with it the Agent SDK. The plan's
  // light-entry contract says `--help` needs nothing and every gate precedes the
  // heavy import; the existing child test never probes the help path with the
  // forbid-modules loader, so the SDK load slips through.
  it('learn --help exits 0 without loading the Agent SDK', () => {
    const run = spawnSync(process.execPath, [LEARN_CLI, '--help'], {
      env: {
        ...process.env,
        EPISODIC_MEMORY_LEARN: '',
        FORBID_MODULES: '@anthropic-ai/claude-agent-sdk',
        NODE_OPTIONS: `--import=file://${FORBID.replace(/\\/g, '/')}`,
      },
      encoding: 'utf-8',
      timeout: 60000,
    });

    expect(run.status).toBe(0);
    expect(run.stdout).toMatch(/learn tasks/);
    expect(run.stderr).not.toMatch(/forbidden module loaded/);
  });

  // Finding 2: the baseline precheck counts only signal train tasks (locate/when/multi,
  // tiers 2-3) but `solve` solves every task of the split, so non-signal tasks push the
  // spend past the prechecked baseline; when the budget then runs out mid-run the
  // BudgetExhausted error escapes runLearnCli as an unhandled rejection and the run is
  // marked 'failed' instead of spec §7 rule 10a's `stopped` with everything kept.
  it('a solve whose spend outgrows the prechecked baseline stops the run instead of crashing', async () => {
    const stopSuppress = suppressConsole();
    try {
      const { openKnowledgeStore } = await import('../../src/learn/knowledge-store.js');
      const store = openKnowledgeStore({ dbPath: path.join(dir, 'learned', 'knowledge.db') });
      const learning = openLearningDb({ path: path.join(dir, 'learned', 'learning.sqlite') });
      const dbs: LearnDbs = { store, learning, index: new Database(':memory:') };
      const HEX = 'e'.repeat(32);
      const truth = JSON.stringify({
        exchanges: [{ id: HEX, path: '/archive/proj-a/s-0.jsonl', lineStart: 1, lineEnd: 9, sessionId: 's0' }],
        sessionDateRange: ['2026-03-01', '2026-03-01'],
        project: 'proj-a',
        assistantMessage: 'x',
      });
      const runId = createRun(learning, { phase: 'improve', seed: 1, budget: {} });
      const insert = learning.prepare(
        `INSERT INTO learning_task (run_id, kind, tier, split, project, prompt, truth, status)
         VALUES (?, ?, ?, 'train', 'proj-a', ?, ?, 'ok')`
      );
      insert.run(runId, 'locate', 2, 'signal prompt', truth);
      insert.run(runId, 'recall', 1, 'noise prompt one', truth);
      insert.run(runId, 'recall', 1, 'noise prompt two', truth);

      const previous = process.env.EPISODIC_MEMORY_LEARN_MAX_CALLS;
      process.env.EPISODIC_MEMORY_LEARN_MAX_CALLS = '2';
      try {
        const cap = capture();
        let code: number | null = null;
        let threw: unknown = null;
        try {
          code = await runLearnCli(['solve', '--split', 'train'], {
            ...cap.deps,
            dbs,
            runAgent: fakeRunAgent(),
          });
        } catch (error) {
          threw = error;
        }

        // The run must end handled: no unhandled throw, a stopped (not failed) run,
        // and the attempts made before the budget ran out kept.
        expect(threw, `runLearnCli threw: ${String(threw)}`).toBeNull();
        expect(code).toBe(0);
        const run = getRun(learning, runId);
        expect(run?.status).toBe('stopped');
        expect(cap.stderr()).toMatch(/budget/i);
        expect(listAttempts(learning, { runId }).length).toBeGreaterThan(0);
      } finally {
        if (previous === undefined) delete process.env.EPISODIC_MEMORY_LEARN_MAX_CALLS;
        else process.env.EPISODIC_MEMORY_LEARN_MAX_CALLS = previous;
        store.close();
        learning.close();
      }
    } finally {
      stopSuppress();
    }
  });
});
