import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  runBootstrap,
  eligibleProjects,
  bootstrapGain,
  BOOTSTRAP_INSTRUCTION_SLUG,
  BOOTSTRAP_REFLECTION_SLUG,
} from '../../src/learn/bootstrap.js';
import { CallBudget } from '../../src/learn/solver.js';
import { openKnowledgeStore, type KnowledgeStore } from '../../src/learn/knowledge-store.js';
import { openLearningDb } from '../../src/learn/learning-store.js';
import { insertTask, getRun, insertAttempt, createRun } from '../../src/learn/learning-db.js';
import { buildLearnToolServer } from '../../src/learn/sdk-tools.js';
import type { LearnDbs, ProposedEntry, TaskTruth } from '../../src/learn/types.js';
import { safeRmSync, suppressConsole } from '../test-utils.js';

suppressConsole();

const HEX_A = 'a'.repeat(32);
const HEX_B = 'b'.repeat(32);
const SECRET = 'ghp_' + 'Z'.repeat(36);

const GROUNDED_WORDS = 'release build native module sentinel';

/** A 32-hex exchange id, the only shape the citation gate accepts. */
function hexId(label: string): string {
  return createHash('sha256').update(label).digest('hex').slice(0, 32);
}

function indexFixture(projects: string[] = ['proj-a'], perProject = 30): Database.Database {
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
  const stmt = db.prepare(
    `INSERT INTO exchanges
       (id, project, timestamp, user_message, assistant_message, archive_path,
        line_start, line_end, is_sidechain, harness, session_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 'claude', ?)`
  );
  for (const project of projects) {
    for (let i = 0; i < perProject; i += 1) {
      stmt.run(
        hexId(`${project}-${i}`),
        project,
        `2026-03-${String(1 + (i % 20)).padStart(2, '0')}T10:00:00.000Z`,
        `How does the ${GROUNDED_WORDS} work in step ${i}? `.repeat(3),
        `The ${GROUNDED_WORDS} is verified before the wrapper declares it healthy, step ${i}. `.repeat(3),
        `/archive/${project}/s-${i}.jsonl`,
        1 + i * 10,
        9 + i * 10,
        `session-${i}`
      );
    }
  }
  return db;
}

/** The hex id of the first indexed exchange of a project. */
function exchangeId(project = 'proj-a', i = 0): string {
  return hexId(`${project}-${i}`);
}

function proposal(over: Partial<ProposedEntry> = {}): ProposedEntry {
  return {
    kind: 'skill',
    project: 'proj-a',
    slug: 'navigation',
    title: 'Project map',
    description: 'Use to find where work lives in this archive',
    body: `project proj-a: ${GROUNDED_WORDS} work [#${exchangeId()}]`,
    scope: 'proj-a',
    confidence: 'medium',
    ...over,
  };
}

interface AgentCall {
  prompt: string;
  systemPrompt: string;
  allowPropose: boolean;
  model: string;
}

/** Run one proposal through the server's own `propose_entry` handler. */
async function deliverProposals(server: unknown, proposals: ProposedEntry[]): Promise<void> {
  const instance = (server as any).instance as {
    _registeredTools: Record<string, { handler: (a: any, e: any) => Promise<any> }>;
  };
  const handler = instance._registeredTools.propose_entry?.handler;
  if (!handler) return;
  for (const p of proposals) {
    await handler({ ...p }, {});
  }
}

function bootstrapAgent(byProject: Record<string, ProposedEntry[]>) {
  const calls: AgentCall[] = [];
  let running = 0;
  let peak = 0;
  const fn = async (options: any) => {
    calls.push({
      prompt: options.prompt,
      systemPrompt: options.systemPrompt,
      allowPropose: options.allowPropose,
      model: options.model,
    });
    // Only bootstrapper bodies are counted: the measurement solves are a later
    // stage and are not what "one bootstrapper per project, bounded" means.
    const counts = options.allowPropose;
    if (counts) {
      running += 1;
      peak = Math.max(peak, running);
    }
    try {
      await new Promise(resolve => setTimeout(resolve, 5));
      const project = /^project: (.+)$/m.exec(options.prompt)?.[1]?.trim() ?? '';
      await deliverProposals(options.server, byProject[project] ?? []);
    } finally {
      if (counts) running -= 1;
    }
    return {
      text: 'mapped',
      trace: [],
      cost: { turns: 4, inputTokens: 10, outputTokens: 5, usd: 0.01 },
      outcome: 'graded' as const,
      toolsSeen: [],
    };
  };
  return { fn, calls, peak: () => peak };
}

