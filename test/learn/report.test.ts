import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { Database } from '../../src/sqlite.js';
import { buildReport, formatReport } from '../../src/learn/report.js';
import { openLearningDb } from '../../src/learn/learning-store.js';
import { openKnowledgeStore, type KnowledgeStore } from '../../src/learn/knowledge-store.js';
import { insertKnowledgeEntry, activate, createSnapshot } from '../../src/learn/knowledge-db.js';
import { createRun, finishRun, addRejection, insertTask, insertAttempt } from '../../src/learn/learning-db.js';
import type { LearnDbs, NewKnowledgeEntry, TaskTruth } from '../../src/learn/types.js';
import { safeRmSync, suppressConsole } from '../test-utils.js';

suppressConsole();

const HEX = 'd'.repeat(32);

function truth(project = 'proj-a'): TaskTruth {
  return {
    exchanges: [{ id: HEX, path: `/archive/${project}/s.jsonl`, lineStart: 1, lineEnd: 9, sessionId: 's1' }],
    sessionDateRange: ['2026-03-04', '2026-03-04'],
    project,
    assistantMessage: 'The wrapper checks a sentinel before it installs.',
  };
}

function nk(over: Partial<NewKnowledgeEntry> = {}): NewKnowledgeEntry {
  return {
    kind: 'instruction',
    project: 'proj-a',
    slug: 'search-first',
    title: 'Search first',
    description: 'Search before reading',
    body: `mode text for release notes [#${HEX}]`,
    scope: 'proj-a release work',
    confidence: 'medium',
    trust: 'unverified',
    sources: [{ id: HEX, path: '/archive/proj-a/s.jsonl', lineStart: 1, lineEnd: 9, sessionId: 's1' }],
    status: 'candidate',
    runId: 'run-under-test',
    ...over,
  };
}

let dir: string;
let learning: Database;
let index: Database;
let store: KnowledgeStore;
let dbs: LearnDbs;
let runId: string;
const savedConfig = process.env.EPISODIC_MEMORY_CONFIG_DIR;

/** Two graded attempts for one task, one per snapshot: a before and an after. */
async function seedRun(): Promise<{ before: number; after: number }> {
  runId = createRun(learning, {
    phase: 'improve',
    project: 'proj-a',
    seed: 3,
    budget: { maxCalls: 40, maxUsd: 2 },
  });

  const taskId = insertTask(learning, {
    runId,
    kind: 'locate',
    tier: 2,
    split: 'train',
    project: 'proj-a',
    prompt: 'Which session covered the packaging step?',
    truth: truth(),
    status: 'ok',
  });
  const testTaskId = insertTask(learning, {
    runId,
    kind: 'when',
    tier: 3,
    split: 'test',
    project: 'proj-a',
    prompt: 'What month held the packaging work?',
    truth: truth(),
    status: 'ok',
  });

  const before = await createSnapshot(learning, runId, ['learned:instruction:proj-a:seed:v1']);
  const after = await createSnapshot(learning, runId, ['learned:instruction:proj-a:search-first:v1']);

  const attempt = (taskId: number, snapshotId: number, passed: boolean) =>
    insertAttempt(learning, {
      taskId,
      runId,
      snapshotId,
      role: 'solve',
      passed,
      score: passed ? 1 : 0,
      answer: 'path: /archive/proj-a/s.jsonl',
      trace: [],
      cost: { turns: 4, inputTokens: 1, outputTokens: 1, usd: 0.05 },
      outcome: 'graded',
    });

  attempt(taskId, before, false);
  attempt(taskId, after, true);
  attempt(testTaskId, after, true);
  return { before, after };
}

beforeEach(async () => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'em-report-')));
  process.env.EPISODIC_MEMORY_CONFIG_DIR = dir;
  learning = openLearningDb({ path: path.join(dir, 'learned', 'learning.sqlite') });
  store = openKnowledgeStore({ dbPath: path.join(dir, 'learned', 'knowledge.db') });
  index = new Database(':memory:');
  dbs = { store, learning, index };
  await seedRun();
});

afterEach(() => {
  try {
    store.close();
  } finally {
    learning.close();
    index.close();
    if (savedConfig === undefined) delete process.env.EPISODIC_MEMORY_CONFIG_DIR;
    else process.env.EPISODIC_MEMORY_CONFIG_DIR = savedConfig;
    safeRmSync(dir);
  }
});

