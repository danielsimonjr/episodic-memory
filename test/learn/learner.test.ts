import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Database } from '../../src/sqlite.js';
import { createHash } from 'node:crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { runLearn } from '../../src/learn/learner.js';
import { CallBudget } from '../../src/learn/solver.js';
import { openKnowledgeStore, type KnowledgeStore } from '../../src/learn/knowledge-store.js';
import { openLearningDb } from '../../src/learn/learning-store.js';
import {
  createRun,
  finishRun,
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

const WORDS = 'release build native module sentinel';

function hexId(label: string): string {
  return createHash('sha256').update(label).digest('hex').slice(0, 32);
}

function indexFixture(projects: string[]): Database {
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
  const insert = db.prepare(
    `INSERT INTO exchanges
       (id, project, timestamp, user_message, assistant_message, archive_path,
        line_start, line_end, is_sidechain, session_id)
     VALUES (?, ?, '2026-03-01T10:00:00.000Z', ?, ?, ?, 1, 9, 0, ?)`
  );
  for (const project of projects) {
    for (let i = 0; i < 6; i += 1) {
      insert.run(
        hexId(`${project}-${i}`),
        project,
        `How does the ${WORDS} work, question ${i}?`,
        `The ${WORDS} is checked.`,
        `/archive/${project}/s-${i}.jsonl`,
        `session-${i}`
      );
    }
  }
  return db;
}

function truth(project: string, index: number): TaskTruth {
  return {
    exchanges: [
      {
        id: hexId(`${project}-${index}`),
        path: `/archive/${project}/s-${index}.jsonl`,
        lineStart: 1,
        lineEnd: 9,
        sessionId: `session-${index}`,
      },
    ],
    sessionDateRange: ['2026-03-01', '2026-03-01'],
    project,
    assistantMessage: `The ${WORDS} is checked.`,
  };
}

let dir: string;
let learning: Database;
let index: Database;
let store: KnowledgeStore;
let dbs: LearnDbs;
let counter = 0;
const savedConfig = process.env.EPISODIC_MEMORY_CONFIG_DIR;
const savedApprove = process.env.EPISODIC_MEMORY_LEARN_APPROVE;

beforeEach(() => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'em-learn-')));
  process.env.EPISODIC_MEMORY_CONFIG_DIR = dir;
  delete process.env.EPISODIC_MEMORY_LEARN_APPROVE;
  learning = openLearningDb({ path: path.join(dir, 'learned', 'learning.sqlite') });
  store = openKnowledgeStore({ dbPath: path.join(dir, 'learned', 'knowledge.db') });
  counter = 0;
});

afterEach(() => {
  try {
    store.close();
  } finally {
    try {
      learning.close();
    } finally {
      index?.close();
      if (savedConfig === undefined) delete process.env.EPISODIC_MEMORY_CONFIG_DIR;
      else process.env.EPISODIC_MEMORY_CONFIG_DIR = savedConfig;
      if (savedApprove === undefined) delete process.env.EPISODIC_MEMORY_LEARN_APPROVE;
      else process.env.EPISODIC_MEMORY_LEARN_APPROVE = savedApprove;
      safeRmSync(dir);
    }
  }
});

function openFixture(projects: string[]): void {
  index = indexFixture(projects);
  dbs = { store, learning, index };
}

/** One stored task, owned by a throwaway run, as `learn tasks` would leave it. */
function addTask(over: Partial<Omit<LearningTask, 'id'>> & { project: string }): LearningTask {
  counter += 1;
  const owner = createRun(learning, { phase: 'improve', seed: 1, budget: {} });
  finishRun(learning, owner, 'done', {});
  const task = {
    runId: owner,
    kind: 'locate' as const,
    tier: 2 as const,
    split: 'train' as const,
    prompt: `Where was the ${WORDS} discussed, question ${counter}?`,
    truth: truth(over.project, 0),
    status: 'ok' as const,
    ...over,
  };
  const id = insertTask(learning, task);
  return { ...task, id };
}

interface SolveCall {
  taskId: number;
  split: string;
  role: string;
  snapshotId: number;
}

/**
 * A fake solver whose pass set is a function of the snapshot's entries.
 *
 * The only thing a candidate, a merge or a revert can change is which entries
 * the evaluation snapshot holds.
 * So the entries are the fake's whole input.
 */
