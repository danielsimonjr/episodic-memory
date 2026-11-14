/**
 * The topic limits of the topic step, and the settings of the `learn` CLI. Each case sets one
 * variable and asserts an observable effect against the default, or the fallback of an invalid
 * value. A setting that only an agent run reads (learn solve, improve or bootstrap, which the
 * harness refuses) is a guard case: the config module reads the value in this process.
 *
 * A case that fails because the PRODUCT is wrong is `it.skip('Dn pending: ...')`. No assertion is
 * weakened to make a case pass.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { insertKnowledgeEntry } from '../../src/learn/knowledge-db.js';
import { openKnowledgeStore } from '../../src/learn/knowledge-store.js';
import { learnConfig, type LearnConfig } from '../../src/learn/learn-config.js';
import {
  cliBin, fakeOllama, makeSandbox, openIndexDb, removeSandbox, runCli, seedDigestableSession, seedTranscript,
  withSandboxEnv, type CliResult, type FakeOllama, type FakeRequest, type Sandbox,
} from './harness.js';
import { useIsolation } from './isolation.js';

useIsolation();

/** The budget of one child. The case timeout is 120 s (vitest.e2e.config.ts). */
const CHILD_MS = 100_000;
/** The case budget of a case that runs more than one child. */
const CASE_MS = 300_000;
/** The project of the topic cases. */
const PROJECT = 'e2e-topics';
/** The first topic run starts here, so every seeded session (written an hour ago) is a candidate. */
const SINCE = '2025-01-01T00:00:00.000Z';

/** Run the umbrella CLI in `sb`. */
function cli(sb: Sandbox, args: readonly string[], env: Record<string, string | undefined> = {}): Promise<CliResult> {
  return runCli(sb, cliBin('episodic-memory.js'), args, { env, timeoutMs: CHILD_MS });
}

/** One sync with the topic step on. The fake answers every prompt kind; the summaries are skipped. */
function syncTopics(sb: Sandbox, fake: FakeOllama, env: Record<string, string | undefined> = {}): Promise<CliResult> {
  return cli(sb, ['sync'], {
    EPISODIC_MEMORY_SKIP_SUMMARIES: '1',
    EPISODIC_MEMORY_OLLAMA_URL: fake.url,
    EPISODIC_MEMORY_TOPICS: '1',
    EPISODIC_MEMORY_TOPICS_SINCE: SINCE,
    ...env,
  });
}

/** The topic requests that the fake received after `from` (an index into its request log). */
function topicRequests(fake: FakeOllama, from = 0): FakeRequest[] {
  return fake.requests.slice(from).filter((r) => r.kind === 'topic');
}

/** One FILE block of a topic reply. The shape is the one the fake default answers (harness.ts fakeReply). */
function topicFile(slug: string, body: string, mark: number): string {
  return ['=== FILE ' + slug, '# ' + slug, '', `${body} [^1]`, '', `[^1]: Time: 2025-09-19; Sources: ${mark}`, '=== END'].join('\n');
}

/**
 * The first exchange mark that the topic prompt gives. A footnote must cite a mark the prompt holds:
 * a sync may drop the first exchange of a long session from the prompt.
 */
function firstMark(prompt: string): number {
  return Number(/\[(\d+)\] (?:\d{4}-\d{2}-\d{2} )?User:/.exec(prompt)?.[1] ?? '1');
}

/**
 * A scripted topic reply with a new slug on every call. A document that is updated must keep the
 * exchange citations of its earlier version, so each session writes a document of its own.
 */
function freshTopicReply(): (prompt: string) => string {
  let n = 0;
  return (prompt) => topicFile(`topic-${++n}`, 'The build runs on a Linux runner.', firstMark(prompt));
}

/**
 * Two exchanges of one session. The first user message is `userText`, so a case can make it long.
 * `ageMinutes` places the session past the quiet window of the topic step.
 */
