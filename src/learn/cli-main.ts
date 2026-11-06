/**
 * The `learn` subcommands. Reached only from `src/learn-cli.ts`, which owns the
 * early exits (guard, flag, GPU reservation, priority) so this module can load
 * the heavy stack without slowing those down.
 *
 * Every command that changes knowledge or spends money runs under `.learn.lock`,
 * and every command that spends money computes its baseline first and refuses to
 * start when the baseline alone exceeds `EPISODIC_MEMORY_LEARN_MAX_CALLS`
 * (spec §7 rule 10a). A run that cannot afford its own measurement has nothing
 * useful to say when it fails halfway.
 *
 * Progress goes to stderr and the report to stdout: `learn report > file` must
 * produce a file a human can read, and progress lines must never land in it.
 */

import type Database from 'better-sqlite3';
import { LearnLockHeld, withLearnLock, type PidRegistry } from './learn-lock.js';
import { learnConfig, learnEnabled, LEARN_OFF_MESSAGE } from './learn-config.js';
import { generateTasks, checkTasks } from './tasks.js';
import {
  SIGNAL_KINDS,
  SIGNAL_TIERS,
  createRun,
  finishRun,
  getRun,
  latestRun,
  listTasks,
  passRate,
} from './learning-db.js';
import { createSnapshot } from './knowledge-db.js';
import { latestRunId, buildReport, formatReport } from './report.js';
import { CallBudget, solveMany, type SolveOptions } from './solver.js';
import type { LearnDbs } from './types.js';

/** Exit code for a subcommand a later task fills in. Distinct from a failure. */
export const NOT_IMPLEMENTED_EXIT = 3;

export interface LearnCliDeps {
  /** Open handles. When absent the CLI opens all three and closes them. */
  dbs?: LearnDbs;
  runAgent?: SolveOptions['runAgent'];
  model?: string;
  judge?: (prompt: string) => Promise<string>;
  /** Text model for task generation. Defaults to `callLearnModel`. */
  generateModel?: (prompt: string) => Promise<string>;
  now?: () => Date;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
}

export const LEARN_USAGE = `Usage: episodic-memory learn <command> [options]

Self-improving memory over the conversation archive. Every command needs
EPISODIC_MEMORY_LEARN=1; without it each exits 0 and does nothing.

COMMANDS:
  learn tasks [--per-project N] [--seed S] [--check]
      Generate self-practice tasks from the archive. --check marks the tasks
      whose source address no longer resolves as stale.

  learn solve [--split train|test] [--limit N] [--snapshot ID]
      Solve stored tasks and record graded attempts. Default split: train.

  learn status
      The flag, entries by kind and status, candidates awaiting approval, and
      the latest run.

  learn report [--run ID] [--json]
      Pass rates before and after, kept and pending entries, rejections with
      reasons, budget, child runs and reflections. Default: the latest run.

  learn bootstrap | improve | approve | export | render
      Not implemented yet.

Progress goes to stderr; the report goes to stdout.`;

const STUB_COMMANDS = new Set(['bootstrap', 'improve', 'approve', 'export', 'render']);
const IMPLEMENTED = new Set(['tasks', 'solve', 'status', 'report']);

/** `--name value`, `--name=value`, or undefined when absent. A bare `--name` yields ''. */
function optionValue(argv: string[], name: string): string | undefined {
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === `--${name}`) {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) return '';
      return next;
    }
    if (arg.startsWith(`--${name}=`)) return arg.slice(name.length + 3);
  }
  return undefined;
}

