/**
 * Relay challenger probes for Task 8 (leaf learner loop with validation).
 *
 * These tests attack the PR's invariants directly. Each one is written against
 * the plan (docs/superpowers/plans/2026-11-05-recursa-self-improving-memory.md,
 * Task 8) and the spec (§6.2 step 4, §7 rules 5 and 10a). A failure here is a
 * finding, not a flake.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Database } from '../../src/sqlite.js';
import { createHash } from 'node:crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { runLeafLearner, suspectTaskIds } from '../../src/learn/leaf-learner.js';
import { CallBudget, BudgetExhausted } from '../../src/learn/solver.js';
import { openKnowledgeStore, type KnowledgeStore } from '../../src/learn/knowledge-store.js';
import { openLearningDb } from '../../src/learn/learning-store.js';
import {
  createRun,
  insertAttempt,
  insertTask,
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

function indexFixture(project = 'proj-a'): Database {
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
let learning: Database;
let index: Database;
let store: KnowledgeStore;
let dbs: LearnDbs;
let runId: string;
let counter = 0;

beforeEach(() => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'em-challenger-')));
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
      delete process.env.EPISODIC_MEMORY_LEARN_APPROVE;
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

function fakeSolve(pass: (slugs: string[], taskId: number) => boolean) {
  const fn = async (
    solverDbs: LearnDbs,
    task: LearningTask,
    options: any
  ): Promise<AttemptRow> => {
    const names = getSnapshot(solverDbs.learning, options.snapshotId);
    const slugs = names.map(name => name.split(':')[3]);
    const passed = pass(slugs, task.id);
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
  return fn as any;
}

function fakeLearner(proposals: ProposedEntry[]) {
  const fn = async (options: any) => {
    const instance = (options.server as any).instance as {
      _registeredTools: Record<string, { handler: (a: any, e: any) => Promise<any> }>;
    };
    const handler = instance._registeredTools.propose_entry?.handler;
    if (handler) {
      for (const proposal of proposals) await handler({ ...proposal }, {});
    }
    return {
      text: 'diagnosed',
      trace: [],
      cost: { turns: 5, inputTokens: 10, outputTokens: 5, usd: 0.01 },
      outcome: 'graded' as const,
      toolsSeen: [],
    };
  };
  return { fn: fn as any };
}

const common = () => ({
  project: 'proj-a',
  rounds: 3,
  editsPerRound: 3,
  model: 'test-model',
});

describe('relay challenger: task 8', () => {
  it('a budget spent mid-validation stops the loop instead of crashing it (§7 rule 10a)', async () => {
    const failed = addTask();
    seedAttempt(failed.id, false);

    // The fake solver honours the budget exactly like the real one, but only
    // on the validation role: the round's own solve is free, the learner's own
    // call consumes the single call, and the first validation re-solve must
    // find the budget spent.
    const solve = fakeSolve(() => false);
    const budgetedSolve = async (d: LearnDbs, t: LearningTask, o: any) => {
      if (o.role === 'validate') o.budget?.spend();
      return solve(d, t, o);
    };

    const learner = fakeLearner([fixProposal()]);

    // A spent budget stops the run and keeps everything validated so far; it
    // must not escape `runLeafLearner` as an unhandled rejection.
    let observed: unknown;
    try {
      observed = await runLeafLearner(dbs, {
        ...common(),
        runId,
        taskIds: [failed.id],
        solve: budgetedSolve,
        runAgent: learner.fn,
        budget: new CallBudget(1),
      });
    } catch (error) {
      observed = `THREW:${(error as Error).name}:${(error as Error).message}`;
    }

    const result = observed as any;
    expect(result.kept).toEqual([]);
    expect(result.rounds.length).toBeGreaterThan(0);
  });

  it('one attempt naming two paths is not two solvers disagreeing (§6.2 step 4)', () => {
    const task = addTask();
    const attempt: AttemptRow = {
      id: 1,
      taskId: task.id,
      runId,
      snapshotId: 1,
      role: 'solve',
      passed: false,
      score: 0,
      answer: 'path: /archive/proj-a/a.jsonl\nlines: 1-9\npath: /archive/proj-a/b.jsonl\nlines: 20-30',
      trace: [],
      cost: { turns: 2, inputTokens: 4, outputTokens: 2, usd: 0.01 },
      outcome: 'graded',
      createdAt: new Date().toISOString(),
    };

    // The suspect criterion needs two attempts in the round. One attempt that
    // hedged across two addresses is one solver's answer, not disagreement
    // between two solvers.
    expect(suspectTaskIds([attempt])).toEqual([]);
  });

  it('a passing attempt does not make a task suspect (two solvers must FAIL)', () => {
    const task = addTask();
    const attempts: AttemptRow[] = [
      {
        id: 1,
        taskId: task.id,
        runId,
        snapshotId: 1,
        role: 'solve',
        passed: true,
        score: 1,
        answer: 'path: /archive/proj-a/s-0.jsonl\nlines: 1-9',
        trace: [],
        cost: { turns: 2, inputTokens: 4, outputTokens: 2, usd: 0.01 },
        outcome: 'graded',
        createdAt: new Date().toISOString(),
      },
      {
        id: 2,
        taskId: task.id,
        runId,
        snapshotId: 1,
        role: 'solve',
        passed: false,
        score: 0,
        answer: 'path: /archive/proj-a/other.jsonl\nlines: 1-9',
        trace: [],
        cost: { turns: 2, inputTokens: 4, outputTokens: 2, usd: 0.01 },
        outcome: 'graded',
        createdAt: new Date().toISOString(),
      },
    ];

    // One solver found the truth and passed; the task's ground is demonstrably
    // reliable. Only two failing, confident, contradictory answers are noise.
    expect(suspectTaskIds(attempts)).toEqual([]);
  });

  it('targets that are all suspect fall back to the round\'s other failures, not an empty set', async () => {
    const suspect = addTask();
    const target = addTask();
    seedAttempt(target.id, false);
    seedAttempt(suspect.id, false);

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

    // The model named only the suspect task, but its edit fixes the other
    // failure. The validation set must not collapse to empty: an empty
    // `targeted` guarantees a drop and rejects a decision that was never
    // measured against anything.
    const solve = fakeSolve((slugs, taskId) => taskId === target.id && slugs.includes('release-notes'));
    const learner = fakeLearner([fixProposal({ targets: [suspect.id] })]);

    const result = await runLeafLearner(dbs, {
      ...common(),
      runId,
      taskIds: [suspect.id, target.id],
      solve,
      runAgent: learner.fn,
      budget: new CallBudget(200),
    });

    expect(result.kept).toHaveLength(1);
  });
});