function sessionLines(userText: string, ageMinutes: number): string[] {
  const sessionId = randomUUID();
  const base = { isSidechain: false, userType: 'external', cwd: `/e2e/${PROJECT}`, sessionId, version: '2.0.9' };
  const start = Date.now() - ageMinutes * 60_000;
  const stamp = (step: number): string => new Date(start + step * 1000).toISOString();
  const lines: string[] = [];
  let parentUuid: string | null = null;
  for (let i = 0; i < 2; i++) {
    const text = i === 0 ? userText : `Exchange ${i}: the runner cache and the test order are confirmed for the build.`;
    const userUuid = randomUUID();
    const agentUuid = randomUUID();
    lines.push(JSON.stringify({
      ...base, uuid: userUuid, parentUuid, type: 'user', timestamp: stamp(2 * i),
      message: { role: 'user', content: [{ type: 'text', text }] },
    }));
    lines.push(JSON.stringify({
      ...base, uuid: agentUuid, parentUuid: userUuid, type: 'assistant', timestamp: stamp(2 * i + 1),
      message: { role: 'assistant', content: [{ type: 'text', text: 'The agent explains the runner build steps and the cache location for this session.' }] },
    }));
    parentUuid = agentUuid;
  }
  return lines;
}

/** The count of stored topic documents of a project. */
function topicDocCount(sb: Sandbox, project: string): number {
  const db = openIndexDb(sb);
  try {
    return (db.prepare('SELECT COUNT(*) AS n FROM topic_doc WHERE project = ?').get(project) as { n: number }).n;
  } finally {
    db.close();
  }
}

describe('topics: how many sessions reach the model per sync', () => {
  // Each case gets its own sandbox: a session that the topic step finished is never sent again.
  const boxes: Sandbox[] = [];
  const fakes: FakeOllama[] = [];
  afterAll(async () => {
    for (const fake of fakes) await fake.close();
    for (const sb of boxes) removeSandbox(sb);
  });

  it('EPISODIC_MEMORY_TOPICS_MAX_SESSIONS=1 sends one session to the topic model per sync; the default sends both', async () => {
    for (const [limit, expected] of [['1', 1], [undefined, 2]] as const) {
      const sb = makeSandbox();
      const fake = await fakeOllama('ok');
      boxes.push(sb);
      fakes.push(fake);
      fake.setReply('topic', freshTopicReply());
      seedDigestableSession(sb, PROJECT, { exchanges: 2, ageMinutes: 60 });
      seedDigestableSession(sb, PROJECT, { exchanges: 2, ageMinutes: 90 });
      const sync = await syncTopics(sb, fake, { EPISODIC_MEMORY_TOPICS_MAX_SESSIONS: limit });
      expect(sync.code, sync.stderr).toBe(0);
      expect(topicRequests(fake), `limit ${limit ?? 'default'}`).toHaveLength(expected);
    }
  }, CASE_MS);

  it('EPISODIC_MEMORY_TOPICS_MAX_TRANSCRIPT_CHARS=300 cuts the transcript of a session in the topic prompt; the default keeps its tail', async () => {
    const marker = 'TAILMARK-7731';
    const longText = `Build question: ${'the runner cache and the test order matter. '.repeat(20)}${marker}`;
    const capped = makeSandbox();
    const whole = makeSandbox();
    const fake = await fakeOllama('ok');
    boxes.push(capped, whole);
    fakes.push(fake);
    fake.setReply('topic', freshTopicReply());
    seedTranscript(capped, PROJECT, sessionLines(longText, 60));
    seedTranscript(whole, PROJECT, sessionLines(longText, 60));
    const cut = await syncTopics(capped, fake, { EPISODIC_MEMORY_TOPICS_MAX_TRANSCRIPT_CHARS: '300' });
    expect(cut.code, cut.stderr).toBe(0);
    const cutPrompts = topicRequests(fake).map((r) => r.prompt);
    expect(cutPrompts).toHaveLength(1);
    expect(cutPrompts[0]).not.toContain(marker);
    const second = fake.requests.length;
    const full = await syncTopics(whole, fake);
    expect(full.code, full.stderr).toBe(0);
    const fullPrompts = topicRequests(fake, second).map((r) => r.prompt);
    expect(fullPrompts).toHaveLength(1);
    expect(fullPrompts[0]).toContain(marker);
  }, CASE_MS);
});

