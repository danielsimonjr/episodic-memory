import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type Database from 'better-sqlite3';
import {
  ensureLearningSchema,
  createRun,
  finishRun,
  addRejection,
  getRun,
  latestRun,
  insertTask,
  listTasks,
  markStale,
  insertAttempt,
  listAttempts,
  attemptsExist,
  passRate,
  type LearningTask,
} from '../../src/learn/learning-db.js';
import { LEARNING_TABLES } from '../../src/learn/learning-store.js';
import { safeRmSync, suppressConsole } from '../test-utils.js';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { openLearningDb } from '../../src/learn/learning-store.js';
import type { AttemptRow, TaskTruth } from '../../src/learn/types.js';

suppressConsole();

const HEX_A = 'a'.repeat(32);
const HEX_B = 'b'.repeat(32);

function truth(over: Partial<TaskTruth> = {}): TaskTruth {
  return {
    exchanges: [
      {
        id: HEX_A,
        path: '/archive/proj/a.jsonl',
        lineStart: 1,
        lineEnd: 9,
        sessionId: 's1',
      },
    ],
    sessionDateRange: ['2026-03-04', '2026-03-06'],
    project: 'proj-a',
    assistantMessage: 'We chose sqlite.',
    ...over,
  };
}

function task(over: Partial<Omit<LearningTask, 'id'>> = {}): Omit<LearningTask, 'id'> {
  return {
    runId: 'run-1',
    kind: 'locate',
    tier: 2,
    split: 'train',
    project: 'proj-a',
    prompt: 'Find the conversation about the cache.',
    truth: truth(),
    status: 'ok',
    ...over,
  };
}

function attempt(over: Partial<Omit<AttemptRow, 'id' | 'createdAt'>> = {}) {
  return {
    taskId: 1,
    runId: 'run-1',
    snapshotId: 1,
    role: 'solve' as const,
    passed: true,
    score: 1,
    answer: 'path: /archive/proj/a.jsonl',
    trace: [],
    cost: { turns: 3, inputTokens: 100, outputTokens: 20, usd: 0.01 },
    outcome: 'graded' as const,
    ...over,
  };
}