function fakeSolve(
  pass: (entries: Array<{ name: string; body: string; slug: string }>, task: LearningTask) => boolean,
  journal?: string[],
  outcomeOf: (entries: Array<{ name: string; body: string; slug: string }>, task: LearningTask) => AttemptRow['outcome'] = () =>
    'graded'
) {
  const calls: SolveCall[] = [];
  const fn = async (solverDbs: LearnDbs, task: LearningTask, options: any): Promise<AttemptRow> => {
    // Production `solveTask` spends one call from the run's budget; the fake
    // does the same so a cap test measures the real accounting.
    options.budget?.spend();
    const names = getSnapshot(solverDbs.learning, options.snapshotId);
    const entries: Array<{ name: string; body: string; slug: string }> = [];
    for (const name of names) {
      const entry = await solverDbs.store.getEntry(name);
      if (entry) entries.push({ name, body: entry.body, slug: entry.slug });
    }
    const outcome = outcomeOf(entries, task);
    const passed = outcome === 'graded' && pass(entries, task);
    calls.push({
      taskId: task.id,
      split: task.split,
      role: options.role,
      snapshotId: options.snapshotId,
    });
    journal?.push(`solve:${task.split}:${task.id}`);
    const attempt = {
      taskId: task.id,
      runId: options.runId,
      snapshotId: options.snapshotId,
      role: options.role as AttemptRow['role'],
      passed,
      score: passed ? 1 : 0,
      answer: passed ? `path: /archive/${task.project}/s-0.jsonl\nlines: 1-9` : 'not found',
      trace: [],
      cost: { turns: 3, inputTokens: 8, outputTokens: 4, usd: 0.01 },
      outcome,
    };
    const id = insertAttempt(solverDbs.learning, attempt);
    return { ...attempt, id, createdAt: new Date().toISOString() };
  };
  return { fn: fn as any, calls };
}

