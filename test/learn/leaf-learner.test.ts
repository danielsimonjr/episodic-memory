import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { runLeafLearner } from '../../src/learn/leaf-learner.js';
import { CallBudget } from '../../src/learn/solver.js';
import { openKnowledgeStore, type KnowledgeStore } from '../../src/learn/knowledge-store.js';
import { openLearningDb } from '../../src/learn/learning-store.js';
import {
  createRun,
  getRun,
  insertAttempt,
  insertTask,
  listAttempts,
  type LearningTask,
} from '../../src/learn/learning-db.js';
import { getSnapshot } from '../../src/learn/knowledge-db.js';
import type { AttemptRow, LearnDbs, ProposedEntry, TaskTruth } from '../../src/learn/types.js';
import { safeRmSync, suppressConsole } from '../test-utils.js';

suppressConsole();

const GROUNDED_WORDS = 'release build native module sentinel';

function hexId(label: string): string {
  return createHash('sha256').update(label).digest('hex').slice(0, 32);
}

function indexFixture(project = 'proj-a'): Database.Database {
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
      session_id TEXT
    )
  `);
  db.prepare(
    `INSERT INTO exchanges
       (id, project, timestamp, user_message, assistant_message, archive_path,
        line_start, line_end, is_sidechain, session_id)
     VALUES (?, ?, '2026-03-01T10:00:00.000Z', ?, ?, ?, 1, 9, 0, 'session-0')`
  ).run(
    hexId(`${project}-0`),
    project,
    `How does the ${GROUNDED_WORDS} work?`,
    `The ${GROUNDED_WORDS} is verified.`,
    `/archive/${project}/s-0.jsonl`
  );
  return db;
}

function truth(project = 'proj-a'): TaskTruth {
  return {
    exchanges: [
      {
        id: hexId(`${project}-0`),
        path: `/archive/${project}/s-0.jsonl`,
        lineStart: 1,
        lineEnd: 9,
        sessionId: 'session-0',
      },
    ],
    sessionDateRange: ['2026-03-01', '2026-03-01'],
    project,
    assistantMessage: `The ${GROUNDED_WORDS} is verified.`,
  };
}

let dir: string;
let learning: Database.Database;
let index: Database.Database;
let store: KnowledgeStore;
let dbs: LearnDbs;
let runId: string;
let counter = 0;
const savedApprove = process.env.EPISODIC_MEMORY_LEARN_APPROVE;

beforeEach(() => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'em-leaf-')));
  process.env.EPISODIC_MEMORY_CONFIG_DIR = dir;
  delete process.env.EPISODIC_MEMORY_LEARN_APPROVE;
  learning = openLearningDb({ path: path.join(dir, 'learned', 'learning.sqlite') });
  store = openKnowledgeStore({ dbPath: path.join(dir, 'learned', 'knowledge.db') });
  index = indexFixture();
  dbs = { store, learning, index };
  runId = createRun(learning, { phase: 'improve', seed: 5, budget: {} });
});

afterEach(() => {
  try {
    store.close();
  } finally {
    try {
      learning.close();
    } finally {
      index.close();
      if (savedApprove === undefined) delete process.env.EPISODIC_MEMORY_LEARN_APPROVE;
      else process.env.EPISODIC_MEMORY_LEARN_APPROVE = savedApprove;
      safeRmSync(dir);
    }
  }
});

function addTask(over: Partial<Omit<LearningTask, 'id'>> = {}): LearningTask {
  counter += 1;
  const task = {
    runId,
    kind: 'locate' as const,
    tier: 2 as const,
    split: 'train' as const,
    project: 'proj-a',
    prompt: `Where was the ${GROUNDED_WORDS} discussed, question ${counter}?`,
    truth: truth(),
    status: 'ok' as const,
    ...over,
  };
  const id = insertTask(learning, task);
  return { ...task, id };
}

function seedAttempt(taskId: number, passed: boolean, answer = ''): number {
  return insertAttempt(learning, {
    taskId,
    runId,
    snapshotId: 1,
    role: 'solve',
    passed,
    score: passed ? 1 : 0,
    answer: answer || (passed ? 'path: /archive/proj-a/s-0.jsonl\nlines: 1-9' : 'not found'),
    trace: [],
    cost: { turns: 4, inputTokens: 10, outputTokens: 5, usd: 0.02 },
    outcome: 'graded',
  });
}

/** A skill that would fix a task whose prompt names it. */
function fixProposal(over: Partial<ProposedEntry> = {}): ProposedEntry {
  return {
    kind: 'skill',
    project: 'proj-a',
    slug: 'release-notes',
    title: 'Where release work lives',
    description: 'Use when asked about a release build or packaging change',
    body: `project proj-a: ${GROUNDED_WORDS} work [#${hexId('proj-a-0')}]`,
    scope: 'proj-a',
    confidence: 'medium',
    ...over,
  };
}