describe('buildReport', () => {
  it('reports per-split, per-tier pass rates before and after', async () => {
    const model = await buildReport(dbs, runId);

    expect(model.run.id).toBe(runId);
    expect(model.train.before.total).toBe(1);
    expect(model.train.before.passed).toBe(0);
    expect(model.train.after.total).toBe(1);
    expect(model.train.after.passed).toBe(1);

    expect(model.train.byKindTier['locate:2'].before).toEqual({ passed: 0, total: 1 });
    expect(model.train.byKindTier['locate:2'].after).toEqual({ passed: 1, total: 1 });

    expect(model.test.after.byKindTier['when:3']).toEqual({ passed: 1, total: 1 });
  });

  it('lists kept entries, candidates awaiting approval, and rejected entries with reasons', async () => {
    const keptId = await insertKnowledgeEntry(store, nk({ kind: 'skill', slug: 'navigation' }));
    await activate(store, keptId, null, 'verified');
    await insertKnowledgeEntry(store, nk());
    addRejection(learning, runId, { slug: 'bad-skill', reason: 'screened: shell-command' });

    const model = await buildReport(dbs, runId);

    expect(model.kept.map(entry => entry.slug)).toEqual(['navigation']);
    expect(model.pending.map(entry => entry.slug)).toEqual(['search-first']);
    expect(model.rejected).toEqual([{ slug: 'bad-skill', reason: 'screened: shell-command' }]);
  });

  it('carries the budget, child runs and reflections', async () => {
    createRun(learning, {
      phase: 'improve',
      parentRunId: runId,
      project: 'proj-b',
      seed: 3,
      budget: { maxCalls: 5 },
    });
    await insertKnowledgeEntry(
      store,
      nk({
        kind: 'reflection',
        slug: 'reflect-round-1',
        title: 'Round 1',
        description: 'What changed',
        body: `two tasks moved after the instruction landed [#${HEX}]`,
        scope: 'run reflection',
      })
    );

    const model = await buildReport(dbs, runId);

    expect(model.budget.maxCalls).toBe(40);
    expect(model.budget.usedCalls).toBe(3);
    expect(model.childRuns).toHaveLength(1);
    expect(model.childRuns[0].project).toBe('proj-b');
    expect(model.reflections).toHaveLength(1);
    expect(model.reflections[0].body).toContain('two tasks moved');
  });

  it('reports child runs with their own metrics, the merges and the test rate', async () => {
    // A child run of this one, with the improve metrics the learner records.
    const childId = createRun(learning, {
      phase: 'improve',
      parentRunId: runId,
      project: 'proj-b',
      seed: 3,
      budget: { maxCalls: 5 },
    });
    learning
      .prepare('UPDATE learning_run SET metrics = ? WHERE id = ?')
      .run(JSON.stringify({ kept: 2, rejected: 1, suspect: 0 }), childId);
    finishRun(learning, runId, 'done', {
      merges: [
        {
          key: 'skill|proj-b|release-map',
          merged: 'learned:skill:proj-b:release-map:v3',
          sources: [HEX],
          revertedTo: null,
          regressions: [],
        },
        {
          key: 'skill|proj-a|release-map',
          merged: 'learned:skill:proj-a:release-map:v3',
          sources: [HEX],
          revertedTo: 'learned:skill:proj-a:release-map:v2',
          regressions: [7],
        },
      ],
    });

    const model = await buildReport(dbs, runId);
    expect(model.childRuns).toHaveLength(1);
    expect(model.childRuns[0].metrics).toMatchObject({ kept: 2, rejected: 1 });
    expect(model.merges).toHaveLength(2);
    expect(model.merges[0].revertedTo).toBeNull();
    expect(model.merges[1].revertedTo).toBe('learned:skill:proj-a:release-map:v2');
    expect(model.merges[1].regressions).toEqual([7]);

    // The held-out split has its own rate, separate from train.
    expect(model.test.after.byKindTier['when:3']).toEqual({ passed: 1, total: 1 });

    const text = formatReport(model, false);
    expect(text).toMatch(/child runs \(1\)/);
    expect(text).toContain('2 kept');
    expect(text).toMatch(/merges \(2\)/);
    expect(text).toContain('reverted to learned:skill:proj-a:release-map:v2 after regressing 7');
  });

  it('falls back to a single rate when a run has one snapshot', async () => {    const single = createRun(learning, { phase: 'improve', seed: 1, budget: {} });
    const snap = await createSnapshot(learning, single, []);
    const taskId = insertTask(learning, {
      runId: single,
      kind: 'multi',
      tier: 3,
      split: 'train',
      project: 'proj-a',
      prompt: 'What changed and why?',
      truth: truth(),
      status: 'ok',
    });
    insertAttempt(learning, {
      taskId,
      runId: single,
      snapshotId: snap,
      role: 'solve',
      passed: true,
      score: 1,
      answer: 'path: /archive/proj-a/s.jsonl',
      trace: [],
      cost: { turns: 2, inputTokens: 0, outputTokens: 0, usd: null },
      outcome: 'graded',
    });

    const model = await buildReport(dbs, single);
    expect(model.train.before).toEqual(model.train.after);
    expect(model.train.after.passed).toBe(1);
  });
});

describe('formatReport', () => {
  it('prints a readable report with rates, kept, rejected and budget', async () => {
    const keptId = await insertKnowledgeEntry(store, nk({ kind: 'skill', slug: 'navigation' }));
    await activate(store, keptId, null, 'verified');
    addRejection(learning, runId, { slug: 'bad-skill', reason: 'screened: url' });
    finishRun(learning, runId, 'done', {});

    const text = formatReport(await buildReport(dbs, runId), false);

    expect(text).toContain(runId);
    expect(text).toContain('train');
    expect(text).toContain('test');
    expect(text).toContain('locate:2');
    expect(text).toContain('1/1'); // after
    expect(text).toContain('0/1'); // before
    expect(text).toContain('navigation');
    expect(text).toContain('bad-skill: screened: url');
    expect(text).toMatch(/budget/i);
    expect(text).toContain('3/40');
  });

  it('--json emits parseable JSON with the same content', async () => {
    const model = await buildReport(dbs, runId);
    const raw = formatReport(model, true);
    const parsed = JSON.parse(raw);
    expect(parsed.run.id).toBe(runId);
    expect(parsed.train.after.passed).toBe(1);
  });
});