/** The task ids a diagnose prompt names, in order. */
function promptTaskIds(prompt: string): number[] {
  return [...prompt.matchAll(/^- task (\d+) \(/gm)].map(match => Number(match[1]));
}

interface LearnerCall {
  prompt: string;
  systemPrompt: string;
}

/** A fake learner agent that proposes through the server's own handler. */
function fakeLearner(
  propose: (prompt: string) => ProposedEntry[],
  journal?: string[],
  delayMs = 1
) {
  const calls: LearnerCall[] = [];
  let active = 0;
  const stats = { maxActive: 0 };
  const fn = async (options: any) => {
    calls.push({ prompt: options.prompt, systemPrompt: options.systemPrompt });
    active += 1;
    stats.maxActive = Math.max(stats.maxActive, active);
    journal?.push('learner');
    try {
      await new Promise(resolve => setTimeout(resolve, delayMs));
      const instance = (options.server as any).instance as {
        _registeredTools: Record<string, { handler: (a: any, e: any) => Promise<any> }>;
      };
      const handler = instance._registeredTools.propose_entry?.handler;
      if (handler) {
        for (const proposal of propose(options.prompt)) await handler({ ...proposal }, {});
      }
    } finally {
      active -= 1;
    }
    return {
      text: 'diagnosed',
      trace: [],
      cost: { turns: 5, inputTokens: 10, outputTokens: 5, usd: 0.01 },
      outcome: 'graded' as const,
      toolsSeen: [],
    };
  };
  return { fn: fn as any, calls, stats };
}

/** The union of `#<32 hex>` marks a prompt quotes. */
function marksIn(prompt: string): string[] {
  return [...new Set([...prompt.matchAll(/#[0-9a-f]{32}/g)].map(match => match[0]))];
}

interface TextModelHandlers {
  split?: string | ((prompt: string) => string);
  merge?: string | ((prompt: string) => string);
  reflect?: string | ((prompt: string) => string);
}

function fakeTextModel(handlers: TextModelHandlers = {}, journal?: string[]) {
  const calls: string[] = [];
  const pick = (
    handler: string | ((prompt: string) => string) | undefined,
    fallback: (prompt: string) => string,
    prompt: string
  ): string => (typeof handler === 'function' ? handler(prompt) : handler ?? fallback(prompt));

  const fn = async (prompt: string): Promise<string> => {
    calls.push(prompt);
    journal?.push('text');
    if (prompt.includes('Partition these failed')) {
      return pick(handlers.split, () => '', prompt);
    }
    if (prompt.includes('Merge these versions')) {
      return pick(
        handlers.merge,
        p => `project proj-a: ${WORDS} merged [${marksIn(p).join(', ')}]\n`,
        prompt
      );
    }
    if (prompt.includes('Write one reflection')) {
      return pick(
        handlers.reflect,
        p => `release build native module findings landed [${marksIn(p)[0] ?? `#${'0'.repeat(32)}`}]\n`,
        prompt
      );
    }
    return '';
  };
  return { fn, calls };
}

function proposalFor(
  taskId: number,
  project: string,
  over: Partial<ProposedEntry> = {}
): ProposedEntry {
  return {
    kind: 'skill',
    project,
    slug: `fix-${taskId}`,
    title: `Fix ${taskId}`,
    description: `Use when asked about the ${WORDS}`,
    body: `project ${project}: ${WORDS} work [#${hexId(`${project}-0`)}]`,
    scope: project,
    confidence: 'medium',
    targets: [taskId],
    ...over,
  };
}

function common(over: Record<string, unknown> = {}) {
  return {
    model: 'test-model',
    concurrency: 2,
    rounds: 1,
    leafMax: 12,
    budget: new CallBudget(200),
    ...over,
  };
}

function childRuns(parentRunId: string) {
  return learning
    .prepare('SELECT * FROM learning_run WHERE parent_run_id = ? ORDER BY rowid')
    .all(parentRunId) as Array<{ id: string; project: string; status: string }>;
}

function activeSlugs(entries: Array<{ slug: string }>): string[] {
  return entries.map(entry => entry.slug);
}

/** True when any snapshot entry's body cites `id`. */
function cites(entries: Array<{ body: string }>, id: string): boolean {
  return entries.some(entry => entry.body.includes(id));
}

describe('runLearn', () => {
  it('gives failures in two projects two child runs with parent_run_id', async () => {
    openFixture(['proj-a', 'proj-b']);
    const tasks = [
      addTask({ project: 'proj-a' }),
      addTask({ project: 'proj-a' }),
      addTask({ project: 'proj-b' }),
      addTask({ project: 'proj-b' }),
    ];
    const byId = new Map(tasks.map(task => [task.id, task.project]));

    const solve = fakeSolve(
      (entries, task) => activeSlugs(entries).includes(`fix-${task.id}`)
    );
    const learner = fakeLearner(prompt =>
      promptTaskIds(prompt).map(id => proposalFor(id, byId.get(id)!))
    );
    const text = fakeTextModel({
      split: () =>
        `- wrong project: ${tasks[0].id}, ${tasks[2].id}\n- paraphrase not matched: ${tasks[1].id}, ${tasks[3].id}\n`,
    });

    const result = await runLearn(dbs, {
      ...common(),
      solve: solve.fn,
      runAgent: learner.fn,
      textModel: text.fn,
    });

    const children = childRuns(result.runId);
    expect(children).toHaveLength(2);
    expect(children.map(child => child.project).sort()).toEqual(['proj-a', 'proj-b']);
    expect(result.children).toEqual(children.map(child => child.id));
    // Each child's tasks stayed inside its own project.
    for (const child of children) {
      const rows = learning
        .prepare('SELECT DISTINCT project FROM learning_task WHERE id IN (SELECT task_id FROM learning_attempt WHERE run_id = ?)')
        .all(child.id) as Array<{ project: string }>;
      expect(rows.map(row => row.project)).toEqual([child.project]);
    }
  });

  it('falls back to by-project when the split answer is not a partition', async () => {
    openFixture(['proj-a']);
    const tasks = [addTask({ project: 'proj-a' }), addTask({ project: 'proj-a' })];

    const solve = fakeSolve((entries, task) =>
      activeSlugs(entries).includes(`fix-${task.id}`)
    );
    const learner = fakeLearner(prompt =>
      promptTaskIds(prompt).map(id => proposalFor(id, 'proj-a'))
    );
    // Names one task and invents another: not a partition of the failed ids.
    const text = fakeTextModel({ split: `- wrong project: ${tasks[0].id}, 999\n` });

    const result = await runLearn(dbs, {
      ...common({ leafMax: 1 }),
      solve: solve.fn,
      runAgent: learner.fn,
      textModel: text.fn,
    });

    expect(text.calls.some(call => call.includes('Partition these failed'))).toBe(true);
    const children = childRuns(result.runId);
    expect(children).toHaveLength(1);
    expect(children[0].project).toBe('proj-a');
  });

  it('merges duplicate slugs from two children into one entry citing the union of sources', async () => {
    openFixture(['proj-a']);
    const first = addTask({ project: 'proj-a' });
    const second = addTask({ project: 'proj-a' });
    const sourceOf = new Map([
      [first.id, hexId('proj-a-0')],
      [second.id, hexId('proj-a-1')],
    ]);

    // Each task is found once an active entry cites its own source, so the two
    // children independently need their own version of the same slug.
    const solve = fakeSolve((entries, task) => cites(entries, sourceOf.get(task.id)!));
    const learner = fakeLearner(prompt =>
      promptTaskIds(prompt).map(id =>
        proposalFor(id, 'proj-a', {
          slug: 'release-map',
          title: 'Release map',
          body: `project proj-a: ${WORDS} work [#${sourceOf.get(id)}]`,
        })
      )
    );
    const text = fakeTextModel({
      split: () => `- wrong project: ${first.id}\n- paraphrase not matched: ${second.id}\n`,
      merge: prompt => `project proj-a: ${WORDS} merged [${marksIn(prompt).join(', ')}]\n`,
    });

    const result = await runLearn(dbs, {
      ...common({ leafMax: 1, concurrency: 1 }),
      solve: solve.fn,
      runAgent: learner.fn,
      textModel: text.fn,
    });

    expect(childRuns(result.runId)).toHaveLength(2);
    const active = (await store.listByStatus(['active'], ['skill'])).filter(
      entry => entry.slug === 'release-map' && entry.supersededBy === null
    );
    expect(active).toHaveLength(1);
    expect(active[0].version).toBe(3);
    // The merge-check graded both child tasks after the merge.
    expect(active[0].validation?.gradedAfter).toBe(2);
    expect(active[0].body).toContain(sourceOf.get(first.id)!);
    expect(active[0].body).toContain(sourceOf.get(second.id)!);

    expect(result.merges).toHaveLength(1);
    expect(result.merges[0].sources.sort()).toEqual(
      [sourceOf.get(first.id)!, sourceOf.get(second.id)!].sort()
    );
    expect(result.merges[0].revertedTo).toBeNull();
  });

  // An errored re-solve stores an attempt row but grades no task, so the merge-check record counts one task.
  it('counts only graded attempts in the merge-check record', async () => {
    openFixture(['proj-a']);
    const first = addTask({ project: 'proj-a' });
    const second = addTask({ project: 'proj-a' });
    const sourceOf = new Map([
      [first.id, hexId('proj-a-0')],
      [second.id, hexId('proj-a-1')],
    ]);

    const solve = fakeSolve(
      (entries, task) => cites(entries, sourceOf.get(task.id)!),
      undefined,
      (entries, task) =>
        task.id === second.id && entries.some(entry => entry.body.includes('merged')) ? 'error' : 'graded'
    );
    const learner = fakeLearner(prompt =>
      promptTaskIds(prompt).map(id =>
        proposalFor(id, 'proj-a', {
          slug: 'release-map',
          title: 'Release map',
          body: `project proj-a: ${WORDS} work [#${sourceOf.get(id)}]`,
        })
      )
    );
    const text = fakeTextModel({
      split: () => `- wrong project: ${first.id}\n- paraphrase not matched: ${second.id}\n`,
      merge: prompt => `project proj-a: ${WORDS} merged [${marksIn(prompt).join(', ')}]\n`,
    });

    const result = await runLearn(dbs, {
      ...common({ leafMax: 1, concurrency: 1 }),
      solve: solve.fn,
      runAgent: learner.fn,
      textModel: text.fn,
    });

    expect(result.merges).toHaveLength(1);
    const merged = await store.getEntry(result.merges[0].merged);
    expect(merged?.validation?.sample).toHaveLength(2);
    expect(merged?.validation?.gradedAfter).toBe(1);
  });

  it("reverts a merged entry that regresses a child's sample, and the reflection says so", async () => {
    openFixture(['proj-a']);
    const first = addTask({ project: 'proj-a' });
    const second = addTask({ project: 'proj-a' });
    const sourceOf = new Map([
      [first.id, hexId('proj-a-0')],
      [second.id, hexId('proj-a-1')],
    ]);

    // Both children's tasks are found by an entry citing their own source, but
    // the merged body's wording makes the second task miss again.
    const solve = fakeSolve((entries, task) => {
      const cited = cites(entries, sourceOf.get(task.id)!);
      if (task.id === second.id) return cited && !entries.some(entry => entry.body.includes('merged'));
      return cited;
    });
    const learner = fakeLearner(prompt =>
      promptTaskIds(prompt).map(id =>
        proposalFor(id, 'proj-a', {
          slug: 'release-map',
          title: 'Release map',
          body: `project proj-a: ${WORDS} work [#${sourceOf.get(id)}]`,
        })
      )
    );
    const text = fakeTextModel({
      split: () => `- wrong project: ${first.id}\n- paraphrase not matched: ${second.id}\n`,
      merge: prompt => `project proj-a: ${WORDS} merged [${marksIn(prompt).join(', ')}]\n`,
      reflect: prompt =>
        `release build native module merge reverted to the child version [${marksIn(prompt)[0]}]\n`,
    });

    const result = await runLearn(dbs, {
      ...common({ leafMax: 1, concurrency: 1 }),
      solve: solve.fn,
      runAgent: learner.fn,
      textModel: text.fn,
    });

    // The child's version is live again and the merged version is retired.
    const active = (await store.listByStatus(['active'], ['skill'])).filter(
      entry => entry.slug === 'release-map' && entry.supersededBy === null
    );
    expect(active).toHaveLength(1);
    expect(result.merges).toHaveLength(1);
    expect(active[0].id).toBe(result.merges[0].revertedTo);
    expect(active[0].id).not.toBe(result.merges[0].merged);
    expect(active[0].body).not.toContain('merged');

    const merged = await store.getEntry(result.merges[0].merged);
    expect(merged?.status).toBe('retired');

    expect(result.merges[0].regressions).toContain(second.id);

    const reflections = await store.listByStatus(['candidate', 'active'], ['reflection']);
    expect(reflections.length).toBeGreaterThan(0);
    expect(reflections[0].body).toMatch(/reverted/i);
    // The revert is also a recorded rejection on the run, which is what the
    // reflection prompt quotes.
    const run = getRun(learning, result.runId)!;
    expect(run.rejections.some(entry => /revert/i.test(entry.reason))).toBe(true);
  });

  it('solves the test split exactly once, after the last round, and never shows a learner a test task', async () => {
    openFixture(['proj-a']);
    const train = addTask({ project: 'proj-a' });
    const held = addTask({ project: 'proj-a', split: 'test', prompt: `Held-out question about the ${WORDS}` });

    const journal: string[] = [];
    const solve = fakeSolve(
      (entries, task) => task.split === 'test' || activeSlugs(entries).includes(`fix-${task.id}`),
      journal
    );
    const learner = fakeLearner(
      prompt => promptTaskIds(prompt).map(id => proposalFor(id, 'proj-a')),
      journal
    );
    const text = fakeTextModel({}, journal);

    await runLearn(dbs, {
      ...common(),
      solve: solve.fn,
      runAgent: learner.fn,
      textModel: text.fn,
    });

    const testCalls = solve.calls.filter(call => call.split === 'test');
    expect(testCalls).toHaveLength(1);
    expect(testCalls[0].taskId).toBe(held.id);

    // The one test solve is the last thing the run does with a task.
    const testIndex = journal.findIndex(entry => entry.startsWith(`solve:test:`));
    const lastLearner = journal.map(entry => entry === 'learner').lastIndexOf(true);
    expect(testIndex).toBeGreaterThan(lastLearner);

    for (const call of [...learner.calls, ...text.calls.map(prompt => ({ prompt }))]) {
      expect(call.prompt).not.toContain(held.prompt);
      expect(call.prompt).not.toContain(`task ${held.id} `);
    }
  });

  it('records train and test pass rates per tier before and after on the run', async () => {
    openFixture(['proj-a']);
    const train = addTask({ project: 'proj-a', kind: 'locate', tier: 2 });
    addTask({ project: 'proj-a', kind: 'when', tier: 3, split: 'test' });

    const solve = fakeSolve(
      (entries, task) => task.split === 'test' || activeSlugs(entries).includes(`fix-${task.id}`)
    );
    const learner = fakeLearner(prompt =>
      promptTaskIds(prompt).map(id => proposalFor(id, 'proj-a'))
    );

    const result = await runLearn(dbs, {
      ...common(),
      solve: solve.fn,
      runAgent: learner.fn,
      textModel: fakeTextModel().fn,
    });

    const metrics = getRun(learning, result.runId)!.metrics as any;
    expect(metrics.train.before.byKindTier['locate:2']).toEqual({ passed: 0, total: 1 });
    expect(metrics.train.after.byKindTier['locate:2']).toEqual({ passed: 1, total: 1 });
    expect(metrics.test.byKindTier['when:3']).toEqual({ passed: 1, total: 1 });
    expect(result.before.byKindTier['locate:2']).toEqual({ passed: 0, total: 1 });
    expect(result.after.byKindTier['locate:2']).toEqual({ passed: 1, total: 1 });
    expect(result.test.byKindTier['when:3']).toEqual({ passed: 1, total: 1 });
  });

  it('stops at a call cap hit mid-round, keeps validated entries and still evaluates test', async () => {
    openFixture(['proj-a']);
    const target = addTask({ project: 'proj-a' });
    const other = addTask({ project: 'proj-a' });
    addTask({ project: 'proj-a', split: 'test', kind: 'when', tier: 3 });
    const byId = new Map([
      [target.id, 'proj-a'],
      [other.id, 'proj-a'],
    ]);

    const solve = fakeSolve(
      (entries, task) => task.split === 'test' || activeSlugs(entries).includes(`fix-${task.id}`)
    );
    // Two parent solves, two leaf solves, one learner turn, one validation.
    const learner = fakeLearner(prompt =>
      promptTaskIds(prompt)
        .filter(id => id === target.id)
        .map(id => proposalFor(id, byId.get(id)!))
    );

    const result = await runLearn(dbs, {
      ...common({ budget: new CallBudget(6) }),
      solve: solve.fn,
      runAgent: learner.fn,
      textModel: fakeTextModel().fn,
    });

    expect(result.status).toBe('stopped');
    expect(result.kept).toHaveLength(1);
    const kept = await store.getEntry(result.kept[0]);
    expect(kept?.status).toBe('active');
    const testAttempts = listAttempts(learning, { runId: result.runId }).filter(
      attempt => attempt.role === 'solve'
    );
    expect(testAttempts.length).toBeGreaterThan(0);
    expect(solve.calls.filter(call => call.split === 'test')).toHaveLength(1);
  });

  it('bounds the concurrency of child learners', async () => {
    const projects = ['proj-a', 'proj-b', 'proj-c', 'proj-d'];
    openFixture(projects);
    const tasks = projects.map(project => addTask({ project }));
    const byId = new Map(tasks.map(task => [task.id, task.project]));

    const solve = fakeSolve((entries, task) => activeSlugs(entries).includes(`fix-${task.id}`));
    const learner = fakeLearner(
      prompt => promptTaskIds(prompt).map(id => proposalFor(id, byId.get(id)!)),
      undefined,
      5
    );
    const text = fakeTextModel({
      split: () => projects.map((_, i) => `- wrong project: ${tasks[i].id}`).join('\n') + '\n',
    });

    const result = await runLearn(dbs, {
      ...common({ concurrency: 2 }),
      solve: solve.fn,
      runAgent: learner.fn,
      textModel: text.fn,
    });

    expect(childRuns(result.runId)).toHaveLength(4);
    expect(learner.stats.maxActive).toBeLessThanOrEqual(2);
    expect(learner.stats.maxActive).toBeGreaterThan(1);
  });

  it('writes attempts and no entries on a dry run', async () => {
    openFixture(['proj-a']);
    addTask({ project: 'proj-a' });
    addTask({ project: 'proj-a', split: 'test', kind: 'when', tier: 3 });

    const solve = fakeSolve(() => false);
    const learner = fakeLearner(() => [proposalFor(1, 'proj-a')]);

    const result = await runLearn(dbs, {
      ...common(),
      dryRun: true,
      solve: solve.fn,
      runAgent: learner.fn,
      textModel: fakeTextModel().fn,
    });

    expect(learner.calls).toHaveLength(0);
    expect(listAttempts(learning, { runId: result.runId }).length).toBeGreaterThan(0);
    expect(await store.listByStatus(['candidate', 'active', 'retired'])).toEqual([]);
    expect(result.kept).toEqual([]);
    expect(result.status).toBe('done');
  });
});