/** A solving agent: answers `answers[prompt]`, with a turn count from `turns`. */
function solvingAgent(
  answers: Record<string, string>,
  turns: (systemPrompt: string) => number,
  cost: (systemPrompt: string) => number = () => 0.01
) {
  const calls: AgentCall[] = [];
  const fn = async (options: any) => {
    calls.push({
      prompt: options.prompt,
      systemPrompt: options.systemPrompt,
      allowPropose: options.allowPropose,
      model: options.model,
    });
    return {
      text: answers[options.prompt] ?? 'not found',
      trace: [],
      cost: {
        turns: turns(options.systemPrompt),
        inputTokens: 10,
        outputTokens: 5,
        usd: cost(options.systemPrompt),
      },
      outcome: 'graded' as const,
      toolsSeen: [],
    };
  };
  return { fn, calls };
}

/**
 * A text model for task generation, the merge call and the reflection call.
 *
 * The fake copies the marks the prompt offers, as a real model does.
 * The reason: the prompts list `[#id]` and `[@n]` marks for exactly that purpose.
 */
function fakeTextModel() {
  const prompts: string[] = [];
  const fn = async (prompt: string): Promise<string> => {
    prompts.push(prompt);
    if (prompt.startsWith('You write retrieval practice questions')) {
      const lines = (tag: string) => [
        `<${tag}>`,
        `locate: Where was the ${GROUNDED_WORDS} discussed?`,
        `recall: Where was the ${GROUNDED_WORDS} discussed, and what was decided?`,
        `when: When did the ${GROUNDED_WORDS} work happen?`,
        `multi: What changed for the ${GROUNDED_WORDS}, and why did the build fail?`,
        `</${tag}>`,
      ];
      return [...lines('tier1'), ...lines('tier2'), ...lines('tier3')].join('\n');
    }
    if (prompt.startsWith('You are consolidating bootstrap findings')) {
      const hex = /\[#([0-9a-f]{32})\]/.exec(prompt)?.[1] ?? exchangeId();
      return `project proj-a: ${GROUNDED_WORDS} work [#${hex}]`;
    }
    if (prompt.startsWith('Write one reflection')) {
      const hex = /\[#([0-9a-f]{32})\]/.exec(prompt)?.[1] ?? exchangeId();
      const attempt = /\[@(\d+)\]/.exec(prompt)?.[1];
      const marks = attempt ? `[#${hex},@${attempt}]` : `[#${hex}]`;
      return `The ${GROUNDED_WORDS} map held up on the signal tasks ${marks}`;
    }
    return '';
  };
  return { fn, prompts };
}

let dir: string;
let learning: Database.Database;
let index: Database.Database;
let store: KnowledgeStore;
let dbs: LearnDbs;
const savedConfig = process.env.EPISODIC_MEMORY_CONFIG_DIR;
const savedFlag = process.env.EPISODIC_MEMORY_LEARN;
const savedApprove = process.env.EPISODIC_MEMORY_LEARN_APPROVE;

beforeEach(() => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'em-bootstrap-')));
  process.env.EPISODIC_MEMORY_CONFIG_DIR = dir;
  process.env.EPISODIC_MEMORY_LEARN = '1';
  learning = openLearningDb({ path: path.join(dir, 'learned', 'learning.sqlite') });
  store = openKnowledgeStore({ dbPath: path.join(dir, 'learned', 'knowledge.db') });
  index = indexFixture();
  dbs = { store, learning, index };
});

afterEach(() => {
  try {
    store.close();
  } finally {
    try {
      learning.close();
    } finally {
      index.close();
      if (savedConfig === undefined) delete process.env.EPISODIC_MEMORY_CONFIG_DIR;
      else process.env.EPISODIC_MEMORY_CONFIG_DIR = savedConfig;
      if (savedFlag === undefined) delete process.env.EPISODIC_MEMORY_LEARN;
      else process.env.EPISODIC_MEMORY_LEARN = savedFlag;
      if (savedApprove === undefined) delete process.env.EPISODIC_MEMORY_LEARN_APPROVE;
      else process.env.EPISODIC_MEMORY_LEARN_APPROVE = savedApprove;
      safeRmSync(dir);
    }
  }
});

