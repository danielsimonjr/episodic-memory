/**
 * The solver: answer one task with the knowledge a snapshot held.
 *
 * `solveTask` is the unit both the evaluation harness and the learner loops use.
 * Its three jobs, in order:
 *
 * 1. Build the in-process `episodic-learn` server with the task's source
 *    exchange ids hidden, so neither a search result nor a digest line can hand
 *    the solver the address it is being asked to find (spec §4.4 leak rule).
 * 2. Run the agent under the one global subprocess semaphore, inside the caller's
 *    call budget, and grade the answer with Task 4's graders.
 * 3. Store the attempt — always, including the failures: an `aborted`, `killed`
 *    or `error` attempt is evidence that the run was cut short, and the learner
 *    excludes those from diagnosis rather than scoring them as solver failures.
 *
 * The system prompt is built from the snapshot, not from the store's live view:
 * a snapshot is `K^(t)`, and a solver that saw an entry added between snapshots
 * would make the before/after comparison meaningless.
 */

import { gradeLocate, gradeMulti, gradeRecall, gradeWhen, parseSolverAnswer } from './grade.js';
import { getEntry, getSnapshot } from './knowledge-db.js';
import { insertAttempt, type LearningTask } from './learning-db.js';
import { globalAgentSemaphore } from './semaphore.js';
import type {
  AttemptOutcome,
  AttemptRow,
  Cost,
  KnowledgeEntry,
  LearnDbs,
  TraceStep,
} from './types.js';
import { buildLearnToolServer } from './sdk-tools.js';
import { runAgent, type PidRegistry } from './agent-runner.js';
import { solverSystemPrompt } from './prompts.js';

/**
 * Where a run records the PIDs it owns.
 *
 * Task 6 supplies the real implementation, which also writes `.learn.pids` so the
 * SessionStart orphan reaper leaves a live run's subprocesses alone. Declared
 * here because the solver is the first consumer.
 */
export type { PidRegistry };

/** The call budget is spent: the run stops and keeps everything validated so far. */
export class BudgetExhausted extends Error {
  constructor(public readonly max: number) {
    super(`Call budget exhausted after ${max} subprocess calls.`);
    this.name = 'BudgetExhausted';
  }
}

/**
 * A shared counter of subprocess calls across a whole run.
 *
 * Not a semaphore: this bounds total spend, while the semaphore bounds
 * concurrency. A run needs both — one task at a time still costs a call each.
 */
export class CallBudget {
  used = 0;

  constructor(public readonly max: number) {}

  /** Take one call, or throw when the cap is already reached. */
  spend(): void {
    if (this.used >= this.max) throw new BudgetExhausted(this.max);
    this.used += 1;
  }

  remaining(): number {
    return Math.max(0, this.max - this.used);
  }
}

/** What `solveTask` needs beyond the task itself. */
export interface SolveOptions {
  snapshotId: number;
  runId: string;
  role: 'solve' | 'validate' | 'merge-check';
  /** Model for the solver subprocess. */
  model: string;
  pids: PidRegistry;
  /** Test seam: defaults to `runAgent`. */
  runAgent?: typeof runAgent;
  /** Judge for `recall`. Defaults to `callLearnModel`. */
  judge?: (prompt: string) => Promise<string>;
  maxTurns?: number;
  maxBudgetUsd?: number;
  timeoutMs?: number;
  /** A budget to spend one call from, when the caller keeps one. */
  budget?: CallBudget;
}

/** The instruction entries and skills index a snapshot renders into a prompt. */
export async function promptInputsForSnapshot(
  dbs: LearnDbs,
  snapshotId: number
): Promise<{ instructions: KnowledgeEntry[]; skillsIndex: string }> {
  const names = getSnapshot(dbs.learning, snapshotId);
  const entries: KnowledgeEntry[] = [];

  for (const name of names) {
    // A snapshot is a set of names; an entry retired since then is still what
    // the solver of that snapshot should see, so only a missing row is dropped.
    const entry = await getEntry(dbs.store, name);
    if (entry && (entry.kind === 'instruction' || entry.kind === 'skill')) entries.push(entry);
  }

  // Project rows before `*` rows, matching the rendered block's order.
  entries.sort((a, b) => {
    const aGlobal = a.project === '*' ? 1 : 0;
    const bGlobal = b.project === '*' ? 1 : 0;
    if (aGlobal !== bGlobal) return aGlobal - bGlobal;
    return a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0;
  });

  const instructions = entries.filter(entry => entry.kind === 'instruction');
  const skillsIndex = entries
    .filter(entry => entry.kind === 'skill')
    .map(entry => `${entry.slug}: ${entry.description} (${entry.confidence}, v${entry.version})`)
    .join('\n');

  return { instructions, skillsIndex };
}

/** The default judge: the text-only learn model. */
async function defaultJudge(prompt: string): Promise<string> {
  const { callLearnModel } = await import('../summarizer.js');
  return callLearnModel(prompt);
}

