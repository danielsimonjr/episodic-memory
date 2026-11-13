import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Database } from '../../src/sqlite.js';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  solveTask,
  solveMany,
  CallBudget,
  BudgetExhausted,
  type SolveDeps,
} from '../../src/learn/solver.js';
import { openKnowledgeStore, type KnowledgeStore } from '../../src/learn/knowledge-store.js';
import { insertKnowledgeEntry, activate, createSnapshot } from '../../src/learn/knowledge-db.js';
import { openLearningDb } from '../../src/learn/learning-store.js';
import { insertTask, listAttempts, createRun } from '../../src/learn/learning-db.js';
import type { LearningTask } from '../../src/learn/learning-db.js';
import type {
  AttemptOutcome,
  Cost,
  LearnDbs,
  NewKnowledgeEntry,
  TaskTruth,
  TraceStep,
} from '../../src/learn/types.js';
import { safeRmSync, suppressConsole } from '../test-utils.js';

suppressConsole();

const HEX = 'c'.repeat(32);
const ARCHIVE = '/archive/proj-a/s1.jsonl';

function truth(over: Partial<TaskTruth> = {}): TaskTruth {
  return {
    exchanges: [
      {
        id: HEX,
        path: ARCHIVE,
        lineStart: 3,
        lineEnd: 9,
        sessionId: 's1',
      },
    ],
    sessionDateRange: ['2026-03-04', '2026-03-04'],
    project: 'proj-a',
    assistantMessage: 'We settled on sqlite for the cache.',
    ...over,
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
    sources: [],
    status: 'candidate',
    runId: 'run-1',
    ...over,
  };
}

interface RunAgentCall {
  prompt: string;
  systemPrompt: string;
  allowPropose: boolean;
  model: string;
  server: unknown;
}

function fakeAgent(answer: string, over: Partial<{
  outcome: AttemptOutcome;
  trace: TraceStep[];
  cost: Cost;
  toolsSeen: string[];
}> = {}) {
  const calls: RunAgentCall[] = [];
  const fn = async (options: any) => {
    calls.push({
      prompt: options.prompt,
      systemPrompt: options.systemPrompt,
      allowPropose: options.allowPropose,
      model: options.model,
      server: options.server,
    });
    return {
      text: answer,
      trace: over.trace ?? [
        { tool: 'mcp__episodic-learn__search', args: { query: 'cache' }, resultAddress: null, resultChars: 42 },
      ],
      cost: over.cost ?? { turns: 3, inputTokens: 10, outputTokens: 5, usd: 0.01 },
      outcome: over.outcome ?? 'graded',
      toolsSeen: over.toolsSeen ?? [],
    };
  };
  return { fn, calls };
}

