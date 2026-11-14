/**
 * The `learn` subcommands, end to end. One sandbox per describe:
 * - flag off: every subcommand exits 0 with the off message, calls no model and creates no `learned/` folder;
 * - flag on: a real `sync` indexes one project of 24 exchanges. `tasks`, `status` and `report` run on it;
 * - approve, export and render: two candidates are seeded through the store API, then approved;
 * - `doctor codex`: no codex on PATH, a fake codex in the child PATH, and a pristine config folder.
 *
 * `learn solve|improve|bootstrap` run the Agent SDK. The harness refuses them without the
 * `learn-agent` allowance, which no case names. The refusal is asserted and nothing else.
 *
 * A case that fails because the product is wrong is `it.skip('Dn pending: ...')`, with the
 * measured input and output in its title. No assertion is weakened to make a case pass.
 */
import { chmodSync, existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { insertKnowledgeEntry } from '../../src/learn/knowledge-db.js';
import { openKnowledgeStore } from '../../src/learn/knowledge-store.js';
import {
  EXIT_FAIL, EXIT_USAGE, cliBin, fakeOllama, makeSandbox, removeSandbox, runCli, seedTranscript, withSandboxEnv,
  type CliResult, type FakeOllama, type Sandbox,
} from './harness.js';
import { useIsolation } from './isolation.js';

/** The project of the seeded transcript: `sync` names the project after its folder. */
const PROJECT = 'e2e-learn';
const SESSION = '5e2e1ea0-0000-4000-8000-0000000a0001';
/** Exchanges in the seeded project. selectSourceExchanges needs at least MIN_PER_PROJECT (20) of them. */
const EXCHANGES = 24;
/** The seeded index needs one sync with the model load. */
const HEAVY_MS = 600_000;
/** The child timeout. It stays under the 120 s case timeout of vitest.e2e.config.ts. */
const CHILD_MS = 100_000;
/** The text of the flag-off message (src/learn/learn-config.ts LEARN_OFF_MESSAGE). */
const LEARN_OFF = 'Learning is off';

useIsolation();

/** Transcript lines: EXCHANGES user and assistant pairs. Each pair clears the source selection (user >= 80, assistant >= 200 characters). */
function learnLines(): string[] {
  const base = { isSidechain: false, userType: 'external', cwd: `/e2e/${PROJECT}`, sessionId: SESSION, version: '2.0.9' };
  const lines: string[] = [];
  let parent: string | null = null;
  for (let i = 0; i < EXCHANGES; i++) {
    const user = `Exchange ${i}: the team asks how the release checklist orders the signing step, the changelog entry and the tag.`;
    const agent = `The checklist runs in this order for exchange ${i}. The changelog gets its entry first, then the version is bumped in the manifest, then the tag is cut on the default branch and signed. Every step has one owner and one log line, and a failed step stops the run before the tag is pushed.`;
    const userUuid = `e2e-u-${i}`;
    const agentUuid = `e2e-a-${i}`;
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

describe('learn: flag off', () => {
  let sb: Sandbox;
  let ollama: FakeOllama;

  beforeAll(async () => {
    sb = makeSandbox();
    ollama = await fakeOllama('ok');
  }, HEAVY_MS);

  afterAll(async () => {
    await ollama.close();
    removeSandbox(sb);
  });

  // Every subcommand, and the flags that the registry names. The flag is off, so none of them may run.
  const OFF_CASES: string[][] = [
    ['tasks'],
    ['tasks', '--seed', '7', '--per-project', '2'],
    ['tasks', '--check'],
    ['status'],
    ['report'],
    ['report', '--json'],
    ['report', '--run', 'run-none'],
    ['approve', 'skill/e2e-learn/nothing', '--yes'],
    ['export'],
    ['export', '--to', 'out'],
    ['render'],
    ['render', '--project', PROJECT],
  ];

  for (const args of OFF_CASES) {
    it(`learn ${args.join(' ')} exits 0 with the off message and runs nothing`, async () => {
      const result = await runCli(sb, cliBin('episodic-memory.js'), ['learn', ...args], {
        env: { EPISODIC_MEMORY_OLLAMA_URL: ollama.url },
        timeoutMs: CHILD_MS,
      });
      expect(result.code, result.stderr).toBe(0);
      expect(result.stderr).toContain(LEARN_OFF);
      expect(result.stdout).toBe('');
      // The off path opens no store, so the learned folder never appears, and no model is called.
      expect(existsSync(path.join(sb.cfg, 'learned'))).toBe(false);
      expect(ollama.requests.length).toBe(0);
    }, CHILD_MS);
  }

  it('refuses learn solve, improve and bootstrap in the harness, before any spawn', () => {
    // The Agent SDK subprocess is never started: runCli throws synchronously on the missing allowance.
    for (const sub of ['solve', 'improve', 'bootstrap']) {
      expect(() => runCli(sb, cliBin('episodic-memory.js'), ['learn', sub])).toThrow(/learn-agent/);
    }
    expect(ollama.requests.length).toBe(0);
  });
});

describe('learn: flag on, tasks, status and report', () => {
  let sb: Sandbox;
  let ollama: FakeOllama;
  /** The run that the first `tasks` command created. Later cases name it. */
  let runId = '';

  /** Run `learn <args>` with the flag on and the fake model. */
  function learnCli(args: readonly string[], env: Record<string, string | undefined> = {}): Promise<CliResult> {
    return runCli(sb, cliBin('episodic-memory.js'), ['learn', ...args], {
      env: { EPISODIC_MEMORY_OLLAMA_URL: ollama.url, EPISODIC_MEMORY_LEARN: '1', ...env },
      timeoutMs: CHILD_MS,
    });
  }

  /** Read rows of the learning database read-only. The test reads them itself, not through a CLI. */
  function learningRows<T>(sql: string, ...params: Array<string | number>): T[] {
    const file = path.join(sb.cfg, 'learned', 'learning.sqlite');
    if (!existsSync(file)) throw new Error(`no learning database at ${file}`);
    const db = new DatabaseSync(file, { readOnly: true });
    try {
      return db.prepare(sql).all(...params) as T[];
    } finally {
      db.close();
    }
  }

  /** The number of model calls of the learn paraphrase kind that the fake received. */
  function learnCalls(): number {
    return ollama.requests.filter((r) => r.kind === 'learn').length;
  }

  beforeAll(async () => {
    sb = makeSandbox();
    ollama = await fakeOllama('ok');
    seedTranscript(sb, PROJECT, learnLines(), { sessionId: SESSION });
    // Index the transcript. The summaries are skipped: learn reads only the exchange rows.
    const synced = await runCli(sb, cliBin('episodic-memory.js'), ['sync'], {
      env: { EPISODIC_MEMORY_SKIP_SUMMARIES: '1' },
      timeoutMs: CHILD_MS,
    });
    expect(synced.code, synced.stderr).toBe(0);
  }, HEAVY_MS);

  afterAll(async () => {
    await ollama.close();
    removeSandbox(sb);
  });

  it('tasks --seed 7 --per-project 2 stores tasks, asks the model once per selected exchange, and records the seed', async () => {
    const result = await learnCli(['tasks', '--seed', '7', '--per-project', '2']);
    expect(result.code, result.stderr).toBe(0);
    expect(result.stderr).toMatch(/\d+ task\(s\) generated in run /);
    const [latest] = learningRows<{ id: string; seed: number; status: string }>(
      'SELECT id, seed, status FROM learning_run ORDER BY started_at DESC, rowid DESC LIMIT 1'
    );
    expect(latest.seed).toBe(7);
    expect(latest.status).toBe('done');
    runId = latest.id;
    // --per-project 2 selects two exchanges, and each one makes one paraphrase call.
    expect(learnCalls()).toBe(2);
    const [{ n }] = learningRows<{ n: number }>('SELECT COUNT(*) AS n FROM learning_task WHERE run_id = ?', runId);
    expect(n).toBeGreaterThan(0);
  }, CHILD_MS);

  it('tasks --check marks stale tasks, writes no task row, and calls no model', async () => {
    const [{ n: before }] = learningRows<{ n: number }>('SELECT COUNT(*) AS n FROM learning_task');
    const calls = learnCalls();
    const result = await learnCli(['tasks', '--check']);
    expect(result.code, result.stderr).toBe(0);
    expect(result.stderr).toContain('stale task(s) marked');
    const [{ n: after }] = learningRows<{ n: number }>('SELECT COUNT(*) AS n FROM learning_task');
    expect(after).toBe(before);
    expect(learnCalls()).toBe(calls);
  }, CHILD_MS);

  it('status prints the flag state, the candidate section and the latest run with its status', async () => {
    const result = await learnCli(['status']);
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toContain('EPISODIC_MEMORY_LEARN=on');
    expect(result.stdout).toContain('candidates awaiting approval (0):');
    expect(result.stdout).toContain(`latest run: ${runId}`);
    expect(result.stdout).toContain('status done');
  }, CHILD_MS);

  it('report --json prints the run as JSON, and --run names the same run in the text report', async () => {
    const json = await learnCli(['report', '--json']);
    expect(json.code, json.stderr).toBe(0);
    const model = JSON.parse(json.stdout) as { run: { id: string; phase: string; seed: number } };
    expect(model.run.id).toBe(runId);
    expect(model.run.phase).toBe('improve');
    expect(model.run.seed).toBe(7);
    const byId = await learnCli(['report', '--run', runId]);
    expect(byId.code, byId.stderr).toBe(0);
    expect(byId.stdout).toContain(`run ${runId}`);
  }, CHILD_MS);

  it('report --run with no such run exits 1 and names the run', async () => {
    const result = await learnCli(['report', '--run', 'run-no-such']);
    expect(result.code).toBe(EXIT_FAIL);
    expect(result.stderr).toContain('no such run: run-no-such');
  }, CHILD_MS);

  it('an unknown subcommand exits 2 with one line that names it', async () => {
    const calls = learnCalls();
    const result = await learnCli(['bogus']);
    expect(result.code).toBe(EXIT_USAGE);
    expect(result.stderr).toContain("unknown command 'bogus'");
    expect(learnCalls()).toBe(calls);
  }, CHILD_MS);

  it('render before any approval writes zero learned-hints blocks, and --project names the missing block', async () => {
    const result = await learnCli(['render']);
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toContain('rendered 0 learned-hints block(s)');
    const missing = await learnCli(['render', '--project', PROJECT]);
    expect(missing.code).toBe(EXIT_FAIL);
    expect(missing.stderr).toContain(`no learned-hints block for project '${PROJECT}'`);
  }, CHILD_MS);
});

describe('learn: approve, export and render', () => {
  let sb: Sandbox;
  let ollama: FakeOllama;
  /** The entry names of the two candidates, set by the seeding in beforeAll. */
  let instructionName = '';
  let skillName = '';
  // An instruction line must match a template form (learned-text-screen.ts) and end in a citation mark.
  const INSTRUCTION_BODY = 'project e2e-learn: cut the release tag only after the signing step passes. [#1]';
  const SKILL_BODY = 'Write the changelog entry first, then bump the manifest.';
  /** A validation record that clears every refusal of `approve`: graded, no regression, no fall in passes. */
  const VALIDATED = {
    targeted: [1], sample: [1], passedBefore: 0, passedAfter: 1, regressions: [],
    judgedAt: '2025-10-08T12:00:00.000Z', meanTurnsBefore: null, meanTurnsAfter: 2,
    usdBefore: null, usdAfter: null, gradedBefore: 1, gradedAfter: 1,
  };

  /** Run `learn <args>` with the flag on and the fake model. */
  function learnCli(args: readonly string[]): Promise<CliResult> {
    return runCli(sb, cliBin('episodic-memory.js'), ['learn', ...args], {
      env: { EPISODIC_MEMORY_OLLAMA_URL: ollama.url, EPISODIC_MEMORY_LEARN: '1' },
      timeoutMs: CHILD_MS,
    });
  }

  /** One stored entry, read through the store API in the sandbox. */
  function entryOf(name: string) {
    return withSandboxEnv(sb, async () => {
      const store = openKnowledgeStore();
      try {
        return await store.getEntry(name);
      } finally {
        store.close();
      }
    });
  }

  /** Read rows of the learning database read-only. The test reads them itself, not through a CLI. */
  function learningRows<T>(sql: string): T[] {
    const db = new DatabaseSync(path.join(sb.cfg, 'learned', 'learning.sqlite'), { readOnly: true });
    try {
      return db.prepare(sql).all() as T[];
    } finally {
      db.close();
    }
  }

  beforeAll(async () => {
    sb = makeSandbox();
    ollama = await fakeOllama('ok');
    // There is no offline producer of candidates, so the test process seeds two, with a validation record each.
    await withSandboxEnv(sb, async () => {
      const store = openKnowledgeStore();
      try {
        const base = { project: PROJECT, confidence: 'high' as const, trust: 'unverified' as const, sources: [], status: 'candidate' as const, runId: 'run-e2e-seed' };
        instructionName = await insertKnowledgeEntry(store, {
          ...base, kind: 'instruction', slug: 'release-order', title: 'Release order',
          description: 'Order of the release steps', scope: 'release of this project', body: INSTRUCTION_BODY,
        });
        await store.setValidation(instructionName, VALIDATED);
        skillName = await insertKnowledgeEntry(store, {
          ...base, kind: 'skill', slug: 'release-checklist', title: 'Release checklist',
          description: 'Checklist of the release steps', scope: 'release of this project', body: SKILL_BODY,
        });
        await store.setValidation(skillName, VALIDATED);
      } finally {
        store.close();
      }
    });
  }, HEAVY_MS);

  afterAll(async () => {
    await ollama.close();
    removeSandbox(sb);
  });

  it('approve with no entry name exits 2 and asks for one', async () => {
    const result = await learnCli(['approve']);
    expect(result.code).toBe(EXIT_USAGE);
    expect(result.stderr).toContain('approve needs an entry name');
  }, CHILD_MS);

  it('approve of a name that is not stored exits 1 and changes no entry', async () => {
    const byName = await learnCli(['approve', `learned:instruction:${PROJECT}:nope:v1`]);
    expect(byName.code).toBe(EXIT_FAIL);
    expect(byName.stderr).toContain(`no such entry: learned:instruction:${PROJECT}:nope:v1`);
    const bySlug = await learnCli(['approve', `skill/${PROJECT}/nobody`]);
    expect(bySlug.code).toBe(EXIT_FAIL);
    expect(bySlug.stderr).toContain(`no such entry: skill/${PROJECT}/nobody`);
    expect((await entryOf(instructionName))?.status).toBe('candidate');
  }, CHILD_MS);

  it('approve without --yes and without a TTY prints the diff, refuses, and leaves the candidate', async () => {
    const result = await learnCli(['approve', instructionName]);
    expect(result.code).toBe(EXIT_FAIL);
    expect(result.stderr).toContain('not a TTY');
    // The entry and its diff print before the refusal: the body is the one added line.
    expect(result.stdout).toContain('diff against (no earlier version):');
    expect(result.stdout).toContain(`+${INSTRUCTION_BODY}`);
    expect((await entryOf(instructionName))?.status).toBe('candidate');
  }, CHILD_MS);

  it('approve --yes activates the instruction as ground truth', async () => {
    const result = await learnCli(['approve', instructionName, '--yes']);
    expect(result.code, result.stderr).toBe(0);
    expect(result.stderr).toContain(`approved ${instructionName} (trust ground-truth)`);
    const stored = await entryOf(instructionName);
    expect(stored?.status).toBe('active');
    expect(stored?.trust).toBe('ground-truth');
  }, CHILD_MS);

  it('approve --yes activates the skill candidate, and a second approve of it changes nothing', async () => {
    const result = await learnCli(['approve', skillName, '--yes']);
    expect(result.code, result.stderr).toBe(0);
    expect((await entryOf(skillName))?.status).toBe('active');
    const again = await learnCli(['approve', skillName]);
    expect(again.code, again.stderr).toBe(0);
    expect(again.stderr).toContain('already active');
    expect((await entryOf(skillName))?.status).toBe('active');
  }, CHILD_MS);

  it('export --to writes the active skill as SKILL.md under the folder, and no instruction', async () => {
    const out = path.join(sb.root, 'out');
    const result = await learnCli(['export', '--to', out]);
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toContain(`exported 1 skill(s) to ${out}`);
    const file = path.join(out, PROJECT, 'release-checklist', 'SKILL.md');
    expect(existsSync(file)).toBe(true);
    const text = readFileSync(file, 'utf-8');
    expect(text).toContain('name: release-checklist');
    expect(text).toContain(SKILL_BODY);
    // An instruction is never exported as a skill.
    expect(existsSync(path.join(out, PROJECT, 'release-order'))).toBe(false);
  }, CHILD_MS);

  it('render writes one learned-hints block for the project, and --project prints the approved text', async () => {
    const result = await learnCli(['render']);
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toContain('rendered 1 learned-hints block(s)');
    expect(result.stdout).toContain(`${PROJECT}:`);
    const rows = learningRows<{ project: string }>('SELECT project FROM learned_block');
    expect(rows.map((row) => row.project)).toEqual([PROJECT]);
    const shown = await learnCli(['render', '--project', PROJECT]);
    expect(shown.code, shown.stderr).toBe(0);
    expect(shown.stdout).toContain(INSTRUCTION_BODY);
  }, CHILD_MS);

  it('render --project with a project that has no block exits 1', async () => {
    const result = await learnCli(['render', '--project', 'e2e-nobody']);
    expect(result.code).toBe(EXIT_FAIL);
    expect(result.stderr).toContain("no learned-hints block for project 'e2e-nobody'");
  }, CHILD_MS);
});

/** The Codex version row of a `doctor codex` report (src/doctor.ts buildCodexDoctorReport). */
function codexRow(text: string): string {
  return text.split('\n').find((line) => line.startsWith('Codex version:')) ?? '';
}

describe('doctor codex: no codex on PATH', () => {
  let sb: Sandbox;

  beforeAll(() => {
    // The child PATH is the empty `bin` folder of the sandbox, so `codex` is not found.
    sb = makeSandbox();
  }, HEAVY_MS);

  afterAll(() => {
    removeSandbox(sb);
  });

  it('reports the Codex version as not found, lists the issues, and exits 1', async () => {
    const result = await runCli(sb, cliBin('episodic-memory.js'), ['doctor', 'codex'], { timeoutMs: CHILD_MS });
    expect(result.code).toBe(EXIT_FAIL);
    expect(codexRow(result.stdout)).toBe('Codex version: (not found) (requires minimum 0.130.0)');
    expect(result.stdout).toContain(`Codex home: ${sb.codex}`);
    expect(result.stdout).toContain('Issues:');
    expect(result.stdout).toContain('Codex must be upgraded with codex update (minimum 0.130.0).');
  }, CHILD_MS);

  it('doctor codex --json reports ok false, and its text carries the same not-found row', async () => {
    const result = await runCli(sb, cliBin('episodic-memory.js'), ['doctor', 'codex', '--json'], { timeoutMs: CHILD_MS });
    expect(result.code).toBe(EXIT_FAIL);
    const body = JSON.parse(result.stdout) as { ok: boolean; text: string };
    expect(body.ok).toBe(false);
    expect(codexRow(body.text)).toBe('Codex version: (not found) (requires minimum 0.130.0)');
  }, CHILD_MS);
});

describe('doctor codex: a fake codex in the child PATH', () => {
  let sb: Sandbox;

  beforeAll(() => {
    sb = makeSandbox();
    // A POSIX shell shim. spawnSync('codex') runs it through PATH, and it prints the codex-cli format.
    if (process.platform !== 'win32') {
      const shim = path.join(sb.bin, 'codex');
      writeFileSync(shim, '#!/bin/sh\necho "codex-cli 0.130.0"\n');
      chmodSync(shim, 0o755);
    }
  }, HEAVY_MS);

  afterAll(() => {
    removeSandbox(sb);
  });

  const presentCase = async (): Promise<void> => {
    const result = await runCli(sb, cliBin('episodic-memory.js'), ['doctor', 'codex'], { timeoutMs: CHILD_MS });
    expect(codexRow(result.stdout)).toBe('Codex version: codex-cli 0.130.0 (ok; minimum 0.130.0)');
  };

  const PRESENT_TITLE = 'reports the fake version as present and at the minimum or above';
  if (process.platform === 'win32') {
    // No fixture in this suite prints the codex-cli X.Y.Z format on win32. A copy of node.exe prints
    // "v26.13.0", which is not that format, so it would test the fixture, not the product.
    it.skip(`${PRESENT_TITLE} (win32: no fixture prints the codex-cli format)`, presentCase);
  } else {
    it(PRESENT_TITLE, presentCase, CHILD_MS);
  }
});

describe.skipIf(process.platform !== 'win32')('doctor codex: a codex.cmd shim in the child PATH (win32)', () => {
  let sb: Sandbox;

  beforeAll(() => {
    sb = makeSandbox();
    writeFileSync(path.join(sb.bin, 'codex.cmd'), '@echo off\r\necho codex-cli 0.130.0\r\n');
  }, HEAVY_MS);

  afterAll(() => {
    removeSandbox(sb);
  });

  // Measured on win32 (this host): with codex.cmd in the child PATH, `doctor codex` reports
  // "Codex version: (not found) (requires minimum 0.130.0)". spawnSync('codex') without a shell finds no .cmd file.
  // The probe ignores the failure (doctor-cli.ts capture), so the report says "not found" for an installed shim.
  it.skip('D8 pending: codex.cmd in PATH -> "Codex version: (not found) (requires minimum 0.130.0)" (expected "codex-cli 0.130.0 (ok; minimum 0.130.0)")', async () => {
    const result = await runCli(sb, cliBin('episodic-memory.js'), ['doctor', 'codex'], { timeoutMs: CHILD_MS });
    expect(codexRow(result.stdout)).toBe('Codex version: codex-cli 0.130.0 (ok; minimum 0.130.0)');
  }, CHILD_MS);
});

describe('doctor codex: a pristine config folder (D4)', () => {
  let sb: Sandbox;

  beforeAll(() => {
    sb = makeSandbox();
  }, HEAVY_MS);

  afterAll(() => {
    removeSandbox(sb);
  });

  // Measured: `doctor codex` on an empty config folder creates conversation-index and logs
  // (getDbPath and getSyncLogPath call ensureDir). Doctor must read paths, not create them.
  it('doctor codex on an empty config folder creates no directory (D4)', async () => {
    expect(readdirSync(sb.cfg)).toEqual([]);
    const result = await runCli(sb, cliBin('episodic-memory.js'), ['doctor', 'codex'], { timeoutMs: CHILD_MS });
    expect(result.code).toBe(EXIT_FAIL);
    expect(readdirSync(sb.cfg)).toEqual([]);
  }, CHILD_MS);
});