describe('topics: documents in the prompt and at install', () => {
  const boxes: Sandbox[] = [];
  const fakes: FakeOllama[] = [];
  afterAll(async () => {
    for (const fake of fakes) await fake.close();
    for (const sb of boxes) removeSandbox(sb);
  });

  it('EPISODIC_MEMORY_TOPICS_MAX_DOCS_CHARS=100 leaves a stored document out of the next prompt; the default shows it', async () => {
    const marker = 'ALPHAMARK-2290';
    const alphaBody = `${marker} ${'the release steps are ordered and logged. '.repeat(10)}`;
    for (const [limit, shown] of [['100', false], [undefined, true]] as const) {
      const sb = makeSandbox();
      const fake = await fakeOllama('ok');
      boxes.push(sb);
      fakes.push(fake);
      // The first session writes `alpha`; the second writes `beta`, so no citation of `alpha` is lost.
      let n = 0;
      fake.setReply('topic', (prompt) => (n++ === 0
        ? topicFile('alpha', alphaBody, firstMark(prompt))
        : topicFile('beta', 'The cache notes are kept with the runner.', firstMark(prompt))));
      seedTranscript(sb, PROJECT, sessionLines('Release question one: the signing step comes first.', 90));
      const first = await syncTopics(sb, fake);
      expect(first.code, first.stderr).toBe(0);
      expect(topicDocCount(sb, PROJECT)).toBe(1);
      const from = fake.requests.length;
      seedTranscript(sb, PROJECT, sessionLines('Release question two: the cache notes come next.', 60));
      const second = await syncTopics(sb, fake, limit === undefined ? {} : { EPISODIC_MEMORY_TOPICS_MAX_DOCS_CHARS: limit });
      expect(second.code, second.stderr).toBe(0);
      const prompts = topicRequests(fake, from).map((r) => r.prompt);
      expect(prompts, `limit ${limit ?? 'default'}`).toHaveLength(1);
      expect(prompts[0].includes(marker), `limit ${limit ?? 'default'}`).toBe(shown);
    }
  }, CASE_MS);

  it('EPISODIC_MEMORY_TOPICS_MAX_DOC_CHARS=100 rejects a document longer than the cap; the default installs it', async () => {
    const longBody = `The release steps are ordered and logged. ${'Each step has one owner. '.repeat(18)}`;
    for (const [limit, installed] of [['100', 0], [undefined, 1]] as const) {
      const sb = makeSandbox();
      const fake = await fakeOllama('ok');
      boxes.push(sb);
      fakes.push(fake);
      fake.setReply('topic', (prompt) => topicFile('alpha', longBody, firstMark(prompt)));
      seedDigestableSession(sb, PROJECT, { exchanges: 2, ageMinutes: 60 });
      const sync = await syncTopics(sb, fake, limit === undefined ? {} : { EPISODIC_MEMORY_TOPICS_MAX_DOC_CHARS: limit });
      expect(sync.code, sync.stderr).toBe(0);
      expect(topicDocCount(sb, PROJECT), `limit ${limit ?? 'default'}`).toBe(installed);
    }
  }, CASE_MS);

  it('EPISODIC_MEMORY_TOPICS_MAX_DOCS=1 rejects a session that writes two documents to one project; the default installs both', async () => {
    for (const [limit, installed] of [['1', 0], [undefined, 2]] as const) {
      const sb = makeSandbox();
      const fake = await fakeOllama('ok');
      boxes.push(sb);
      fakes.push(fake);
      fake.setReply('topic', (prompt) => {
        const mark = firstMark(prompt);
        return [topicFile('alpha', 'The release steps are ordered.', mark), topicFile('beta', 'The cache notes are kept.', mark)].join('\n');
      });
      seedDigestableSession(sb, PROJECT, { exchanges: 2, ageMinutes: 60 });
      const sync = await syncTopics(sb, fake, limit === undefined ? {} : { EPISODIC_MEMORY_TOPICS_MAX_DOCS: limit });
      expect(sync.code, sync.stderr).toBe(0);
      expect(topicDocCount(sb, PROJECT), `limit ${limit ?? 'default'}`).toBe(installed);
    }
  }, CASE_MS);
});