/** Grade one answer, or record that it could not be graded. */
async function grade(
  task: LearningTask,
  answer: string,
  judge: (prompt: string) => Promise<string>
): Promise<{ passed: boolean; score: number }> {
  const parsed = parseSolverAnswer(answer);
  switch (task.kind) {
    case 'locate':
      return gradeLocate(task.truth, parsed);
    case 'when':
      return gradeWhen(task.truth, parsed);
    case 'multi':
      return gradeMulti(task.truth, parsed);
    case 'recall':
      return gradeRecall(task.truth, parsed, judge);
    default:
      return { passed: false, score: 0 };
  }
}

/**
 * Answer and grade one task.
 *
 * The server hides exactly `task.truth.exchanges` — the sources this task was
 * built from — and nothing else: the solver is meant to search the rest of the
 * archive, which is what makes finding the right file the task.
 */
export async function solveTask(
  dbs: LearnDbs,
  task: LearningTask,
  options: SolveOptions
): Promise<AttemptRow> {
  const runAgentFn = options.runAgent ?? runAgent;
  const judge = options.judge ?? defaultJudge;
  const hideExchangeIds = task.truth.exchanges.map(exchange => exchange.id);
  const semaphore = globalAgentSemaphore();

  const { instructions, skillsIndex } = await promptInputsForSnapshot(dbs, options.snapshotId);
  const systemPrompt = solverSystemPrompt(instructions, skillsIndex);

  const server = buildLearnToolServer({
    project: task.project,
    hideExchangeIds,
    allowPropose: false,
  });

  let text = '';
  let trace: TraceStep[] = [];
  let cost: Cost = { turns: 0, inputTokens: 0, outputTokens: 0, usd: null };
  let outcome: AttemptOutcome = 'error';

  try {
    options.budget?.spend();
    const result = await semaphore.run(() =>
      runAgentFn({
        prompt: task.prompt,
        systemPrompt,
        server,
        allowPropose: false,
        maxTurns: options.maxTurns ?? 12,
        maxBudgetUsd: options.maxBudgetUsd ?? 1,
        timeoutMs: options.timeoutMs ?? 300_000,
        model: options.model,
        pids: options.pids,
      })
    );
    text = result.text;
    trace = result.trace;
    cost = result.cost;
    outcome = result.outcome;
  } catch (error) {
    if (error instanceof BudgetExhausted) throw error;
    outcome = 'error';
    text = `Solver failed: ${error instanceof Error ? error.message : String(error)}`;
  }

  let passed = false;
  let score = 0;
  if (outcome === 'graded') {
    try {
      const graded = await grade(task, text, judge);
      passed = graded.passed;
      score = graded.score;
    } catch (error) {
      // A judge failure is a solver failure for this attempt, not a crash of
      // the run: the attempt is stored, ungraded in effect.
      passed = false;
      score = 0;
      text = `${text}\n\nGrading failed: ${error instanceof Error ? error.message : String(error)}`;
    }
  }

  const attempt: Omit<AttemptRow, 'id' | 'createdAt'> = {
    taskId: task.id,
    runId: options.runId,
    snapshotId: options.snapshotId,
    role: options.role,
    passed,
    score,
    answer: text,
    trace,
    cost,
    outcome,
  };

  const id = insertAttempt(dbs.learning, attempt);
  return {
    ...attempt,
    id,
    createdAt: new Date().toISOString(),
  };
}

export interface SolveManyOptions extends Omit<SolveOptions, 'snapshotId'> {
  snapshotId: number;
  /** The run's shared call budget. A batch stops with `BudgetExhausted` at the cap. */
  budget: CallBudget;
  /** Test seam: defaults to `solveTask`, so a leaf learner can be driven by a fake. */
  solve?: typeof solveTask;
}

/**
 * Solve a batch of tasks.
 *
 * Every task goes through the single global semaphore, so the batch's own
 * parallelism is bounded by `learnConfig().concurrency` no matter how many tasks
 * the caller hands over. The budget is shared, so a batch stops with
 * `BudgetExhausted` at the cap and the caller keeps the attempts already stored.
 */
export async function solveMany(
  dbs: LearnDbs,
  tasks: LearningTask[],
  options: SolveManyOptions
): Promise<AttemptRow[]> {
  const semaphore = globalAgentSemaphore();
  const solveFn = options.solve ?? solveTask;

  // One promise per task, each of which yields its semaphore slot between the
  // agent call and the database insert. A worker pool would be equivalent; the
  // global semaphore is what actually bounds subprocesses.
  const settled = await Promise.allSettled(
    tasks.map(task =>
      semaphore.run(async () => solveFn(dbs, task, { ...options, budget: options.budget }))
    )
  );

  const attempts: AttemptRow[] = [];
  let budgetError: BudgetExhausted | null = null;
  let firstError: unknown = null;
  for (const result of settled) {
    if (result.status === 'fulfilled') {
      attempts.push(result.value);
      continue;
    }
    const reason = result.reason;
    if (reason instanceof BudgetExhausted) budgetError = budgetError ?? reason;
    else firstError = firstError ?? reason;
  }

  if (budgetError) throw budgetError;
  if (firstError) throw firstError;
  return attempts;
}