function optionNumber(argv: string[], name: string): number | undefined {
  const raw = optionValue(argv, name);
  if (raw === undefined || raw === '') return undefined;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function hasFlag(argv: string[], name: string): boolean {
  return argv.includes(`--${name}`);
}

/** Open the three handles a command needs. Closed, store first, in `finally`. */
async function openDbs(): Promise<LearnDbs> {
  const { openKnowledgeStore } = await import('./knowledge-store.js');
  const { openLearningDb } = await import('./learning-store.js');
  const { initDatabase } = await import('../db.js');
  return { store: openKnowledgeStore(), learning: openLearningDb(), index: initDatabase() };
}

function closeDbs(dbs: LearnDbs): void {
  // The store first: its context holds the whole in-memory graph.
  try {
    dbs.store.close();
  } catch {
    // best effort
  }
  for (const db of [dbs.learning, dbs.index]) {
    try {
      db.close();
    } catch {
      // best effort
    }
  }
}

/**
 * The subprocess count a baseline needs: the signal tasks of the train split.
 *
 * `solve` spends one call per task; bootstrap solves the same set twice (empty
 * snapshot, then candidates), which is why its multiplier is 2.
 */
export function baselineCallCount(db: Database.Database, times = 1): number {
  return listTasks(db, { split: 'train', kinds: SIGNAL_KINDS, tiers: SIGNAL_TIERS }).length * times;
}

/** A refusal message when the baseline cannot be afforded, or null. */
export function baselineRefusal(count: number, maxCalls: number): string | null {
  if (count <= maxCalls) return null;
  return (
    `baseline needs ${count} subprocess calls, above EPISODIC_MEMORY_LEARN_MAX_CALLS=${maxCalls}; ` +
    'refusing to start a run that cannot afford its own measurement'
  );
}

/** Run `fn` under the learn lock, turning a held lock into exit code 1. */
async function underLock(
  deps: LearnCliDeps,
  fn: (pids: PidRegistry) => Promise<number>
): Promise<number> {
  try {
    return await withLearnLock(fn);
  } catch (error) {
    if (error instanceof LearnLockHeld) {
      deps.stderr(`episodic-memory learn: ${error.message}\n`);
      return 1;
    }
    throw error;
  }
}

async function commandTasks(dbs: LearnDbs, argv: string[], deps: LearnCliDeps): Promise<number> {
  const config = learnConfig();
  const seed = optionNumber(argv, 'seed') ?? 1;

  return underLock(deps, async () => {
    if (hasFlag(argv, 'check')) {
      const { stale } = checkTasks(dbs.learning, dbs.index);
      deps.stderr(`episodic-memory learn: ${stale.length} stale task(s) marked\n`);
      return 0;
    }

    const runId = createRun(dbs.learning, {
      phase: 'improve',
      seed,
      budget: { maxCalls: config.maxCalls, maxUsd: config.maxUsd },
    });
    try {
      const result = await generateTasks(dbs.learning, dbs.index, {
        runId,
        seed,
        perProject: optionNumber(argv, 'per-project'),
        maxTasks: config.maxTasks,
        model: deps.generateModel,
      });
      deps.stderr(`episodic-memory learn: ${result.created} task(s) generated in run ${runId}\n`);
      finishRun(dbs.learning, runId, 'done', { created: result.created, byKindTier: result.byKindTier });
      return 0;
    } catch (error) {
      finishRun(dbs.learning, runId, 'failed', {});
      throw error;
    }
  });
}

async function commandSolve(dbs: LearnDbs, argv: string[], deps: LearnCliDeps): Promise<number> {
  const config = learnConfig();
  const split = optionValue(argv, 'split') === 'test' ? 'test' : 'train';
  const explicitSnapshot = optionNumber(argv, 'snapshot');

  return underLock(deps, async pids => {
    const refusal = baselineRefusal(baselineCallCount(dbs.learning), config.maxCalls);
    if (refusal) {
      deps.stderr(`episodic-memory learn: ${refusal}\n`);
      return 1;
    }

    const tasks = listTasks(dbs.learning, { split });
    const limit = optionNumber(argv, 'limit');
    const toSolve = limit === undefined ? tasks : tasks.slice(0, limit);
    if (toSolve.length === 0) {
      deps.stderr(`episodic-memory learn: no ${split} tasks to solve; run learn tasks first\n`);
      return 0;
    }

    const runId = createRun(dbs.learning, {
      phase: 'improve',
      seed: 1,
      budget: { maxCalls: config.maxCalls, maxUsd: config.maxUsd, split },
    });
    const snapshotId = explicitSnapshot ?? (await createSnapshot(dbs.learning, runId, undefined, dbs.store));

    deps.stderr(
      `episodic-memory learn: solving ${toSolve.length} ${split} task(s) in run ${runId} ` +
        `(snapshot ${snapshotId})\n`
    );

    try {
      const attempts = await solveMany(dbs, toSolve, {
        snapshotId,
        runId,
        role: 'solve',
        model: deps.model ?? config.model,
        pids,
        runAgent: deps.runAgent,
        judge: deps.judge,
        budget: new CallBudget(config.maxCalls),
      });

      const passed = attempts.filter(attempt => attempt.passed).length;
      const graded = attempts.filter(attempt => attempt.outcome === 'graded').length;
      deps.stderr(
        `episodic-memory learn: solved ${attempts.length} task(s), ${graded} graded, ${passed} passed\n`
      );
      finishRun(dbs.learning, runId, 'done', {
        solved: attempts.length,
        graded,
        passed,
        rate: passRate(dbs.learning, runId, snapshotId, { split, signalOnly: true }),
      });
      return 0;
    } catch (error) {
      finishRun(dbs.learning, runId, 'failed', {});
      throw error;
    }
  });
}

function compareForStatus(
  a: { project: string; slug: string },
  b: { project: string; slug: string }
): number {
  const aGlobal = a.project === '*' ? 1 : 0;
  const bGlobal = b.project === '*' ? 1 : 0;
  if (aGlobal !== bGlobal) return aGlobal - bGlobal;
  if (a.project !== b.project) return a.project < b.project ? -1 : 1;
  return a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0;
}

async function commandStatus(dbs: LearnDbs, deps: LearnCliDeps): Promise<number> {
  const entries = await dbs.store.listByStatus(['candidate', 'active', 'retired']);
  const lines: string[] = [`EPISODIC_MEMORY_LEARN=${learnEnabled() ? 'on' : 'off'}`];

  const counts = new Map<string, number>();
  for (const entry of entries) {
    const key = `${entry.kind}:${entry.status}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }

  lines.push('');
  lines.push(`entries (${entries.length}):`);
  if (entries.length === 0) lines.push('  none');
  for (const key of [...counts.keys()].sort()) lines.push(`  ${key}: ${counts.get(key)}`);

  const candidates = entries.filter(entry => entry.status === 'candidate').sort(compareForStatus);
  lines.push('');
  lines.push(`candidates awaiting approval (${candidates.length}):`);
  for (const entry of candidates) {
    lines.push(`  ${entry.kind} ${entry.project}/${entry.slug} v${entry.version}`);
  }
  if (candidates.length === 0) lines.push('  none');

  const run = latestRun(dbs.learning);
  lines.push('');
  if (!run) {
    lines.push('latest run: none');
  } else {
    lines.push(`latest run: ${run.id}`);
    lines.push(`  phase ${run.phase} · status ${run.status}${run.project ? ` · project ${run.project}` : ''}`);
    lines.push(`  metrics ${JSON.stringify(run.metrics)}`);
  }

  deps.stdout(lines.join('\n') + '\n');
  return 0;
}

async function commandReport(dbs: LearnDbs, argv: string[], deps: LearnCliDeps): Promise<number> {
  const runId = optionValue(argv, 'run') || latestRunId(dbs.learning);
  if (!runId) {
    deps.stderr('episodic-memory learn: no learning run recorded yet; run learn tasks or learn solve first\n');
    return 1;
  }
  if (!getRun(dbs.learning, runId)) {
    deps.stderr(`episodic-memory learn: no such run: ${runId}\n`);
    return 1;
  }
  deps.stdout(formatReport(await buildReport(dbs, runId), hasFlag(argv, 'json')));
  return 0;
}

/**
 * Parse and run one `learn` subcommand.
 *
 * The returned number is the process exit code. `deps.dbs` is a test seam: a
 * real invocation opens and always closes its own handles.
 */
export async function runLearnCli(argv: string[], deps: LearnCliDeps): Promise<number> {
  const command = argv[0];

  if (command === undefined || command === '--help' || command === '-h') {
    deps.stdout(LEARN_USAGE + '\n');
    return 0;
  }

  // Flag off wins over everything: spec §7 rule 1 says every `learn` subcommand
  // exits 0 with this message, including the ones a later task fills in.
  if (!learnEnabled()) {
    deps.stderr(`${LEARN_OFF_MESSAGE}\n`);
    return 0;
  }

  if (STUB_COMMANDS.has(command)) {
    deps.stderr(
      `episodic-memory learn: '${command}' is not implemented yet; ` +
        'it lands with a later task and nothing was changed.\n'
    );
    return NOT_IMPLEMENTED_EXIT;
  }

  if (!IMPLEMENTED.has(command)) {
    deps.stderr(`episodic-memory learn: unknown command '${command}'\n\n${LEARN_USAGE}\n`);
    return 2;
  }

  let owned: LearnDbs | null = null;
  try {
    const dbs = deps.dbs ?? (owned = await openDbs());
    switch (command) {
      case 'tasks':
        return await commandTasks(dbs, argv.slice(1), deps);
      case 'solve':
        return await commandSolve(dbs, argv.slice(1), deps);
      case 'status':
        return await commandStatus(dbs, deps);
      default:
        return await commandReport(dbs, argv.slice(1), deps);
    }
  } finally {
    if (owned) closeDbs(owned);
  }
}
