import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
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
  insertTask,
  type LearningTask,
} from '../../src/learn/learning-db.js';
import { activate, insertKnowledgeEntry } from '../../src/learn/knowledge-db.js';
import type { LearnDbs, ProposedEntry, TaskTruth } from '../../src/learn/types.js';
import { safeRmSync, suppressConsole } from '../test-utils.js';

suppressConsole();

const WORDS = 'release build native module sentinel';

function hexId(label: string): string {
  return createHash('sha256').update(label).digest('hex').slice(0, 32);
}

function indexFixture(projects: string[]): Database.Database {
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
let learning: Database.Database;
let index: Database.Database;
let store: KnowledgeStore;
let dbs: LearnDbs;
let counter = 0;
const savedConfig = process.env.EPISODIC_MEMORY_CONFIG_DIR;
const savedApprove = process.env.EPISODIC_MEMORY_LEARN_APPROVE;

beforeEach(() => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'em-relay9-')));
  process.env.EPISODIC_MEMORY_CONFIG_DIR = dir;
  process.env.EPISODIC_MEMORY_LEARN_APPROVE = 'none';
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

function fakeSolve(
  pass: (entries: Array<{ name: string; body: string; slug: string }>, task: LearningTask) => boolean
) {
  const fn = async (solverDbs: LearnDbs, task: LearningTask, options: any): Promise<any> => {
    options.budget?.spend();
    const names = (await import('../../src/learn/knowledge-db.js')).getSnapshot(
      solverDbs.learning,
      options.snapshotId
    );
    const entries: Array<{ name: string; body: string; slug: string }> = [];
    for (const name of names) {
      const entry = await solverDbs.store.getEntry(name);
      if (entry) entries.push({ name, body: entry.body, slug: entry.slug });
    }
    const passed = pass(entries, task);
    const attempt = {
      taskId: task.id,
      runId: options.runId,
      snapshotId: options.snapshotId,
      role: options.role as any,
      passed,
      score: passed ? 1 : 0,
      answer: passed ? `path: /archive/${task.project}/s-0.jsonl\nlines: 1-9` : 'not found',
      trace: [],
      cost: { turns: 3, inputTokens: 8, outputTokens: 4, usd: 0.01 },
      outcome: 'graded' as const,
    };
    const id = (await import('../../src/learn/learning-db.js')).insertAttempt(
      solverDbs.learning,
      attempt
    );
    return { ...attempt, id, createdAt: new Date().toISOString() };
  };
  return fn as any;
}