/**
 * A fake solver whose pass set is a function of the snapshot's active slugs.
 *
 * `pass(slugs, taskId)` decides the grade: the only thing a candidate can change
 * is which slugs the evaluation snapshot holds.
 */
function fakeSolve(pass: (slugs: string[], taskId: number) => boolean) {
  const calls: Array<{ taskId: number; role: string; names: string[] }> = [];
  const fn = async (
    solverDbs: LearnDbs,
    task: LearningTask,
    options: any
  ): Promise<AttemptRow> => {
    const names = getSnapshot(solverDbs.learning, options.snapshotId);
    const slugs = names.map(name => name.split(':')[3]);
    const passed = pass(slugs, task.id);
    calls.push({ taskId: task.id, role: options.role, names });
    const answer = passed ? 'path: /archive/proj-a/s-0.jsonl\nlines: 1-9' : 'not found';
    const attempt = {
      taskId: task.id,
      runId: options.runId,
      snapshotId: options.snapshotId,
      role: options.role as AttemptRow['role'],
      passed,
      score: passed ? 1 : 0,
      answer,
      trace: [],
      cost: { turns: 3, inputTokens: 8, outputTokens: 4, usd: 0.01 },
      outcome: 'graded' as const,
    };
    const id = insertAttempt(solverDbs.learning, attempt);
    return { ...attempt, id, createdAt: new Date().toISOString() };
  };
  return { fn: fn as any, calls };
}

/** `fixedBy` inverts to a predicate: a task passes once its slug is active. */
function fixedBy(map: Record<number, string>, regressedBy: Record<number, string> = {}) {
  return (slugs: string[], taskId: number): boolean => {
    if (regressedBy[taskId] && slugs.includes(regressedBy[taskId])) return false;
    const needs = map[taskId];
    if (!needs) return true;
    return slugs.includes(needs);
  };
}

interface LearnerCall {
  prompt: string;
  systemPrompt: string;
  allowPropose: boolean;
}

/**
 * A fake learner agent that proposes `proposals` (optionally per round).
 *
 * The fake passes each proposal to the server's own `propose_entry` handler, exactly as a subprocess would.
 */
function fakeLearner(proposals: ProposedEntry[] | ((round: number) => ProposedEntry[])) {
  const calls: LearnerCall[] = [];
  let round = 0;
  const fn = async (options: any) => {
    calls.push({
      prompt: options.prompt,
      systemPrompt: options.systemPrompt,
      allowPropose: options.allowPropose,
    });
    const list = typeof proposals === 'function' ? proposals(round) : proposals;
    round += 1;
    const instance = (options.server as any).instance as {
      _registeredTools: Record<string, { handler: (a: any, e: any) => Promise<any> }>;
    };
    const handler = instance._registeredTools.propose_entry?.handler;
    if (handler) {
      for (const proposal of list) await handler({ ...proposal }, {});
    }
    return {
      text: 'diagnosed',
      trace: [],
      cost: { turns: 5, inputTokens: 10, outputTokens: 5, usd: 0.01 },
      outcome: 'graded' as const,
      toolsSeen: [],
    };
  };
  return { fn: fn as any, calls };
}