/** The project of the learn cases: `sync` names the project after its folder. */
const LEARN_PROJECT = 'e2e-learn-env';
const LEARN_SESSION = '5e2e1ea0-0000-4000-8000-0000000b0001';
/** Exchanges of the learn project. selectSourceExchanges needs at least 20 of them. */
const EXCHANGES = 24;
/** The seeded index needs one sync with the model load. */
const HEAVY_MS = 600_000;

/** Transcript lines: EXCHANGES user and assistant pairs, long enough for the source selection of learn. */
function learnLines(): string[] {
  const base = { isSidechain: false, userType: 'external', cwd: `/e2e/${LEARN_PROJECT}`, sessionId: LEARN_SESSION, version: '2.0.9' };
  const lines: string[] = [];
  let parent: string | null = null;
  for (let i = 0; i < EXCHANGES; i++) {
    const user = `Exchange ${i}: the team asks how the release checklist orders the signing step, the changelog entry and the tag.`;
    const agent = `The checklist runs in this order for exchange ${i}. The changelog gets its entry first, then the version is bumped in the manifest, then the tag is cut on the default branch and signed. Every step has one owner and one log line, and a failed step stops the run before the tag is pushed.`;
    const userUuid = `e2e-env-u-${i}`;
    const agentUuid = `e2e-env-a-${i}`;
    const stamp = new Date(Date.UTC(2025, 9, 8, 10, 0, i)).toISOString();
    lines.push(JSON.stringify({
      ...base, uuid: userUuid, parentUuid: parent, type: 'user', timestamp: stamp,
      message: { role: 'user', content: [{ type: 'text', text: user }] },
    }));
    lines.push(JSON.stringify({
      ...base, uuid: agentUuid, parentUuid: userUuid, type: 'assistant', timestamp: stamp,
      message: { role: 'assistant', content: [{ type: 'text', text: agent }] },
    }));
    parent = agentUuid;
  }
  return lines;
}

/** The fields of `learn report --json` that the budget cases read. */
interface ReportJson {
  run: { id: string };
  budget: { maxCalls: number | null; usedCalls: number; maxUsd: number | null; usedUsd: number };
}

describe('learn: task count and budget of a run', () => {
  let sb: Sandbox;
  let fake: FakeOllama;

  beforeAll(async () => {
    sb = makeSandbox();
    fake = await fakeOllama('ok');
    seedTranscript(sb, LEARN_PROJECT, learnLines(), { sessionId: LEARN_SESSION });
    const synced = await cli(sb, ['sync'], { EPISODIC_MEMORY_SKIP_SUMMARIES: '1' });
    expect(synced.code, synced.stderr).toBe(0);
  }, HEAVY_MS);

  afterAll(async () => {
    await fake.close();
    removeSandbox(sb);
  });

  /** Run `learn <args>` with the flag on and the fake model. */
  function learn(args: readonly string[], env: Record<string, string | undefined> = {}): Promise<CliResult> {
    return runCli(sb, cliBin('episodic-memory.js'), ['learn', ...args], {
      env: { EPISODIC_MEMORY_OLLAMA_URL: fake.url, EPISODIC_MEMORY_LEARN: '1', ...env },
      timeoutMs: CHILD_MS,
    });
  }

  /** The JSON report of the latest run, which carries the budget that the run recorded. */
  async function latestReport(): Promise<ReportJson> {
    const result = await learn(['report', '--json']);
    expect(result.code, result.stderr).toBe(0);
    return JSON.parse(result.stdout) as ReportJson;
  }

  it('EPISODIC_MEMORY_LEARN_MAX_TASKS=1 stores one task in the run; the default stores more', async () => {
    const capped = await learn(['tasks', '--seed', '7', '--per-project', '2'], { EPISODIC_MEMORY_LEARN_MAX_TASKS: '1' });
    expect(capped.code, capped.stderr).toBe(0);
    expect(capped.stderr).toContain('1 task(s) generated in run ');
    const whole = await learn(['tasks', '--seed', '7', '--per-project', '2']);
    expect(whole.code, whole.stderr).toBe(0);
    const created = Number(/(\d+) task\(s\) generated/.exec(whole.stderr)?.[1]);
    expect(created).toBeGreaterThan(1);
  }, CASE_MS);

  it('EPISODIC_MEMORY_LEARN_MAX_CALLS=7 is the call budget the run records; the default records 200', async () => {
    const capped = await learn(['tasks', '--seed', '7', '--per-project', '2'], { EPISODIC_MEMORY_LEARN_MAX_CALLS: '7' });
    expect(capped.code, capped.stderr).toBe(0);
    expect((await latestReport()).budget.maxCalls).toBe(7);
    const whole = await learn(['tasks', '--seed', '7', '--per-project', '2']);
    expect(whole.code, whole.stderr).toBe(0);
    expect((await latestReport()).budget.maxCalls).toBe(200);
  }, CASE_MS);

  it('EPISODIC_MEMORY_LEARN_MAX_USD=2.5 is the spend budget the run records; the default records 5', async () => {
    const capped = await learn(['tasks', '--seed', '7', '--per-project', '2'], { EPISODIC_MEMORY_LEARN_MAX_USD: '2.5' });
    expect(capped.code, capped.stderr).toBe(0);
    expect((await latestReport()).budget.maxUsd).toBe(2.5);
    const whole = await learn(['tasks', '--seed', '7', '--per-project', '2']);
    expect(whole.code, whole.stderr).toBe(0);
    expect((await latestReport()).budget.maxUsd).toBe(5);
  }, CASE_MS);
});

