import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Database } from '../../src/sqlite.js';
import { createHash } from 'node:crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { validateCandidate } from '../../src/learn/validate.js';
import { CallBudget } from '../../src/learn/solver.js';
import { openKnowledgeStore, type KnowledgeStore } from '../../src/learn/knowledge-store.js';
import { openLearningDb } from '../../src/learn/learning-store.js';
import {
  createRun,
  insertAttempt,
  insertTask,
  type LearningTask,
} from '../../src/learn/learning-db.js';
import {
  activate,
  getBySlug,
  getEntry,
  getSnapshot,
  insertKnowledgeEntry,
} from '../../src/learn/knowledge-db.js';
import type { AttemptRow, LearnDbs, SourceRef, TaskTruth } from '../../src/learn/types.js';
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

function source(): SourceRef {
  return truth().exchanges[0];
}

let dir: string;
let learning: Database;
let index: Database;
let store: KnowledgeStore;
let dbs: LearnDbs;
let runId: string;
const savedApprove = process.env.EPISODIC_MEMORY_LEARN_APPROVE;

beforeEach(() => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'em-validate-')));
  process.env.EPISODIC_MEMORY_CONFIG_DIR = dir;
  delete process.env.EPISODIC_MEMORY_LEARN_APPROVE;
  learning = openLearningDb({ path: path.join(dir, 'learned', 'learning.sqlite') });
  store = openKnowledgeStore({ dbPath: path.join(dir, 'learned', 'knowledge.db') });
  index = indexFixture();
  dbs = { store, learning, index };
  runId = createRun(learning, { phase: 'improve', seed: 7, budget: {} });
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

let nextPrompt = 0;

function addTask(over: Partial<Omit<LearningTask, 'id'>> = {}): LearningTask {
  nextPrompt += 1;
  const task = {
    runId,
    kind: 'locate' as const,
    tier: 2 as const,
    split: 'train' as const,
    project: 'proj-a',
    prompt: `Where was the ${GROUNDED_WORDS} discussed, question ${nextPrompt}?`,
    truth: truth(),
    status: 'ok' as const,
    ...over,
  };
  const id = insertTask(learning, task);
  return { ...task, id };
}

/** Record a graded attempt, the way a solve would have. */
function seedAttempt(taskId: number, passed: boolean, answer?: string): number {
  return insertAttempt(learning, {
    taskId,
    runId,
    snapshotId: 1,
    role: 'solve',
    passed,
    score: passed ? 1 : 0,
    answer: answer ?? (passed ? 'path: /archive/proj-a/s-0.jsonl\nlines: 1-9' : 'not found'),
    trace: [],
    cost: { turns: 4, inputTokens: 10, outputTokens: 5, usd: 0.02 },
    outcome: 'graded',
  });
}

async function addSkill(
  over: { slug?: string; project?: string; body?: string } = {}
): Promise<string> {
  const name = await insertKnowledgeEntry(store, {
    kind: 'skill',
    project: over.project ?? 'proj-a',
    slug: over.slug ?? 'release-notes',
    title: 'Where release work lives',
    description: 'Use when asked about a release build or packaging change',
    body: over.body ?? `project proj-a: ${GROUNDED_WORDS} work [#${hexId('proj-a-0')}]`,
    scope: 'proj-a',
    confidence: 'medium',
    trust: 'unverified',
    sources: [source()],
    status: 'candidate',
    runId,
  });
  return name;
}

/**
 * A fake solver: `pass` decides the grade from the evaluation snapshot's entry names.
 * The entry names are the only thing a candidate can change.
 */
function fakeSolve(
  pass: (names: string[], task: LearningTask, role: string) => boolean,
  outcome: AttemptRow['outcome'] = 'graded'
) {
  const calls: Array<{ taskId: number; role: string; names: string[] }> = [];
  const fn = async (
    solverDbs: LearnDbs,
    task: LearningTask,
    options: any
  ): Promise<AttemptRow> => {
    const names = getSnapshot(solverDbs.learning, options.snapshotId);
    const passed = pass(names, task, options.role);
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
      outcome,
    };
    const id = insertAttempt(solverDbs.learning, attempt);
    return { ...attempt, id, createdAt: new Date().toISOString() };
  };
  return { fn: fn as any, calls };
}

const noPids = { add() {}, remove() {} };