const common = () => ({
  project: 'proj-a',
  rounds: 3,
  editsPerRound: 3,
  model: 'test-model',
  budget: new CallBudget(200),
});

describe('runLeafLearner', () => {
  it('keeps and activates an edit that fixes a target and regresses nothing', async () => {
    const failed = addTask();
    const passed = addTask();
    seedAttempt(failed.id, false);
    seedAttempt(passed.id, true);

    const solve = fakeSolve(fixedBy({ [failed.id]: 'release-notes' }));
    const learner = fakeLearner([fixProposal()]);

    const result = await runLeafLearner(dbs, {
      ...common(),
      runId,
      taskIds: [failed.id, passed.id],
      solve: solve.fn,
      runAgent: learner.fn,
    });

    expect(result.kept).toHaveLength(1);
    expect(result.kept[0]).toContain('release-notes');
    expect(result.rejected).toEqual([]);
    expect(result.rounds.length).toBeGreaterThan(0);
    expect(result.rounds[0].total).toBeGreaterThan(0);

    const skills = await store.listByStatus(['active'], ['skill']);
    expect(skills.map(entry => entry.slug)).toEqual(['release-notes']);
  });

  it('leaves a passing instruction a candidate under the default mode, and activates it under none', async () => {
    const make = async () => {
      const failed = addTask();
      seedAttempt(failed.id, false);
      const solve = fakeSolve(fixedBy({ [failed.id]: 'release-map' }));
      const learner = fakeLearner([
        fixProposal({
          kind: 'instruction',
          slug: 'release-map',
          title: 'Release map',
          description: 'Where release work lives in this project',
        }),
      ]);
      const result = await runLeafLearner(dbs, {
        ...common(),
        runId,
        taskIds: [failed.id],
        solve: solve.fn,
        runAgent: learner.fn,
      });
      return result;
    };

    const first = await make();
    expect(first.kept).toHaveLength(1);
    let entries = await store.listByStatus(['candidate'], ['instruction']);
    expect(entries.map(entry => entry.slug)).toEqual(['release-map']);
    expect(await store.listByStatus(['active'], ['instruction'])).toEqual([]);

    // A fresh run with approve mode none activates the same shape of edit.
    store.close();
    learning.close();
    index.close();
    safeRmSync(dir);
    dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'em-leaf-')));
    process.env.EPISODIC_MEMORY_CONFIG_DIR = dir;
    process.env.EPISODIC_MEMORY_LEARN_APPROVE = 'none';
    learning = openLearningDb({ path: path.join(dir, 'learned', 'learning.sqlite') });
    store = openKnowledgeStore({ dbPath: path.join(dir, 'learned', 'knowledge.db') });
    index = indexFixture();
    dbs = { store, learning, index };
    runId = createRun(learning, { phase: 'improve', seed: 5, budget: {} });
    const second = await make();
    expect(second.kept).toHaveLength(1);
    entries = await store.listByStatus(['active'], ['instruction']);
    expect(entries.map(entry => entry.slug)).toEqual(['release-map']);
  });

  it('drops an edit that regresses a sampled task, recording the regression and keeping the row', async () => {
    const failed = addTask();
    const passed = addTask();
    seedAttempt(failed.id, false);
    seedAttempt(passed.id, true);

    const solve = fakeSolve(
      fixedBy({ [failed.id]: 'release-notes' }, { [passed.id]: 'release-notes' })
    );
    const learner = fakeLearner([fixProposal()]);

    const result = await runLeafLearner(dbs, {
      ...common(),
      runId,
      taskIds: [failed.id, passed.id],
      solve: solve.fn,
      runAgent: learner.fn,
    });

    expect(result.kept).toEqual([]);
    expect(result.rejected).toEqual([]);
    const candidates = await store.listByStatus(['candidate'], ['skill']);
    expect(candidates).toHaveLength(1);
    expect(candidates[0].slug).toBe('release-notes');
    expect(candidates[0].validation?.regressions).toEqual([passed.id]);
  });

  it('ends the loop early when a round keeps no edit', async () => {
    const failed = addTask();
    seedAttempt(failed.id, false);
    // The proposal never helps, so the round keeps nothing and the loop stops.
    const solve = fakeSolve(() => false);
    const learner = fakeLearner([fixProposal()]);

    const result = await runLeafLearner(dbs, {
      ...common(),
      runId,
      taskIds: [failed.id],
      solve: solve.fn,
      runAgent: learner.fn,
    });

    expect(result.kept).toEqual([]);
    // One learner call, then stop: a round that kept nothing does not repeat.
    expect(learner.calls).toHaveLength(1);
    expect(result.rounds).toHaveLength(1);
  });

  it('excludes suspect tasks from the validation sets', async () => {
    const suspect = addTask();
    const target = addTask();
    seedAttempt(target.id, false);

    // Two solve attempts this round disagree about the suspect task's location,
    // both with a graded outcome: that is solver noise, not a task to learn from.
    insertAttempt(learning, {
      taskId: suspect.id,
      runId,
      snapshotId: 1,
      role: 'solve',
      passed: false,
      score: 0,
      answer: 'path: /archive/proj-a/a.jsonl\nlines: 1-9',
      trace: [],
      cost: { turns: 2, inputTokens: 4, outputTokens: 2, usd: 0.01 },
      outcome: 'graded',
    });
    insertAttempt(learning, {
      taskId: suspect.id,
      runId,
      snapshotId: 1,
      role: 'solve',
      passed: false,
      score: 0,
      answer: 'path: /archive/proj-a/b.jsonl\nlines: 20-30',
      trace: [],
      cost: { turns: 2, inputTokens: 4, outputTokens: 2, usd: 0.01 },
      outcome: 'graded',
    });

    const solve = fakeSolve(fixedBy({ [target.id]: 'release-notes' }));
    const learner = fakeLearner([fixProposal({ targets: [target.id] })]);

    const result = await runLeafLearner(dbs, {
      ...common(),
      runId,
      taskIds: [suspect.id, target.id],
      solve: solve.fn,
      runAgent: learner.fn,
    });

    expect(result.suspect).toContain(suspect.id);
    // The suspect task never entered a validation solve.
    const validateCalls = solve.calls.filter(call => call.role === 'validate');
    expect(validateCalls.some(call => call.taskId === suspect.id)).toBe(false);
  });

  it('rejects a proposal that fails the gate and keeps looping', async () => {
    const failed = addTask();
    seedAttempt(failed.id, false);

    const solve = fakeSolve(fixedBy({ [failed.id]: 'release-notes' }));
    const learner = fakeLearner(round =>
      round === 0
        ? [fixProposal({ slug: 'Bad Slug' })]
        : [fixProposal()]
    );

    const result = await runLeafLearner(dbs, {
      ...common(),
      runId,
      taskIds: [failed.id],
      solve: solve.fn,
      runAgent: learner.fn,
    });

    // Round 1's bad proposal is rejected; round 2's good one is kept.
    expect(result.rejected.map(entry => entry.slug)).toContain('Bad Slug');
    expect(result.rejected[0].reason).toBe('invalid-slug');
    expect(result.kept).toHaveLength(1);
    expect(learner.calls.length).toBeGreaterThan(1);
  });

  it('holds the rounds cap', async () => {
    // Three failed tasks, each fixed by its own skill, so every round keeps one
    // and the loop only stops because it reached the cap.
    const tasks = [addTask(), addTask(), addTask()];
    for (const task of tasks) seedAttempt(task.id, false);

    const fixedMap: Record<number, string> = {};
    tasks.forEach((task, index) => {
      fixedMap[task.id] = `skill-${index}`;
    });
    const solve = fakeSolve(fixedBy(fixedMap));
    const learner = fakeLearner(round => [
      fixProposal({
        slug: `skill-${round}`,
        body: `project proj-a: ${GROUNDED_WORDS} work ${round} [#${hexId('proj-a-0')}]`,
        targets: [tasks[round].id],
      }),
    ]);

    const result = await runLeafLearner(dbs, {
      ...common(),
      runId,
      taskIds: tasks.map(task => task.id),
      rounds: 2,
      solve: solve.fn,
      runAgent: learner.fn,
    });

    expect(learner.calls.length).toBe(2);
    expect(result.rounds).toHaveLength(2);
  });

  it('never puts a test task in a learner prompt', async () => {
    const trainTask = addTask();
    const testTask = addTask({
      split: 'test',
      prompt: `Held-out test task about the ${GROUNDED_WORDS} decision ${counter}`,
    });
    seedAttempt(trainTask.id, false);

    const solve = fakeSolve(fixedBy({ [trainTask.id]: 'release-notes' }));
    const learner = fakeLearner([fixProposal()]);

    await runLeafLearner(dbs, {
      ...common(),
      runId,
      taskIds: [trainTask.id, testTask.id],
      solve: solve.fn,
      runAgent: learner.fn,
    });

    expect(learner.calls.length).toBeGreaterThan(0);
    for (const call of learner.calls) {
      expect(call.prompt).not.toContain(testTask.prompt);
      expect(call.prompt).not.toContain(`task ${testTask.id} `);
    }
  });

  it('records a failure for each failed task it diagnoses', async () => {
    const failed = addTask();
    seedAttempt(failed.id, false);
    const solve = fakeSolve(() => false);
    const learner = fakeLearner([]);

    await runLeafLearner(dbs, {
      ...common(),
      runId,
      taskIds: [failed.id],
      solve: solve.fn,
      runAgent: learner.fn,
    });

    const failures = await store.lookupFailures(failed.prompt, 10);
    expect(failures.length).toBeGreaterThan(0);
  });

  it('records run rejections for gate failures', async () => {
    const failed = addTask();
    seedAttempt(failed.id, false);
    const solve = fakeSolve(() => false);
    const learner = fakeLearner(round => (round === 0 ? [fixProposal({ slug: 'Bad Slug' })] : []));

    const result = await runLeafLearner(dbs, {
      ...common(),
      runId,
      taskIds: [failed.id],
      solve: solve.fn,
      runAgent: learner.fn,
    });

    const run = getRun(learning, runId)!;
    expect(run.rejections.map(entry => entry.slug)).toContain('Bad Slug');
    expect(result.rejected).toHaveLength(1);
  });

  it('solves the subset with the current snapshot each round', async () => {
    const failed = addTask();
    seedAttempt(failed.id, false);
    const solve = fakeSolve(() => false);
    const learner = fakeLearner([]);

    await runLeafLearner(dbs, {
      ...common(),
      runId,
      taskIds: [failed.id],
      solve: solve.fn,
      runAgent: learner.fn,
    });

    const solveCalls = solve.calls.filter(call => call.role === 'solve');
    expect(solveCalls).toHaveLength(1);
    const attempts = listAttempts(learning, { runId, role: 'solve' });
    expect(attempts.length).toBeGreaterThan(0);
  });

  it('returns a round count per round it ran', async () => {
    const failed = addTask();
    seedAttempt(failed.id, false);
    const solve = fakeSolve(fixedBy({ [failed.id]: 'release-notes' }));
    const learner = fakeLearner(round =>
      round === 0
        ? [fixProposal()]
        : [fixProposal({ slug: 'second', body: `project proj-a: other ${GROUNDED_WORDS} work [#${hexId('proj-a-0')}]` })]
    );

    const result = await runLeafLearner(dbs, {
      ...common(),
      runId,
      taskIds: [failed.id],
      solve: solve.fn,
      runAgent: learner.fn,
    });

    expect(result.rounds.every(round => typeof round.passed === 'number')).toBe(true);
    expect(result.rounds.every(round => typeof round.total === 'number')).toBe(true);
  });
});