function promptTaskIds(prompt: string): number[] {
  return [...prompt.matchAll(/^- task (\d+) \(/gm)].map(match => Number(match[1]));
}

function fakeLearner(propose: (prompt: string) => ProposedEntry[]) {
  const fn = async (options: any) => {
    const instance = (options.server as any).instance as {
      _registeredTools: Record<string, { handler: (a: any, e: any) => Promise<any> }>;
    };
    const handler = instance._registeredTools.propose_entry?.handler;
    if (handler) {
      for (const proposal of propose(options.prompt)) await handler({ ...proposal }, {});
    }
    return {
      text: 'diagnosed',
      trace: [],
      cost: { turns: 5, inputTokens: 10, outputTokens: 5, usd: 0.01 },
      outcome: 'graded' as const,
      toolsSeen: [],
    };
  };
  return fn as any;
}

function marksIn(prompt: string): string[] {
  return [...new Set([...prompt.matchAll(/#[0-9a-f]{32}/g)].map(match => match[0]))];
}

function fakeTextModel(handlers: {
  split?: (prompt: string) => string;
  merge?: (prompt: string) => string;
  reflect?: (prompt: string) => string;
}) {
  const fn = async (prompt: string): Promise<string> => {
    if (prompt.includes('Partition these failed')) {
      return handlers.split ? handlers.split(prompt) : '';
    }
    if (prompt.includes('Merge these versions')) {
      return handlers.merge
        ? handlers.merge(prompt)
        : `project proj-a: ${WORDS} merged [${marksIn(prompt).join(', ')}]\n`;
    }
    if (prompt.includes('Write one reflection')) {
      return handlers.reflect
        ? handlers.reflect(prompt)
        : `release build native module findings landed [${marksIn(prompt)[0] ?? `#${'0'.repeat(32)}`}]\n`;
    }
    return '';
  };
  return fn;
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
    concurrency: 1,
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

describe('relay task 9 findings', () => {
  // Finding 1: a call cap hit during the merge-check leaves the merged entry
  // active with no validation record at all (§7 rule 5: validate or drop).
  it('does not activate a merged entry whose merge-check never ran (budget died first)', async () => {
    openFixture(['proj-a']);
    const first = addTask({ project: 'proj-a' });
    const second = addTask({ project: 'proj-a' });
    const sourceOf = new Map([
      [first.id, hexId('proj-a-0')],
      [second.id, hexId('proj-a-1')],
    ]);

    const solve = fakeSolve((entries, task) =>
      entries.some(entry => entry.body.includes(sourceOf.get(task.id)!))
    );
    const learner = fakeLearner(prompt =>
      promptTaskIds(prompt).map(id =>
        proposalFor(id, 'proj-a', {
          kind: 'skill',
          slug: 'release-map',
          title: 'Release map',
          body: `project proj-a: ${WORDS} work [#${sourceOf.get(id)}]`,
        })
      )
    );
    const text = fakeTextModel({
      split: () => `- wrong project: ${first.id}\n- paraphrase not matched: ${second.id}\n`,
    });

    // Baseline: 2 solves. Each child: 1 solve + 1 learner turn + 1 validation
    // solve = 3. Total 8 before the merge-check; the cap lands exactly there.
    const result = await runLearn(dbs, {
      ...common({ leafMax: 1, budget: new CallBudget(8) }),
      solve,
      runAgent: learner,
      textModel: text,
    });

    expect(childRuns(result.runId)).toHaveLength(2);
    expect(result.merges).toHaveLength(1);
    const merged = await store.getEntry(result.merges[0].merged);
    expect(merged).not.toBeNull();
    // The merge-check never ran, so the merged version must not be live.
    expect(merged?.status).not.toBe('active');
  });

  // Finding 2: a conflict between a merged instruction and an instruction that
  // was already active before the run is neither resolved nor named —
  // resolveConflicts only considers the entries this round's children kept.
  it('names the conflict between a merged instruction and a pre-existing active instruction', async () => {
    openFixture(['proj-a']);
    const first = addTask({ project: 'proj-a' });
    const second = addTask({ project: 'proj-a' });

    const legacyName = await insertKnowledgeEntry(store, {
      kind: 'instruction',
      project: 'proj-a',
      slug: 'legacy-rule',
      title: 'Legacy rule',
      description: `Use when asked about the ${WORDS}`,
      body: `project proj-a: ${WORDS} checked first [#${hexId('proj-a-5')}]`,
      scope: 'proj-a',
      confidence: 'medium',
      trust: 'verified',
      sources: [],
      status: 'candidate',
      runId: 'seed',
    });
    await activate(store, legacyName, null, 'verified');

    const sourceOf = new Map([
      [first.id, hexId('proj-a-0')],
      [second.id, hexId('proj-a-1')],
    ]);
    const solve = fakeSolve((entries, task) =>
      entries.some(entry => entry.body.includes(sourceOf.get(task.id)!))
    );
    const learner = fakeLearner(prompt =>
      promptTaskIds(prompt).map(id =>
        proposalFor(id, 'proj-a', {
          kind: 'instruction',
          slug: 'round-map',
          title: 'Round map',
          body: `project proj-a: ${WORDS} merged [#${sourceOf.get(id)}]`,
        })
      )
    );
    const text = fakeTextModel({
      split: () => `- wrong project: ${first.id}\n- paraphrase not matched: ${second.id}\n`,
    });

    const result = await runLearn(dbs, {
      ...common({ leafMax: 1 }),
      solve,
      runAgent: learner,
      textModel: text,
    });

    expect(result.merges).toHaveLength(1);
    const run = getRun(learning, result.runId)!;
    const namedLegacy = run.rejections.some(rejection => /legacy-rule/.test(rejection.reason));
    expect(namedLegacy).toBe(true);
  });

  it('learns a single project that fits leafMax inside the parent run', async () => {
    openFixture(['proj-a']);
    addTask({ project: 'proj-a' });
    addTask({ project: 'proj-a' });
    const solve = fakeSolve(() => false);
    const learner = fakeLearner(() => []);
    const result = await runLearn(dbs, {
      ...common({ leafMax: 12 }),
      solve,
      runAgent: learner,
      textModel: fakeTextModel(),
    });
    expect(result.children).toEqual([]);
    expect(childRuns(result.runId)).toHaveLength(0);
  });
});