describe('validateCandidate', () => {
  it('keeps and activates a skill whose targeted task passes without a regression', async () => {
    const target = addTask();
    const sampled = addTask({ kind: 'when' });
    seedAttempt(target.id, false);
    seedAttempt(sampled.id, true);

    const candidate = await addSkill();
    const solve = fakeSolve(names => names.some(name => name.includes(':release-notes:v')));

    const record = await validateCandidate(dbs, candidate, {
      targeted: [target.id],
      sampleFrom: [sampled.id],
      sampleSize: 5,
      seed: 3,
      solve: solve.fn,
      runId,
      budget: new CallBudget(20),
    });

    expect(record.keep).toBe(true);
    expect(record.targeted).toEqual([target.id]);
    expect(record.sample).toEqual([sampled.id]);
    expect(record.passedBefore).toBe(1);
    expect(record.passedAfter).toBe(2);
    expect(record.regressions).toEqual([]);
    expect(record.meanTurnsBefore).toBe(4);
    expect(record.meanTurnsAfter).toBe(3);

    const entry = await getEntry(store, candidate);
    expect(entry!.status).toBe('active');
    expect(entry!.trust).toBe('verified');
    expect(entry!.validation?.passedAfter).toBe(2);

    // The validation re-solve ran with role `validate`.
    expect(solve.calls.every(call => call.role === 'validate')).toBe(true);
  });

  it('renders the learned block after a kept skill activates', async () => {
    const target = addTask();
    seedAttempt(target.id, false);
    const candidate = await addSkill();
    const solve = fakeSolve(names => names.some(name => name.includes(':release-notes:v')));

    await validateCandidate(dbs, candidate, {
      targeted: [target.id],
      sampleFrom: [],
      sampleSize: 5,
      seed: 3,
      solve: solve.fn,
      runId,
      budget: new CallBudget(20),
    });

    const row = learning
      .prepare('SELECT text FROM learned_block WHERE project = ?')
      .get('proj-a') as { text: string } | undefined;
    expect(row?.text).toContain('release-notes');
  });

  it('drops an edit that regresses a sampled task and keeps the row as a candidate', async () => {
    const target = addTask();
    const sampled = addTask({ kind: 'when' });
    seedAttempt(target.id, false);
    seedAttempt(sampled.id, true);

    const candidate = await addSkill();
    // The candidate fixes the target but breaks the sampled task.
    const solve = fakeSolve(
      (names, task) =>
        names.some(name => name.includes(':release-notes:v')) && task.id === target.id
    );

    const record = await validateCandidate(dbs, candidate, {
      targeted: [target.id],
      sampleFrom: [sampled.id],
      sampleSize: 5,
      seed: 3,
      solve: solve.fn,
      runId,
      budget: new CallBudget(20),
    });

    expect(record.keep).toBe(false);
    expect(record.regressions).toEqual([sampled.id]);

    const entry = await getEntry(store, candidate);
    // Never deleted, never activated: it waits as a candidate with its record.
    expect(entry).not.toBeNull();
    expect(entry!.status).toBe('candidate');
    expect(entry!.validation?.regressions).toEqual([sampled.id]);
    // The edit's decision was rejected, with a reason.
    const decision = store.getDecision(entry!.decisionId!);
    expect(decision!.status).toBe('rejected');
  });

  it('drops an edit no targeted task now passes', async () => {
    const target = addTask();
    seedAttempt(target.id, false);
    const candidate = await addSkill();
    const solve = fakeSolve(() => false);

    const record = await validateCandidate(dbs, candidate, {
      targeted: [target.id],
      sampleFrom: [],
      sampleSize: 5,
      seed: 3,
      solve: solve.fn,
      runId,
      budget: new CallBudget(20),
    });

    expect(record.keep).toBe(false);
    // One task set before and after, so the record compares counts and holds no gradedBefore.
    expect(record.gradedBefore).toBeUndefined();
    expect(record.gradedAfter).toBe(1);
    expect((await getEntry(store, candidate))!.status).toBe('candidate');
  });

  // An errored re-solve still stores an attempt row, so meanTurnsAfter alone cannot show that nothing was graded.
  it('records no graded task after the change when every re-solve errors', async () => {
    const target = addTask();
    seedAttempt(target.id, false);
    const candidate = await addSkill();
    const solve = fakeSolve(() => false, 'error');

    const record = await validateCandidate(dbs, candidate, {
      targeted: [target.id],
      sampleFrom: [],
      sampleSize: 5,
      seed: 3,
      solve: solve.fn,
      runId,
      budget: new CallBudget(20),
    });

    expect(record.keep).toBe(false);
    expect(record.meanTurnsAfter).not.toBeNull();
    expect(record.gradedAfter).toBe(0);
    expect((await getEntry(store, candidate))!.validation?.gradedAfter).toBe(0);
  });

  it('leaves an instruction candidate under the default approve mode', async () => {
    const target = addTask();
    seedAttempt(target.id, false);
    const name = await insertKnowledgeEntry(store, {
      kind: 'instruction',
      project: 'proj-a',
      slug: 'release-map',
      title: 'Release map',
      description: 'Where release work lives in this project',
      body: `project proj-a: ${GROUNDED_WORDS} work [#${hexId('proj-a-0')}]`,
      scope: 'proj-a',
      confidence: 'medium',
      trust: 'unverified',
      sources: [source()],
      status: 'candidate',
      runId,
    });
    const solve = fakeSolve(names => names.some(n => n.includes(':release-map:v')));

    const record = await validateCandidate(dbs, name, {
      targeted: [target.id],
      sampleFrom: [],
      sampleSize: 5,
      seed: 3,
      solve: solve.fn,
      runId,
      budget: new CallBudget(20),
    });

    expect(record.keep).toBe(true);
    const entry = await getEntry(store, name);
    expect(entry!.status).toBe('candidate');
    expect(entry!.validation).not.toBeNull();
    // Its heuristic was reinforced by the kept validation.
    expect(entry!.heuristicIds.length).toBeGreaterThan(0);
  });

  it('activates an instruction under approve mode none', async () => {
    process.env.EPISODIC_MEMORY_LEARN_APPROVE = 'none';
    const target = addTask();
    seedAttempt(target.id, false);
    const name = await insertKnowledgeEntry(store, {
      kind: 'instruction',
      project: 'proj-a',
      slug: 'release-map',
      title: 'Release map',
      description: 'Where release work lives in this project',
      body: `project proj-a: ${GROUNDED_WORDS} work [#${hexId('proj-a-0')}]`,
      scope: 'proj-a',
      confidence: 'medium',
      trust: 'unverified',
      sources: [source()],
      status: 'candidate',
      runId,
    });
    const solve = fakeSolve(names => names.some(n => n.includes(':release-map:v')));

    await validateCandidate(dbs, name, {
      targeted: [target.id],
      sampleFrom: [],
      sampleSize: 5,
      seed: 3,
      solve: solve.fn,
      runId,
      budget: new CallBudget(20),
    });

    expect((await getEntry(store, name))!.status).toBe('active');
  });

  it('evaluates a revision against the active version it supersedes', async () => {
    const target = addTask();
    seedAttempt(target.id, false);

    const v1 = await addSkill();
    await activate(store, v1, null, 'verified');
    const v2 = await addSkill({ body: `project proj-a: ${GROUNDED_WORDS} work [#${hexId('proj-a-0')}] and more` });
    expect((await getBySlug(store, 'skill', 'proj-a', 'release-notes'))!.version).toBe(2);

    const solve = fakeSolve(names => names.some(name => name.endsWith(':v2')));

    await validateCandidate(dbs, v2, {
      targeted: [target.id],
      sampleFrom: [],
      sampleSize: 5,
      seed: 3,
      solve: solve.fn,
      runId,
      budget: new CallBudget(20),
    });

    const names = solve.calls[0].names;
    expect(names).toContain(v2);
    expect(names).not.toContain(v1);
  });

  it('records a decision for the edit before validating it', async () => {
    const target = addTask();
    seedAttempt(target.id, false);
    const candidate = await addSkill();
    const solve = fakeSolve(() => false);

    await validateCandidate(dbs, candidate, {
      targeted: [target.id],
      sampleFrom: [],
      sampleSize: 5,
      seed: 3,
      solve: solve.fn,
      runId,
      budget: new CallBudget(20),
    });

    const entry = await getEntry(store, candidate);
    const decision = store.getDecision(entry!.decisionId!);
    expect(decision).not.toBeNull();
    expect(decision!.context).toContain(String(target.id));
  });
});