function truth(project = 'proj-a'): TaskTruth {
  return {
    exchanges: [
      {
        id: exchangeId(project),
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

/** Insert two signal train tasks and return their prompts. */
function seedSignalTasks(learningDb: Database.Database = learning): string[] {
  const runId = createRun(learningDb, { phase: 'improve', seed: 1, budget: {} });
  const prompts = ['Where was the release build discussed?', 'When did the native module work happen?'];
  for (const [i, prompt] of prompts.entries()) {
    insertTask(learningDb, {
      runId,
      kind: i === 0 ? 'locate' : 'when',
      tier: 2,
      split: 'train',
      project: 'proj-a',
      prompt,
      truth: truth(),
      status: 'ok',
    });
  }
  return prompts;
}

function answersFor(prompts: string[]): Record<string, string> {
  return {
    [prompts[0]]: 'path: /archive/proj-a/s-0.jsonl\nlines: 1-9\nproject: proj-a',
    [prompts[1]]: 'date: 2026-03-01\nproject: proj-a',
  };
}

describe('eligibleProjects', () => {
  it('keeps projects at the floor and drops the rest, in a stable order', () => {
    const db = new Database(':memory:');
    db.exec(`
      CREATE TABLE exchanges (
        id TEXT, project TEXT, timestamp TEXT, user_message TEXT, assistant_message TEXT,
        archive_path TEXT, line_start INTEGER, line_end INTEGER, is_sidechain INTEGER, session_id TEXT
      )
    `);
    const insert = db.prepare(
      'INSERT INTO exchanges VALUES (?, ?, ?, ?, ?, ?, 1, 9, ?, ?)'
    );
    for (let i = 0; i < 25; i += 1) insert.run(`a-${i}`, 'proj-a', '2026-01-01T00:00:00Z', 'u', 'a', '/a.jsonl', 0, `s${i}`);
    for (let i = 0; i < 5; i += 1) insert.run(`b-${i}`, 'proj-b', '2026-01-01T00:00:00Z', 'u', 'a', '/b.jsonl', 0, `s${i}`);
    // A sidechain-heavy project counts only its real rows.
    for (let i = 0; i < 30; i += 1) insert.run(`c-${i}`, 'proj-c', '2026-01-01T00:00:00Z', 'u', 'a', '/c.jsonl', 1, `s${i}`);

    const projects = eligibleProjects(db, 20);
    db.close();
    expect(projects.map(p => p.project)).toEqual(['proj-a']);
    expect(projects[0].exchanges).toBe(25);
    expect(projects[0].sessions).toBe(25);
  });
});

describe('bootstrapGain', () => {
  const rate = (passed: number, total: number, meanTurns: number, usd: number) => ({
    passed,
    total,
    meanTurns,
    usd,
    byKindTier: {},
  });

  it('keeps an equal pass rate with a 10 percent turn saving', () => {
    const verdict = bootstrapGain(rate(2, 4, 10, 0.4), rate(2, 4, 9, 0.4), 10);
    expect(verdict.keep).toBe(true);
  });

  it('drops an equal pass rate with no saving', () => {
    expect(bootstrapGain(rate(2, 4, 10, 0.4), rate(2, 4, 10, 0.4), 10).keep).toBe(false);
  });

  it('drops a candidate that lowers the pass rate even when it saves turns', () => {
    expect(bootstrapGain(rate(4, 4, 10, 0.4), rate(3, 4, 1, 0.01), 10).keep).toBe(false);
  });

  it('keeps a USD saving when the turn count does not move', () => {
    expect(bootstrapGain(rate(2, 4, 10, 0.4), rate(2, 4, 10, 0.3), 10).keep).toBe(true);
  });

  it('refuses an unmeasured candidate', () => {
    expect(bootstrapGain(rate(0, 0, 0, 0), rate(0, 0, 0, 0), 10).keep).toBe(false);
  });
});

describe('runBootstrap', () => {
  it('starts one bootstrapper per eligible project, in parallel under the bound', async () => {
    index.close();
    index = indexFixture(['proj-a', 'proj-b']);
    dbs = { store, learning, index };
    seedSignalTasks();
    const agent = bootstrapAgent({
      'proj-a': [proposal({ slug: 'navigation' })],
      'proj-b': [proposal({ project: 'proj-b', slug: 'navigation', body: `project proj-b: ${GROUNDED_WORDS} work [#${exchangeId('proj-b')}]` })],
    });
    const text = fakeTextModel();

    const result = await runBootstrap(dbs, {
      runAgent: agent.fn as any,
      model: 'test-model',
      concurrency: 2,
      budget: new CallBudget(50),
      textModel: text.fn,
    });

    const bootstrapCalls = agent.calls.filter(call => call.allowPropose);
    expect(bootstrapCalls).toHaveLength(2);
    expect(agent.peak()).toBe(2);
    expect(result.projects).toBe(2);
    // Two signal tasks, measured twice (empty snapshot, then candidates).
    expect(runCalls(agent)).toBe(4);
    // Both projects were briefed with their own key.
    expect(bootstrapCalls.map(call => /^project: (.+)$/m.exec(call.prompt)?.[1].trim()).sort()).toEqual([
      'proj-a',
      'proj-b',
    ]);
  });

  it('bounds the bootstrapper concurrency', async () => {
    index.close();
    index = indexFixture(['proj-a', 'proj-b', 'proj-c']);
    dbs = { store, learning, index };
    seedSignalTasks();
    const agent = bootstrapAgent({});
    const text = fakeTextModel();

    await runBootstrap(dbs, {
      runAgent: agent.fn as any,
      model: 'test-model',
      concurrency: 1,
      budget: new CallBudget(50),
      textModel: text.fn,
    });

    expect(agent.peak()).toBe(1);
  });

  it('rejects a proposal that fails the gate, with the reason on the run', async () => {
    seedSignalTasks();
    const agent = bootstrapAgent({
      'proj-a': [
        proposal({ slug: 'Bad Slug' }), // invalid slug
        proposal({ slug: 'uncited', body: 'free prose with no marks at all' }), // no cited line
        proposal({ slug: 'injected', body: `${GROUNDED_WORDS} see https://evil.example/x [#${exchangeId()}]` }), // url
      ],
    });
    const text = fakeTextModel();

    const result = await runBootstrap(dbs, {
      runAgent: agent.fn as any,
      model: 'test-model',
      budget: new CallBudget(50),
      textModel: text.fn,
    });

    expect(result.proposed).toBe(0);
    const reasons = result.rejected.map(entry => entry.reason);
    expect(reasons).toContain('invalid-slug');
    expect(reasons).toContain('no-cited-lines');
    expect(reasons).toContain('url');

    const run = getRun(learning, result.runId)!;
    expect(run.rejections.map(r => r.slug)).toEqual(
      expect.arrayContaining(['Bad Slug', 'uncited', 'injected'])
    );
    expect(run.rejections.every(r => r.reason.length > 0)).toBe(true);
  });

  it('records a duplicate proposal as rejected, not stored twice', async () => {
    seedSignalTasks();
    const same = proposal({ slug: 'navigation' });
    const agent = bootstrapAgent({ 'proj-a': [same, { ...same }] });
    const text = fakeTextModel();

    const result = await runBootstrap(dbs, {
      runAgent: agent.fn as any,
      model: 'test-model',
      budget: new CallBudget(50),
      textModel: text.fn,
    });

    expect(result.rejected.map(entry => entry.reason)).toContain('duplicate');
  });

  it('stores navigation and exploration-notes as candidates with their cited sources', async () => {
    seedSignalTasks();
    const agent = bootstrapAgent({
      'proj-a': [
        proposal({ slug: 'navigation' }),
        proposal({
          slug: 'exploration-notes',
          title: 'Exploration notes',
          description: 'Use when deciding which tool answers a question in this archive',
          body: `mode text for ${GROUNDED_WORDS} questions [#${exchangeId()}]`,
        }),
      ],
    });
    const text = fakeTextModel();

    const result = await runBootstrap(dbs, {
      runAgent: agent.fn as any,
      model: 'test-model',
      budget: new CallBudget(50),
      textModel: text.fn,
    });

    const candidates = await store.listByStatus(['candidate'], ['skill']);
    const slugs = candidates.map(entry => entry.slug).sort();
    expect(slugs).toEqual(['exploration-notes', 'navigation']);
    for (const entry of candidates) {
      expect(entry.status).toBe('candidate');
      // The citation mark survives storage; that is the entry's proof of source.
      expect(entry.body).toContain(`[#${exchangeId()}]`);
    }
    expect(result.proposed).toBeGreaterThanOrEqual(2);

    // The citation is a real `cites` relation to an exchange reference row,
    // which is what `learn report` and the export check later.
    const ro = new Database(path.join(dir, 'learned', 'knowledge.db'), { readonly: true });
    try {
      const ref = ro
        .prepare('SELECT entityType FROM entities WHERE name = ?')
        .get(`exchange:${exchangeId()}`) as { entityType: string } | undefined;
      expect(ref?.entityType).toBe('exchange-ref');
      const relations = ro
        .prepare('SELECT fromEntity, relationType FROM relations WHERE toEntity = ?')
        .all(`exchange:${exchangeId()}`) as Array<{ fromEntity: string; relationType: string }>;
      expect(relations.length).toBeGreaterThan(0);
      expect(relations.every(rel => rel.relationType === 'cites')).toBe(true);
      expect(relations.some(rel => rel.fromEntity.includes(':navigation:v'))).toBe(true);
    } finally {
      ro.close();
    }
  });

  it('mirrors the two bootstrap skills into the project context, for learner prompts only', async () => {
    seedSignalTasks();
    const agent = bootstrapAgent({
      'proj-a': [proposal({ slug: 'navigation' }), proposal({ slug: 'exploration-notes' })],
    });
    const text = fakeTextModel();

    await runBootstrap(dbs, {
      runAgent: agent.fn as any,
      model: 'test-model',
      budget: new CallBudget(50),
      textModel: text.fn,
    });

    const context = await store.forContext('proj-a');
    // Both skills' cited lines are mirrored, marks intact, for learner prompts.
    expect(context).toContain('Facts:');
    expect(context).toContain('Conventions:');
    expect(context).toContain(`[#${exchangeId()}]`);
  });

  it('merges the candidates into one global instruction candidate', async () => {
    seedSignalTasks();
    const agent = bootstrapAgent({
      'proj-a': [proposal({ slug: 'navigation' })],
    });
    const text = fakeTextModel();

    const result = await runBootstrap(dbs, {
      runAgent: agent.fn as any,
      model: 'test-model',
      budget: new CallBudget(50),
      textModel: text.fn,
    });

    const instructions = await store.listByStatus(['candidate'], ['instruction']);
    expect(instructions).toHaveLength(1);
    expect(instructions[0].project).toBe('*');
    expect(instructions[0].slug).toBe(BOOTSTRAP_INSTRUCTION_SLUG);
    expect(instructions[0].body).toMatch(/^project proj-a: /);
    // Each line is also a heuristic, which a later `reinforce` acts on.
    expect(instructions[0].heuristicIds.length).toBeGreaterThan(0);
    expect(result.pending).toContain(instructions[0].id);
  });

  it('keeps a candidate whose measured pass rate falls', async () => {
    const prompts = seedSignalTasks();
    const agent = bootstrapAgent({ 'proj-a': [proposal({ slug: 'navigation' })] });
    const text = fakeTextModel();
    // Empty snapshot: both pass. With the candidates loaded: one fails.
    const solver = solvingAgent(answersFor(prompts), systemPrompt =>
      systemPrompt.includes('navigation') ? 5 : 10
    );
    const agentWithSolve = async (options: any) => {
      if (options.allowPropose) {
        const mapped = await agent.fn(options);
        return mapped;
      }
      if (options.systemPrompt.includes('navigation')) {
        return {
          ...(await solver.fn(options)),
          text: 'not found',
          outcome: 'graded' as const,
        };
      }
      return solver.fn(options);
    };

    await runBootstrap(dbs, {
      runAgent: agentWithSolve as any,
      model: 'test-model',
      budget: new CallBudget(50),
      textModel: text.fn,
    });

    const skills = await store.listByStatus(['candidate'], ['skill']);
    expect(skills.map(entry => entry.slug)).toContain('navigation');
    const navigations = (await store.listByStatus(['candidate', 'active'], ['skill'])).filter(
      entry => entry.slug === 'navigation'
    );
    expect(navigations.every(entry => entry.status === 'candidate')).toBe(true);
  });

  it('keeps a candidate with an equal pass rate and no saving', async () => {
    const prompts = seedSignalTasks();
    const agent = bootstrapAgent({ 'proj-a': [proposal({ slug: 'navigation' })] });
    const text = fakeTextModel();
    const solver = solvingAgent(answersFor(prompts), () => 10);

    const result = await runBootstrap(dbs, {
      runAgent: (async (options: any) =>
        options.allowPropose ? agent.fn(options) : solver.fn(options)) as any,
      model: 'test-model',
      budget: new CallBudget(50),
      textModel: text.fn,
    });

    expect(result.activated).toEqual([]);
    const skills = await store.listByStatus(['candidate'], ['skill']);
    expect(skills.map(entry => entry.slug)).toContain('navigation');
    expect(result.pending.length).toBeGreaterThan(0);
  });

  it('activates a skill with an equal pass rate and a 10 percent turn saving', async () => {
    const prompts = seedSignalTasks();
    const agent = bootstrapAgent({ 'proj-a': [proposal({ slug: 'navigation' })] });
    const text = fakeTextModel();
    const solver = solvingAgent(answersFor(prompts), systemPrompt =>
      systemPrompt.includes('navigation') ? 9 : 10
    );

    const result = await runBootstrap(dbs, {
      runAgent: (async (options: any) =>
        options.allowPropose ? agent.fn(options) : solver.fn(options)) as any,
      model: 'test-model',
      budget: new CallBudget(50),
      textModel: text.fn,
    });

    expect(result.before.meanTurns).toBe(10);
    expect(result.after.meanTurns).toBe(9);
    expect(result.activated).toHaveLength(1);
    const active = await store.listByStatus(['active'], ['skill']);
    expect(active.map(entry => entry.slug)).toContain('navigation');
    const navigations = await store.listByStatus(['active'], ['skill']);
    expect(navigations[0].validation?.meanTurnsBefore).toBe(10);
    expect(navigations[0].validation?.meanTurnsAfter).toBe(9);
  });

  it('stores a procedure skill\'s steps as a procedure record', async () => {
    seedSignalTasks();
    const agent = bootstrapAgent({
      'proj-a': [
        proposal({
          slug: 'find-release-work',
          title: 'Find release work',
          description: 'Use when asked about a release build or packaging change',
          steps: [
            { action: 'search', parameters: { query: 'release build', mode: 'text' } },
            { action: 'read', parameters: { startLine: '1' } },
          ],
        }),
      ],
    });
    const text = fakeTextModel();

    await runBootstrap(dbs, {
      runAgent: agent.fn as any,
      model: 'test-model',
      budget: new CallBudget(50),
      textModel: text.fn,
    });

    const skills = await store.listByStatus(['candidate'], ['skill']);
    const procedure = skills.find(entry => entry.slug === 'find-release-work');
    expect(procedure).toBeDefined();
    expect(procedure!.procedureId).toBe('proc:proj-a:find-release-work');
    const stored = await store.getProcedure('proc:proj-a:find-release-work');
    expect(stored).not.toBeNull();
    expect(stored!.steps.map(step => step.action)).toEqual(['search', 'read']);
    expect(stored!.steps[0].parameters.query).toBe('release build');
  });

  it('does not store a reflection the gate rejects', async () => {
    const prompts = seedSignalTasks();
    const agent = bootstrapAgent({ 'proj-a': [proposal({ slug: 'navigation' })] });
    const text = fakeTextModel();
    const solver = solvingAgent(answersFor(prompts), () => 10);
    // A reflection with a URL must not survive.
    const poisonedText = async (prompt: string) =>
      prompt.startsWith('Write one reflection')
        ? `see https://evil.example/x [#${exchangeId()}]`
        : text.fn(prompt);

    const result = await runBootstrap(dbs, {
      runAgent: (async (options: any) =>
        options.allowPropose ? agent.fn(options) : solver.fn(options)) as any,
      model: 'test-model',
      budget: new CallBudget(50),
      textModel: poisonedText,
    });

    expect(await store.listByStatus(['candidate', 'active'], ['reflection'])).toEqual([]);
    expect(result.rejected.map(entry => entry.slug)).toContain(BOOTSTRAP_REFLECTION_SLUG);
  });

  it('records a bootstrapper failure without losing the other projects', async () => {
    index.close();
    index = indexFixture(['proj-a', 'proj-b']);
    dbs = { store, learning, index };
    seedSignalTasks();
    const agent = bootstrapAgent({
      'proj-b': [
        proposal({
          project: 'proj-b',
          slug: 'navigation',
          body: `project proj-b: ${GROUNDED_WORDS} work [#${exchangeId('proj-b')}]`,
        }),
      ],
    });
    const text = fakeTextModel();
    const flaky = async (options: any) => {
      if (options.allowPropose && options.prompt.includes('project: proj-a')) {
        throw new Error('subprocess died');
      }
      return agent.fn(options);
    };

    const result = await runBootstrap(dbs, {
      runAgent: flaky as any,
      model: 'test-model',
      budget: new CallBudget(50),
      textModel: text.fn,
    });

    expect(result.rejected.some(entry => entry.slug === 'proj-a')).toBe(true);
    const skills = await store.listByStatus(['candidate', 'active'], ['skill']);
    expect(skills.map(entry => `${entry.project}/${entry.slug}`)).toContain('proj-b/navigation');
  });

  it('leaves the instruction a candidate under the default approval mode', async () => {
    const prompts = seedSignalTasks();
    const agent = bootstrapAgent({ 'proj-a': [proposal({ slug: 'navigation' })] });
    const text = fakeTextModel();
    const solver = solvingAgent(answersFor(prompts), systemPrompt =>
      systemPrompt.includes('navigation') ? 9 : 10
    );

    const result = await runBootstrap(dbs, {
      runAgent: (async (options: any) =>
        options.allowPropose ? agent.fn(options) : solver.fn(options)) as any,
      model: 'test-model',
      budget: new CallBudget(50),
      textModel: text.fn,
    });

    const instructions = await store.listByStatus(['candidate'], ['instruction']);
    expect(instructions).toHaveLength(1);
    expect(result.activated.some(name => name.includes('instruction'))).toBe(false);
  });

  it('activates the instruction under approve mode none', async () => {
    process.env.EPISODIC_MEMORY_LEARN_APPROVE = 'none';
    const prompts = seedSignalTasks();
    const agent = bootstrapAgent({ 'proj-a': [proposal({ slug: 'navigation' })] });
    const text = fakeTextModel();
    const solver = solvingAgent(answersFor(prompts), systemPrompt =>
      systemPrompt.includes('navigation') ? 9 : 10
    );

    const result = await runBootstrap(dbs, {
      runAgent: (async (options: any) =>
        options.allowPropose ? agent.fn(options) : solver.fn(options)) as any,
      model: 'test-model',
      budget: new CallBudget(50),
      textModel: text.fn,
    });

    const instructions = await store.listByStatus(['active'], ['instruction']);
    expect(instructions).toHaveLength(1);
    expect(result.activated.some(name => name.includes('instruction'))).toBe(true);
  });

  it('writes one gated reflection citing attempt ids', async () => {
    const prompts = seedSignalTasks();
    const agent = bootstrapAgent({ 'proj-a': [proposal({ slug: 'navigation' })] });
    const text = fakeTextModel();
    const solver = solvingAgent(answersFor(prompts), () => 10);

    await runBootstrap(dbs, {
      runAgent: (async (options: any) =>
        options.allowPropose ? agent.fn(options) : solver.fn(options)) as any,
      model: 'test-model',
      budget: new CallBudget(50),
      textModel: text.fn,
    });

    const reflections = await store.listByStatus(['candidate', 'active'], ['reflection']);
    expect(reflections).toHaveLength(1);
    expect(reflections[0].slug).toBe(BOOTSTRAP_REFLECTION_SLUG);
    expect(reflections[0].body).toMatch(/\[#(?:[0-9a-f]{32}),@\d+\]/);

    const attemptIds = learning.prepare('SELECT id FROM learning_attempt ORDER BY id').all() as Array<{
      id: number;
    }>;
    expect(attemptIds.length).toBeGreaterThan(0);
    expect(reflections[0].body).toContain(`@${attemptIds[0].id}`);
  });

  it('stops at the budget cap and keeps the run row marked stopped', async () => {
    seedSignalTasks();
    const agent = bootstrapAgent({ 'proj-a': [proposal({ slug: 'navigation' })] });
    const text = fakeTextModel();

    const result = await runBootstrap(dbs, {
      runAgent: agent.fn as any,
      model: 'test-model',
      budget: new CallBudget(1),
      textModel: text.fn,
    });

    expect(result.status).toBe('stopped');
    expect(getRun(learning, result.runId)!.status).toBe('stopped');
  });

  it('generates tasks when none exist, then measures them', async () => {
    const agent = bootstrapAgent({ 'proj-a': [proposal({ slug: 'navigation' })] });
    const text = fakeTextModel();

    const result = await runBootstrap(dbs, {
      runAgent: agent.fn as any,
      model: 'test-model',
      perProject: 2,
      budget: new CallBudget(50),
      textModel: text.fn,
    });

    const stored = learning.prepare('SELECT COUNT(*) AS n FROM learning_task').get() as { n: number };
    expect(stored.n).toBeGreaterThan(0);
    // The paraphrase call is a text call, not a subprocess.
    expect(text.prompts.some(prompt => prompt.startsWith('You write retrieval practice questions'))).toBe(true);
    expect(result.before.total).toBeGreaterThan(0);
  });

  it('carries the rules in every prompt it sends and never a planted secret', async () => {
    index.close();
    index = indexFixture(['proj-a']);
    dbs = { store, learning, index };
    index
      .prepare('UPDATE exchanges SET user_message = ? WHERE id = ?')
      .run(`token ${SECRET} and the ${GROUNDED_WORDS}`, exchangeId());
    seedSignalTasks();
    const agent = bootstrapAgent({ 'proj-a': [proposal({ slug: 'navigation' })] });
    const text = fakeTextModel();

    await runBootstrap(dbs, {
      runAgent: agent.fn as any,
      model: 'test-model',
      budget: new CallBudget(50),
      textModel: text.fn,
    });

    const prompts = [...agent.calls.map(call => call.systemPrompt), ...agent.calls.map(call => call.prompt), ...text.prompts];
    for (const prompt of prompts) {
      expect(prompt).not.toContain(SECRET);
    }
    const bootstrapper = agent.calls.find(call => call.allowPropose)!;
    expect(bootstrapper.systemPrompt).toMatch(/cite/i);
    expect(bootstrapper.systemPrompt).toMatch(/confidence/i);
    expect(bootstrapper.systemPrompt).toMatch(/url/i);
    expect(bootstrapper.systemPrompt).toMatch(/command/i);
    expect(bootstrapper.systemPrompt).toMatch(/mark/i);
  });

  it('finishes the run row with metrics per kind and tier', async () => {
    seedSignalTasks();
    const agent = bootstrapAgent({ 'proj-a': [proposal({ slug: 'navigation' })] });
    const text = fakeTextModel();

    const result = await runBootstrap(dbs, {
      runAgent: agent.fn as any,
      model: 'test-model',
      budget: new CallBudget(50),
      textModel: text.fn,
    });

    const run = getRun(learning, result.runId)!;
    expect(run.status).toBe('done');
    expect(run.phase).toBe('bootstrap');
    expect(run.metrics).toMatchObject({
      projects: 1,
      proposed: expect.any(Number),
      signalTasks: 2,
    });
    expect(run.metrics.byKindTier).toMatchObject({ 'locate:2': 1, 'when:2': 1 });
  });
});

/** Count of solving calls (no propose tool) in an agent's recorded calls. */
function runCalls(agent: { calls: AgentCall[] }): number {
  return agent.calls.filter(call => !call.allowPropose).length;
}