describe('solveTask', () => {
  let configDir: string;
  let learning: Database;
  let store: KnowledgeStore;
  let dbs: LearnDbs;
  let index: Database;
  let activeId: string;
  const pids = { added: [] as number[], removed: [] as number[], add(p: number) { this.added.push(p); }, remove(p: number) { this.removed.push(p); } };

  beforeEach(async () => {
    configDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'em-solver-')));
    process.env.EPISODIC_MEMORY_CONFIG_DIR = configDir;
    learning = openLearningDb({ path: path.join(configDir, 'learning.sqlite') });
    index = new Database(':memory:');
    store = openKnowledgeStore({ dbPath: path.join(configDir, 'knowledge.db') });

    const id = await insertKnowledgeEntry(store, nk());
    await activate(store, id, null, 'verified');
    activeId = id;

    dbs = { store, learning, index };
    createRun(learning, { phase: 'improve', seed: 7, budget: {} });
  });

  afterEach(() => {
    try {
      store.close();
    } finally {
      try {
        learning.close();
      } finally {
        index.close();
        delete process.env.EPISODIC_MEMORY_CONFIG_DIR;
        safeRmSync(configDir);
      }
    }
  });

  async function task(over: Partial<Omit<LearningTask, 'id'>> = {}): Promise<LearningTask> {
    const runId = 'run-test';
    const id = insertTask(learning, {
      runId,
      kind: 'locate',
      tier: 2,
      split: 'train',
      project: 'proj-a',
      prompt: 'Where was the cache decision made?',
      truth: truth(),
      status: 'ok',
      ...over,
    });
    return { id, runId, kind: 'locate', tier: 2, split: 'train', project: 'proj-a', prompt: 'Where was the cache decision made?', truth: truth(), status: 'ok', ...over } as LearningTask;
  }

  function deps(over: Partial<SolveDeps> = {}): SolveDeps {
    return {
      model: 'sonnet',
      pids,
      ...over,
    };
  }

  it('stores a graded attempt with a grade and a trace holding addresses and no result text', async () => {
    const t = await task();
    const snapshotId = await createSnapshot(learning, t.runId, [activeId]);
    const agent = fakeAgent(`path: ${ARCHIVE}\nlines: 4-8\nproject: proj-a`);

    const attempt = await solveTask(dbs, t, {
      snapshotId,
      runId: t.runId,
      role: 'solve',
      runAgent: agent.fn as any,
      ...deps(),
    });

    expect(attempt.outcome).toBe('graded');
    expect(attempt.passed).toBe(true);
    expect(attempt.score).toBe(1);
    expect(attempt.taskId).toBe(t.id);
    expect(attempt.snapshotId).toBe(snapshotId);
    expect(attempt.trace[0].tool).toBe('mcp__episodic-learn__search');
    expect(attempt.trace[0].resultAddress).toBeNull();
    expect(JSON.stringify(attempt.trace)).not.toContain('We settled on sqlite');

    const stored = listAttempts(learning, { runId: t.runId });
    expect(stored).toHaveLength(1);
    expect(stored[0].passed).toBe(true);
  });

  it('builds the server with the task source exchanges hidden', async () => {
    const t = await task();
    const snapshotId = await createSnapshot(learning, t.runId, [activeId]);
    const agent = fakeAgent(`path: ${ARCHIVE}\nlines: 4-8\nproject: proj-a`);

    await solveTask(dbs, t, {
      snapshotId,
      runId: t.runId,
      role: 'solve',
      runAgent: agent.fn as any,
      ...deps(),
    });

    const server = agent.calls[0].server as any;
    const instance = server.instance as unknown as {
      _registeredTools: Record<string, { handler: (a: any, e: any) => Promise<any> }>;
    };
    // The digest handler must refuse to expand the task's own source id.
    const result = await instance._registeredTools.digest.handler(
      { expand: HEX },
      {}
    );
    const text = result.content.map((p: any) => p.text).join('\n');
    expect(text).not.toContain(ARCHIVE);
  });

  it('runs without propose_entry', async () => {
    const t = await task();
    const snapshotId = await createSnapshot(learning, t.runId, [activeId]);
    const agent = fakeAgent(`path: ${ARCHIVE}\nlines: 4-8\nproject: proj-a`);
    await solveTask(dbs, t, {
      snapshotId,
      runId: t.runId,
      role: 'solve',
      runAgent: agent.fn as any,
      ...deps(),
    });
    expect(agent.calls[0].allowPropose).toBe(false);
    const server = agent.calls[0].server as any;
    expect(Object.keys(server.instance._registeredTools)).not.toContain('propose_entry');
  });

  it('puts the active instruction in the system prompt', async () => {
    const t = await task();
    const snapshotId = await createSnapshot(learning, t.runId, [activeId]);
    const agent = fakeAgent(`path: ${ARCHIVE}\nlines: 4-8\nproject: proj-a`);
    await solveTask(dbs, t, {
      snapshotId,
      runId: t.runId,
      role: 'solve',
      runAgent: agent.fn as any,
      ...deps(),
    });
    expect(agent.calls[0].systemPrompt).toContain('mode text for release notes');
    expect(agent.calls[0].prompt).toContain('Where was the cache decision made?');
  });

  it('grades a when task through the same path', async () => {    const t = await task({ kind: 'when', prompt: 'When was the cache decided?' });
    const snapshotId = await createSnapshot(learning, t.runId, [activeId]);
    const agent = fakeAgent('date: 2026-03-04\nproject: proj-a');
    const attempt = await solveTask(dbs, t, {
      snapshotId,
      runId: t.runId,
      role: 'solve',
      runAgent: agent.fn as any,
      ...deps(),
    });
    expect(attempt.passed).toBe(true);
  });

  it('grades a recall task through the injected judge', async () => {
    const t = await task({ kind: 'recall', prompt: 'Where, and what was decided?' });
    const snapshotId = await createSnapshot(learning, t.runId, [activeId]);
    const agent = fakeAgent(`path: ${ARCHIVE}\nlines: 4-8\nproject: proj-a\noutcome: We settled on sqlite.`);
    const attempt = await solveTask(dbs, t, {
      snapshotId,
      runId: t.runId,
      role: 'solve',
      runAgent: agent.fn as any,
      judge: async () => '<score>0.9</score>',
      ...deps(),
    });
    expect(attempt.passed).toBe(true);
  });

  for (const outcome of ['aborted', 'killed', 'error'] as AttemptOutcome[]) {
    it(`stores ${outcome} as a failed attempt with that outcome`, async () => {
      const t = await task();
      const snapshotId = await createSnapshot(learning, t.runId, [activeId]);
      const agent = fakeAgent('Agent run failed: something broke', { outcome });

      const attempt = await solveTask(dbs, t, {
        snapshotId,
        runId: t.runId,
        role: 'solve',
        runAgent: agent.fn as any,
        ...deps(),
      });

      expect(attempt.outcome).toBe(outcome);
      expect(attempt.passed).toBe(false);
      expect(attempt.score).toBe(0);
      expect(attempt.answer).toContain('something broke');
    });
  }

  it('still stores an attempt when the agent throws', async () => {
    const t = await task();
    const snapshotId = await createSnapshot(learning, t.runId, [activeId]);
    const attempt = await solveTask(dbs, t, {
      snapshotId,
      runId: t.runId,
      role: 'solve',
      runAgent: (async () => {
        throw new Error('spawn failed');
      }) as any,
      ...deps(),
    });
    expect(attempt.outcome).toBe('error');
    expect(attempt.answer).toContain('spawn failed');
  });

  it('registers and releases the subprocess pids it saw', async () => {
    const t = await task();
    const snapshotId = await createSnapshot(learning, t.runId, [activeId]);
    let registry: any;
    const agent = fakeAgent(`path: ${ARCHIVE}\nlines: 4-8\nproject: proj-a`);
    await solveTask(dbs, t, {
      snapshotId,
      runId: t.runId,
      role: 'solve',
      runAgent: (async (options: any) => {
        registry = options.pids;
        return agent.fn(options);
      }) as any,
      ...deps(),
    });
    expect(registry).toBe(pids);
  });
});