/** The approval record that clears every refusal of `learn approve` (learn.test.ts uses the same record). */
const VALIDATED = {
  targeted: [1], sample: [1], passedBefore: 0, passedAfter: 1, regressions: [],
  judgedAt: '2025-10-08T12:00:00.000Z', meanTurnsBefore: null, meanTurnsAfter: 2,
  usdBefore: null, usdAfter: null, gradedBefore: 1, gradedAfter: 1,
};

describe('learn: the rendered block size', () => {
  let sb: Sandbox;
  let skillName = '';
  /** The last words of the approved skill body. They sit past a small cap. */
  const LAST_STEP = 'LASTSTEP-5512';
  // The rendered block lists a skill by its description (the body is read through the skills tool), so the long text is the description.
  const DESCRIPTION = `${Array.from({ length: 24 }, (_, i) => `Step ${i + 1} of the release runs after step ${i}, and each step is logged once.`).join(' ')} ${LAST_STEP}.`;
  const SKILL_BODY = 'Write the changelog entry first, then bump the manifest.';

  beforeAll(async () => {
    sb = makeSandbox();
    await withSandboxEnv(sb, async () => {
      const store = openKnowledgeStore();
      try {
        skillName = await insertKnowledgeEntry(store, {
          project: LEARN_PROJECT, confidence: 'high', trust: 'unverified', sources: [], status: 'candidate', runId: 'run-e2e-render',
          kind: 'skill', slug: 'release-steps', title: 'Release steps', description: DESCRIPTION,
          scope: 'release of this project', body: SKILL_BODY,
        });
        await store.setValidation(skillName, VALIDATED);
      } finally {
        store.close();
      }
    });
    const approved = await runCli(sb, cliBin('episodic-memory.js'), ['learn', 'approve', skillName, '--yes'], {
      env: { EPISODIC_MEMORY_LEARN: '1' }, timeoutMs: CHILD_MS,
    });
    expect(approved.code, approved.stderr).toBe(0);
    expect(approved.stderr).toContain(`approved ${skillName}`);
  }, HEAVY_MS);

  afterAll(() => {
    removeSandbox(sb);
  });

  /** Run `learn render --project` with the flag on and the given extra variables. */
  function render(env: Record<string, string | undefined>): Promise<CliResult> {
    return runCli(sb, cliBin('episodic-memory.js'), ['learn', 'render', '--project', LEARN_PROJECT], {
      env: { EPISODIC_MEMORY_LEARN: '1', ...env }, timeoutMs: CHILD_MS,
    });
  }

  it('EPISODIC_MEMORY_LEARN_MAX_CHARS=500 cuts the rendered block below 500 characters; the default keeps the last step', async () => {
    const capped = await render({ EPISODIC_MEMORY_LEARN_MAX_CHARS: '500' });
    expect(capped.code, capped.stderr).toBe(0);
    expect(capped.stdout.trimEnd().length).toBeLessThanOrEqual(500);
    // Under the cap the skill line does not fit, so the block keeps its header and drops the line.
    expect(capped.stdout).toContain('learned hints');
    expect(capped.stdout).not.toContain('release-steps');
    expect(capped.stdout).not.toContain(LAST_STEP);
    const whole = await render({});
    expect(whole.code, whole.stderr).toBe(0);
    expect(whole.stdout).toContain('release-steps');
    expect(whole.stdout).toContain(LAST_STEP);
    expect(whole.stdout.trimEnd().length).toBeGreaterThan(500);
  }, CASE_MS);
});