describe('learning-db', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = openLearningDb({
      path: path.join(fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'em-ldb-'))), 'l.sqlite'),
    });
  });

  afterEach(() => {
    const file = db.name;
    db.close();
    safeRmSync(path.dirname(file));
  });

  it('ensureLearningSchema creates the learning tables idempotently', () => {
    ensureLearningSchema(db);
    ensureLearningSchema(db);
    const names = (
      db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{
        name: string;
      }>
    ).map(r => r.name);
    expect(names).toEqual(expect.arrayContaining([...LEARNING_TABLES]));
  });

  it('createRun, getRun and latestRun round-trip a run row', () => {
    const id = createRun(db, {
      phase: 'improve',
      project: 'proj-a',
      seed: 42,
      budget: { maxCalls: 10, used: 0 },
    });
    expect(id).toMatch(/^run-/);

    const run = getRun(db, id)!;
    expect(run.phase).toBe('improve');
    expect(run.project).toBe('proj-a');
    expect(run.seed).toBe(42);
    expect(run.status).toBe('running');
    expect(run.parentRunId).toBeNull();
    expect(run.budget).toEqual({ maxCalls: 10, used: 0 });
    expect(run.rejections).toEqual([]);

    const child = createRun(db, {
      phase: 'improve',
      parentRunId: id,
      project: 'proj-a',
      seed: 42,
      budget: {},
    });
    expect(getRun(db, child)!.parentRunId).toBe(id);
  });

  it('latestRun returns the most recently created run', async () => {
    const first = createRun(db, { phase: 'bootstrap', project: 'a', seed: 1, budget: {} });
    await new Promise(resolve => setTimeout(resolve, 2));
    const second = createRun(db, { phase: 'improve', project: 'a', seed: 2, budget: {} });
    expect(latestRun(db)!.id).toBe(second);
    expect(getRun(db, first)!.id).toBe(first);
    expect(latestRun(db)!.id).toBe(second);
  });

  it('finishRun records status, metrics and finished_at', () => {
    const id = createRun(db, { phase: 'improve', project: 'a', seed: 1, budget: {} });
    finishRun(db, id, 'done', { passRate: { passed: 4, total: 5 } });
    const run = getRun(db, id)!;
    expect(run.status).toBe('done');
    expect(run.metrics).toEqual({ passRate: { passed: 4, total: 5 } });
    expect(run.finishedAt).not.toBeNull();
  });

  it('addRejection appends reasons to the run', () => {
    const id = createRun(db, { phase: 'improve', project: 'a', seed: 1, budget: {} });
    addRejection(db, id, { slug: 'alpha', reason: 'no-marks' });
    addRejection(db, id, { slug: 'beta', reason: 'duplicate' });
    expect(getRun(db, id)!.rejections).toEqual([
      { slug: 'alpha', reason: 'no-marks' },
      { slug: 'beta', reason: 'duplicate' },
    ]);
  });

  it('insertTask and listTasks round-trip prompt and truth', () => {
    const id = insertTask(db, task());
    expect(id).toBeGreaterThan(0);
    const rows = listTasks(db, { split: 'train' });
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(id);
    expect(rows[0].truth.exchanges[0].path).toBe('/archive/proj/a.jsonl');
    expect(rows[0].truth.sessionDateRange).toEqual(['2026-03-04', '2026-03-06']);
    expect(rows[0].status).toBe('ok');
  });

  it('listTasks train never returns a test row, and filters by kind, tier, project and ids', () => {
    const train = insertTask(db, task());
    const test = insertTask(db, task({ split: 'test' }));
    const when = insertTask(db, task({ kind: 'when', tier: 3, project: 'proj-b' }));

    expect(listTasks(db, { split: 'train' }).map(t => t.id)).toEqual([train, when]);
    expect(listTasks(db, { split: 'test' }).map(t => t.id)).toEqual([test]);
    expect(listTasks(db, { split: 'train', kinds: ['when'] }).map(t => t.id)).toEqual([when]);
    expect(listTasks(db, { split: 'train', tiers: [3] }).map(t => t.id)).toEqual([when]);
    expect(listTasks(db, { split: 'train', project: 'proj-b' }).map(t => t.id)).toEqual([when]);
    expect(listTasks(db, { split: 'train', ids: [train] }).map(t => t.id)).toEqual([train]);
    expect(listTasks(db, { split: 'train', ids: [] })).toEqual([]);
  });

  it('listTasks excludes stale rows unless includeStale is set', () => {
    const ok = insertTask(db, task());
    const stale = insertTask(db, task({ kind: 'when' }));
    markStale(db, [stale]);

    expect(listTasks(db, { split: 'train' }).map(t => t.id)).toEqual([ok]);
    expect(listTasks(db, { split: 'train', includeStale: true }).map(t => t.id)).toEqual([ok, stale]);
  });

  it('insertAttempt and listAttempts round-trip trace and cost', () => {
    const taskId = insertTask(db, task());
    const id = insertAttempt(
      db,
      attempt({ taskId, trace: [{ tool: 'search', args: {}, resultAddress: 'path: x', resultChars: 5 }] })
    );
    const rows = listAttempts(db, { runId: 'run-1' });
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(id);
    expect(rows[0].taskId).toBe(taskId);
    expect(rows[0].passed).toBe(true);
    expect(rows[0].trace[0].tool).toBe('search');
    expect(rows[0].cost.turns).toBe(3);
    expect(rows[0].createdAt).toBeTruthy();
  });

  it('listAttempts filters by task, role and outcome', () => {
    const t1 = insertTask(db, task());
    const t2 = insertTask(db, task({ kind: 'when' }));
    insertAttempt(db, attempt({ taskId: t1 }));
    insertAttempt(db, attempt({ taskId: t2, role: 'validate', passed: false, outcome: 'aborted' }));

    expect(listAttempts(db, { runId: 'run-1' }).length).toBe(2);
    expect(listAttempts(db, { runId: 'run-1', taskIds: [t2] }).map(a => a.taskId)).toEqual([t2]);
    expect(listAttempts(db, { runId: 'run-1', role: 'validate' }).map(a => a.taskId)).toEqual([t2]);
    expect(listAttempts(db, { runId: 'run-1', outcome: 'graded' }).map(a => a.taskId)).toEqual([t1]);
  });

  it('attemptsExist answers for a mixed set of known and unknown ids', () => {
    const id = insertAttempt(db, attempt({ taskId: 1 }));
    expect(attemptsExist(db, [id])).toBe(true);
    expect(attemptsExist(db, [id, id + 1000])).toBe(false);
    expect(attemptsExist(db, [])).toBe(false);
  });

  it('passRate counts the latest graded attempt per task and summarises by kind and tier', () => {
    const locate2 = insertTask(db, task({ kind: 'locate', tier: 2 }));
    const when3 = insertTask(db, task({ kind: 'when', tier: 3 }));
    const recall2 = insertTask(db, task({ kind: 'recall', tier: 2 }));
    const tier1 = insertTask(db, task({ kind: 'locate', tier: 1 }));

    insertAttempt(db, attempt({ taskId: locate2, passed: true }));
    insertAttempt(db, attempt({ taskId: when3, passed: false, score: 0.5 }));
    insertAttempt(db, attempt({ taskId: recall2, passed: true }));
    insertAttempt(db, attempt({ taskId: tier1, passed: true }));

    const all = passRate(db, 'run-1', 1, { split: 'train', signalOnly: false });
    expect(all.passed).toBe(3);
    expect(all.total).toBe(4);
    expect(all.byKindTier['locate:2']).toEqual({ passed: 1, total: 1 });
    expect(all.byKindTier['when:3']).toEqual({ passed: 0, total: 1 });

    const signal = passRate(db, 'run-1', 1, { split: 'train', signalOnly: true });
    expect(signal.total).toBe(2);
    expect(signal.passed).toBe(1);
    expect(Object.keys(signal.byKindTier).sort()).toEqual(['locate:2', 'when:3']);
  });

  it('passRate ignores a task solved twice in favour of the newest attempt', () => {
    const id = insertTask(db, task());
    insertAttempt(db, attempt({ taskId: id, passed: false, score: 0 }));
    insertAttempt(db, attempt({ taskId: id, passed: true, score: 1, cost: { turns: 5, inputTokens: 0, outputTokens: 0, usd: 0.02 } }));

    const rate = passRate(db, 'run-1', 1, { split: 'train', signalOnly: false });
    expect(rate).toMatchObject({ passed: 1, total: 1 });
    expect(rate.meanTurns).toBe(5);
    expect(rate.usd).toBeCloseTo(0.02);
  });

  it('passRate scopes to the requested split, snapshot and run', () => {
    const trainTask = insertTask(db, task());
    const testTask = insertTask(db, task({ split: 'test' }));
    insertAttempt(db, attempt({ taskId: trainTask, snapshotId: 1 }));
    insertAttempt(db, attempt({ taskId: testTask, snapshotId: 1 }));

    expect(passRate(db, 'run-1', 1, { split: 'train', signalOnly: false }).total).toBe(1);
    expect(passRate(db, 'run-1', 1, { split: 'test', signalOnly: false }).total).toBe(1);
    expect(passRate(db, 'run-1', 2, { split: 'train', signalOnly: false }).total).toBe(0);
    expect(passRate(db, 'run-2', 1, { split: 'train', signalOnly: false }).total).toBe(0);
  });

  it('excludes non-graded attempts from the pass rate', () => {
    const id = insertTask(db, task());
    insertAttempt(db, attempt({ taskId: id, passed: false, outcome: 'aborted' }));
    const rate = passRate(db, 'run-1', 1, { split: 'train', signalOnly: false });
    expect(rate.total).toBe(0);
  });

  it('excludes stale tasks from the pass rate', () => {
    const id = insertTask(db, task());
    insertAttempt(db, attempt({ taskId: id }));
    markStale(db, [id]);
    expect(passRate(db, 'run-1', 1, { split: 'train', signalOnly: false }).total).toBe(0);
  });
});