describe('CallBudget', () => {
  it('counts up to its cap and then throws BudgetExhausted', () => {
    const budget = new CallBudget(2);
    budget.spend();
    budget.spend();
    expect(() => budget.spend()).toThrow(BudgetExhausted);
  });

  it('starts with nothing spent', () => {
    const budget = new CallBudget(5);
    expect(budget.used).toBe(0);
    expect(budget.remaining()).toBe(5);
  });
});

describe('solveMany', () => {
  let configDir: string;
  let learning: Database;
  let store: KnowledgeStore;
  let dbs: LearnDbs;
  let index: Database;

  beforeEach(() => {
    configDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'em-solve-many-')));
    process.env.EPISODIC_MEMORY_CONFIG_DIR = configDir;
    learning = openLearningDb({ path: path.join(configDir, 'learning.sqlite') });
    index = new Database(':memory:');
    store = openKnowledgeStore({ dbPath: path.join(configDir, 'knowledge.db') });
    dbs = { store, learning, index };
    createRun(learning, { phase: 'improve', seed: 7, budget: {} });
  });

  afterEach(() => {
    try {
      store.close();
    } finally {
      try {
        learning.close();
      } finally {
        index.close();
        delete process.env.EPISODIC_MEMORY_CONFIG_DIR;
        safeRmSync(configDir);
      }
    }
  });

  function tasks(count: number): LearningTask[] {
    const out: LearningTask[] = [];
    for (let i = 0; i < count; i++) {
      const id = insertTask(learning, {
        runId: 'run-many',
        kind: 'locate',
        tier: 2,
        split: 'train',
        project: 'proj-a',
        prompt: `Question ${i}?`,
        truth: truth(),
        status: 'ok',
      });
      out.push({
        id,
        runId: 'run-many',
        kind: 'locate',
        tier: 2,
        split: 'train',
        project: 'proj-a',
        prompt: `Question ${i}?`,
        truth: truth(),
        status: 'ok',
      });
    }
    return out;
  }

  it('stops at the call cap with BudgetExhausted and keeps what it solved', async () => {
    const snapshotId = await createSnapshot(learning, 'run-many', []);
    const agent = fakeAgent(`path: ${ARCHIVE}\nlines: 4-8\nproject: proj-a`);
    const budget = new CallBudget(2);

    await expect(
      solveMany(dbs, tasks(4), {
        snapshotId,
        runId: 'run-many',
        role: 'solve',
        runAgent: agent.fn as any,
        model: 'sonnet',
        pids,
        budget,
      })
    ).rejects.toThrow(BudgetExhausted);

    expect(budget.used).toBe(2);
    expect(listAttempts(learning, { runId: 'run-many' }).length).toBeLessThanOrEqual(2);
  });

  const pids = { add() {}, remove() {} };

  it('runs every task when the budget allows it', async () => {
    const snapshotId = await createSnapshot(learning, 'run-many', []);
    const agent = fakeAgent(`path: ${ARCHIVE}\nlines: 4-8\nproject: proj-a`);
    const budget = new CallBudget(10);

    const attempts = await solveMany(dbs, tasks(3), {
      snapshotId,
      runId: 'run-many',
      role: 'solve',
      runAgent: agent.fn as any,
      model: 'sonnet',
      pids,
      budget,
    });

    expect(attempts).toHaveLength(3);
    expect(budget.used).toBe(3);
    expect(agent.calls).toHaveLength(3);
  });

  it('never exceeds the global semaphore limit', async () => {
    process.env.EPISODIC_MEMORY_LEARN_CONCURRENCY = '2';
    try {
      const snapshotId = await createSnapshot(learning, 'run-many', []);
      let running = 0;
      let peak = 0;
      const agent = {
        async runAgent(options: any) {
          running += 1;
          peak = Math.max(peak, running);
          await new Promise(resolve => setTimeout(resolve, 15));
          running -= 1;
          return {
            text: `path: ${ARCHIVE}\nlines: 4-8\nproject: proj-a`,
            trace: [],
            cost: { turns: 1, inputTokens: 0, outputTokens: 0, usd: null },
            outcome: 'graded' as AttemptOutcome,
            toolsSeen: [],
          };
        },
      };

      await solveMany(dbs, tasks(5), {
        snapshotId,
        runId: 'run-many',
        role: 'solve',
        runAgent: agent.runAgent as any,
        model: 'sonnet',
        pids,
        budget: new CallBudget(10),
      });

      expect(peak).toBe(2);
    } finally {
      delete process.env.EPISODIC_MEMORY_LEARN_CONCURRENCY;
    }
  });
});