/** Each row: the variable, the config field it sets, a valid text and its value, an invalid text and the default. */
const GUARD_ROWS: Array<{ name: string; field: keyof LearnConfig; valid: string; want: unknown; invalid: string; fallback: unknown }> = [
  { name: 'EPISODIC_MEMORY_LEARN_CONCURRENCY', field: 'concurrency', valid: '5', want: 5, invalid: '0', fallback: 3 },
  { name: 'EPISODIC_MEMORY_LEARN_ROUNDS', field: 'rounds', valid: '2', want: 2, invalid: 'abc', fallback: 3 },
  { name: 'EPISODIC_MEMORY_LEARN_MIN_SAVING', field: 'minSavingPct', valid: '25', want: 25, invalid: '-1', fallback: 10 },
  { name: 'EPISODIC_MEMORY_LEARN_MIN_GROUNDING', field: 'minGrounding', valid: '4', want: 4, invalid: '1.5', fallback: 3 },
  { name: 'EPISODIC_MEMORY_LEARN_SOLVER_MAX_TURNS', field: 'solverMaxTurns', valid: '9', want: 9, invalid: '', fallback: 12 },
  { name: 'EPISODIC_MEMORY_LEARN_LEARNER_MAX_TURNS', field: 'learnerMaxTurns', valid: '40', want: 40, invalid: 'x', fallback: 30 },
  { name: 'EPISODIC_MEMORY_LEARN_LEAF_MAX', field: 'leafMax', valid: '6', want: 6, invalid: '0', fallback: 12 },
  { name: 'EPISODIC_MEMORY_LEARN_EDITS_PER_ROUND', field: 'editsPerRound', valid: '2', want: 2, invalid: '-3', fallback: 3 },
  { name: 'EPISODIC_MEMORY_LEARN_VALIDATE_SAMPLE', field: 'validateSample', valid: '7', want: 7, invalid: '2.5', fallback: 5 },
  { name: 'EPISODIC_MEMORY_LEARN_PID_POLL_MS', field: 'pidPollMs', valid: '250', want: 250, invalid: 'NaN', fallback: 1000 },
  { name: 'EPISODIC_MEMORY_LEARN_MAX_MINUTES', field: 'maxMinutes', valid: '15', want: 15, invalid: '0', fallback: 60 },
  { name: 'EPISODIC_MEMORY_LEARN_APPROVE', field: 'approve', valid: 'none', want: 'none', invalid: 'bogus', fallback: 'instructions' },
  { name: 'EPISODIC_MEMORY_LEARN_MODEL', field: 'model', valid: 'opus', want: 'opus', invalid: ' ', fallback: 'sonnet' },
];

describe('learn: settings that no CLI command prints (guard only: no surface)', () => {
  // These settings reach only an agent run (learn solve, improve or bootstrap), which the harness refuses,
  // and the CLI prints none of them. The config module is the observable surface: it reads each value in this process.
  it.each(GUARD_ROWS)('$name is read as its value; an invalid value falls back to the default', (row) => {
    const before = process.env[row.name];
    try {
      process.env[row.name] = row.valid;
      expect(learnConfig()[row.field], `${row.name}=${row.valid}`).toEqual(row.want);
      process.env[row.name] = row.invalid;
      expect(learnConfig()[row.field], `${row.name}=${JSON.stringify(row.invalid)}`).toEqual(row.fallback);
    } finally {
      if (before === undefined) delete process.env[row.name];
      else process.env[row.name] = before;
    }
  });
});
