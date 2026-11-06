/**
 * The leaf learner: diagnose a subset's failures, propose edits, validate them.
 *
 * Spec §6.2 step 4. One leaf owns one subset of the `train` signal tasks and
 * runs up to `rounds` of the same four moves:
 *
 * 1. **Solve** the subset with the current snapshot (`K^(t)`) and keep the
 *    `graded` failures. An `aborted`, `killed` or `error` attempt is evidence
 *    the run was cut short, not evidence the solver failed, so it never enters
 *    diagnosis or a validation set.
 * 2. **Suspect.** A task two solvers fail while each commits to a different
 *    address is task noise, not a retrieval failure; it is marked `suspect` and
 *    excluded from every validation set (the paper's §6.1 criterion revision in
 *    programmatic form).
 * 3. **Diagnose and edit** with one learner subprocess that sees the failed
 *    traces by address, the active entries, the failures earlier runs recorded,
 *    and the reflections they wrote — and proposes through `propose_entry`.
 * 4. **Gate and validate.** Every proposal passes `gateEntry`, is stored as a
 *    candidate, and is measured by `validateCandidate`; only a `keep` counts.
 *
 * The loop stops when a round validates candidates and keeps none, when the
 * learner proposes nothing, or at the cap. Nothing here deletes an entry: a
 * dropped edit keeps its row and its validation record.
 */

import { learnConfig } from './learn-config.js';
import { indexExchangeResolver } from './bootstrap.js';
import { gateEntry } from './knowledge-gate.js';
import type { IdCitationResolver } from './cited-ids.js';
import {
  DuplicateEntry,
  createSnapshot,
  insertKnowledgeEntry,
  listActive,
} from './knowledge-db.js';
import {
  SIGNAL_KINDS,
  SIGNAL_TIERS,
  addRejection,
  attemptsExist,
  listAttempts,
  listTasks,
  type LearningTask,
} from './learning-db.js';
import { diagnosePrompt } from './prompts.js';
import { buildLearnToolServer } from './sdk-tools.js';
import { globalAgentSemaphore } from './semaphore.js';
import { runAgent } from './agent-runner.js';
import { BudgetExhausted, CallBudget, solveMany, solveTask, type PidRegistry } from './solver.js';
import { parseSolverAnswer, samePath } from './grade.js';
import { validateCandidate } from './validate.js';
import type {
  AttemptRow,
  KnowledgeEntry,
  LearnDbs,
  ProposedEntry,
  TraceStep,
} from './types.js';

/** The score a stored procedure must reach to be offered to the learner. */
export const PROCEDURE_MATCH_THRESHOLD = 0.3;

/** The skill every learner is offered regardless of the match score. */
export const NAVIGATION_SLUG = 'navigation';

/** What one leaf learner produced. */
export interface LeafResult {
  /** Entry names the run kept (and, for a skill, activated). */
  kept: string[];
  /** Proposals that never reached validation, with the gate's reason. */
  rejected: Array<{ slug: string; reason: string }>;
  /** Task ids excluded from validation as task noise. */
  suspect: number[];
  /** Per-round solve results, `passed` of `total` graded attempts. */
  rounds: Array<{ passed: number; total: number }>;
  /** The call budget ran out. Entries already in `kept` stay kept. */
  stopped: boolean;
}

/**
 * The options for `runLeafLearner`, which runs one leaf learner over a subset of tasks.
 */
export interface LeafLearnerOptions {
  runId: string;
  project: string;
  /** The subset's task ids. Read through `listTasks`, so `test` rows never appear. */
  taskIds: number[];
  rounds: number;
  editsPerRound: number;
  /** Test seam: defaults to `runAgent`. */
  runAgent?: typeof runAgent;
  /** Test seam: defaults to `solveTask`. */
  solve?: Parameters<typeof validateCandidate>[2]['solve'];
  model?: string;
  budget: CallBudget;
  pids?: PidRegistry;
  judge?: (prompt: string) => Promise<string>;
}

const NO_PIDS: PidRegistry = { add() {}, remove() {} };

/** Every active, not-superseded entry name, sorted. */
async function activeNames(dbs: LearnDbs): Promise<string[]> {
  const entries = await dbs.store.listByStatus(['active']);
  return entries
    .filter(entry => entry.supersededBy === null)
    .map(entry => entry.id)
    .sort();
}

/** The subset's tasks, through the only read path, signal kinds and tiers only. */
function subsetTasks(dbs: LearnDbs, taskIds: number[]): LearningTask[] {
  if (taskIds.length === 0) return [];
  return listTasks(dbs.learning, {
    split: 'train',
    ids: taskIds,
    kinds: SIGNAL_KINDS,
    tiers: SIGNAL_TIERS,
  });
}

/**
 * Tasks whose solvers disagreed about where the answer lives.
 *
 * Two failed `graded` attempts from this round, each committing to one address,
 * with different addresses: the task's truth is unreliable for this round, so
 * it cannot be part of a validation set. A passing attempt is evidence the
 * ground is reliable. One attempt that names two paths is one solver hedging,
 * not two solvers disagreeing. Two attempts naming the same file stay in.
 */
export function suspectTaskIds(attempts: AttemptRow[]): number[] {
  const pathsByTask = new Map<number, Set<string>>();
  const failedLocated = new Map<number, number>();
  for (const attempt of attempts) {
    if (attempt.outcome !== 'graded' || attempt.passed) continue;
    const parsed = parseSolverAnswer(attempt.answer);
    const located = parsed.locations.map(location => location.path).filter(Boolean);
    // One answer is one solver. Extra paths in the same answer are a hedge.
    const path = located[0];
    if (!path) continue;
    const set = pathsByTask.get(attempt.taskId) ?? new Set<string>();
    set.add(path.toLowerCase());
    pathsByTask.set(attempt.taskId, set);
    failedLocated.set(attempt.taskId, (failedLocated.get(attempt.taskId) ?? 0) + 1);
  }
  const suspect: number[] = [];
  for (const [taskId, paths] of pathsByTask) {
    if ((failedLocated.get(taskId) ?? 0) >= 2 && paths.size >= 2) suspect.push(taskId);
  }
  return suspect.sort((a, b) => a - b);
}

/** A one-line description of how a failed attempt missed. */
function failureMode(task: LearningTask, attempt: AttemptRow): string {
  const parsed = parseSolverAnswer(attempt.answer);
  if (!parsed.path) return 'no-location';
  const hit = task.truth.exchanges.some(ref => samePath(ref.path, parsed.path!));
  return hit ? 'wrong-lines-or-date' : 'wrong-target';
}

/** What the round attempted, for the failure record. */
function attemptedText(attempt: AttemptRow): string {
  return attempt.answer.replace(/\s+/g, ' ').trim().slice(0, 200);
}

/** The trace reduced to addresses, which is all a diagnosis needs. */
function addressTrace(trace: TraceStep[]): TraceStep[] {
  return trace.map(step => ({
    tool: step.tool,
    args: step.args,
    resultAddress: step.resultAddress,
    resultChars: step.resultChars,
  }));
}

/**
 * The skills a learner should see: every navigation skill plus the procedures
 * that match the subset's prompts above the threshold.
 */
async function skillsForPrompt(
  dbs: LearnDbs,
  project: string,
  prompts: string[]
): Promise<KnowledgeEntry[]> {
  const skills = await listActive(dbs.store, ['skill'], project);
  const procedural = skills.filter(skill => Boolean(skill.procedureId));
  if (procedural.length === 0) return skills.filter(skill => skill.slug === NAVIGATION_SLUG);

  const context = prompts.join('\n').slice(0, 2000);
  const matched = await dbs.store.matchProcedures(
    context,
    procedural.map(skill => skill.procedureId!)
  );
  const above = new Set(
    matched
      .filter(match => match.score >= PROCEDURE_MATCH_THRESHOLD)
      .map(match => match.procedure.id)
  );
  return skills.filter(
    skill => skill.slug === NAVIGATION_SLUG || (skill.procedureId && above.has(skill.procedureId))
  );
}

/** Gate one proposal and store it as a candidate; returns the entry name. */
async function storeProposal(
  dbs: LearnDbs,
  proposal: ProposedEntry,
  runId: string,
  reject: (slug: string, reason: string) => void
): Promise<string | null> {
  const resolve: IdCitationResolver = {
    exchange: indexExchangeResolver(dbs.index),
    attempt: (id: number) => attemptsExist(dbs.learning, [id]),
  };
  const gated = gateEntry(proposal, {
    resolve,
    redactPii: (text: string) => dbs.store.redactPii(text),
    config: learnConfig(),
    runId,
  });
  if ('rejected' in gated) {
    reject(proposal.slug, gated.rejected);
    return null;
  }
  try {
    return await insertKnowledgeEntry(dbs.store, gated.entry);
  } catch (error) {
    if (error instanceof DuplicateEntry) {
      reject(proposal.slug, 'duplicate');
      return null;
    }
    reject(proposal.slug, error instanceof Error ? error.message : String(error));
    return null;
  }
}

/**
 * Run one leaf learner over a subset of the train signal tasks.
 *
 * Everything a model or a subprocess would touch is injected, so a test drives
 * the whole loop with fakes and never reaches a model, a GPU or a subprocess.
 */
export async function runLeafLearner(
  dbs: LearnDbs,
  options: LeafLearnerOptions
): Promise<LeafResult> {
  const config = learnConfig();
  const model = options.model ?? config.model;
  const runAgentFn = options.runAgent ?? runAgent;
  const pids = options.pids ?? NO_PIDS;

  const result: LeafResult = { kept: [], rejected: [], suspect: [], rounds: [], stopped: false };
  const reject = (slug: string, reason: string): void => {
    result.rejected.push({ slug, reason });
    addRejection(dbs.learning, options.runId, { slug, reason });
  };

  const tasks = subsetTasks(dbs, options.taskIds);
  if (tasks.length === 0) return result;

  for (let round = 0; round < options.rounds; round += 1) {
    // 1. Solve the subset with the snapshot as it stands now.
    const snapshotId = await createSnapshot(
      dbs.learning,
      options.runId,
      await activeNames(dbs),
      dbs.store
    );

    let attempts: AttemptRow[];
    try {
      attempts = await solveMany(dbs, tasks, {
        snapshotId,
        runId: options.runId,
        role: 'solve',
        model,
        pids,
        runAgent: options.runAgent,
        judge: options.judge,
        budget: options.budget,
        solve: options.solve,
      });
    } catch (error) {
      if (error instanceof BudgetExhausted) {
        result.stopped = true;
        result.rounds.push({ passed: 0, total: 0 });
        break;
      }
      throw error;
    }

    const graded = attempts.filter(attempt => attempt.outcome === 'graded');
    const passedAttempts = graded.filter(attempt => attempt.passed);
    result.rounds.push({ passed: passedAttempts.length, total: graded.length });

    const failures = graded.filter(attempt => !attempt.passed);
    if (failures.length === 0) break;

    // 2. Task noise out of the validation sets. Only this round's solves count:
    //    the snapshot just created is the round. Earlier rounds of the same run
    //    live on earlier snapshots and must not make a task look disputed.
    const roundAttempts = listAttempts(dbs.learning, {
      runId: options.runId,
      taskIds: tasks.map(task => task.id),
      role: 'solve',
    }).filter(attempt => attempt.snapshotId === snapshotId);
    const suspect = new Set(suspectTaskIds(roundAttempts));
    for (const taskId of suspect) {
      if (!result.suspect.includes(taskId)) result.suspect.push(taskId);
    }

    const failedIds = [...new Set(failures.map(attempt => attempt.taskId))].filter(
      taskId => !suspect.has(taskId)
    );
    if (failedIds.length === 0) break;

    // 3. Record the failures, after reading what earlier runs already knew.
    const taskById = new Map(tasks.map(task => [task.id, task]));
    const priorFailures: Array<{ context: string; failure_mode?: string; root_cause?: string }> = [];
    const seenPrior = new Set<string>();
    for (const taskId of failedIds) {
      const task = taskById.get(taskId);
      if (!task) continue;
      const found = await dbs.store.lookupFailures(task.prompt, 5);
      for (const failure of found) {
        if (seenPrior.has(failure.context)) continue;
        seenPrior.add(failure.context);
        priorFailures.push({
          context: failure.context,
          failure_mode: failure.failure_mode,
          root_cause: failure.root_cause,
        });
      }
    }
    for (const attempt of failures) {
      // A suspect task is task noise, not a solver failure worth remembering.
      if (suspect.has(attempt.taskId)) continue;
      const task = taskById.get(attempt.taskId);
      if (!task) continue;
      await dbs.store.recordFailure({
        context: task.prompt,
        attempted: attemptedText(attempt),
        failure_mode: failureMode(task, attempt),
        root_cause: `round ${round + 1} miss on a ${task.kind} task`,
        applicability_hint: task.prompt,
      });
    }

    // 4. Diagnose and edit, with one isolated learner subprocess.
    const proposals: ProposedEntry[] = [];
    const instructions = await listActive(dbs.store, ['instruction'], options.project);
    const reflections = await listActive(dbs.store, ['reflection'], options.project);
    const skills = await skillsForPrompt(
      dbs,
      options.project,
      failedIds.map(taskId => taskById.get(taskId)?.prompt ?? '')
    );
    const projectContext = await dbs.store.forContext(options.project, 2000);

    const server = buildLearnToolServer({
      project: options.project,
      hideExchangeIds: [],
      allowPropose: true,
      onPropose: proposal => proposals.push(proposal),
    });

    const prompt = diagnosePrompt({
      project: options.project,
      failed: failures
        .filter(attempt => !suspect.has(attempt.taskId))
        .map(attempt => {
          const task = taskById.get(attempt.taskId)!;
          return {
            taskId: attempt.taskId,
            kind: task.kind,
            tier: task.tier,
            prompt: task.prompt,
            answer: attempt.answer,
            trace: addressTrace(attempt.trace),
          };
        }),
      active: [...instructions, ...skills],
      priorFailures,
      reflections,
      projectContext,
      maxEdits: options.editsPerRound,
    });
    // The system turn carries the role and the rules alone: the failed traces
    // and the archive's own text stay in the user turn, as data.
    const systemPrompt = diagnosePrompt({
      project: options.project,
      failed: [],
      active: [],
      priorFailures: [],
      reflections: [],
      maxEdits: options.editsPerRound,
    });

    try {
      options.budget.spend();
      await globalAgentSemaphore().run(() =>
        runAgentFn({
          prompt,
          systemPrompt,
          server,
          allowPropose: true,
          maxTurns: config.learnerMaxTurns,
          maxBudgetUsd: 1,
          timeoutMs: 300_000,
          model,
          pids,
        })
      );
    } catch (error) {
      if (error instanceof BudgetExhausted) {
        result.stopped = true;
        break;
      }
      // One learner turn failing is not the run failing: the round simply keeps
      // nothing and the loop ends.
      reject(options.project, `learner failed: ${error instanceof Error ? error.message : String(error)}`);
      break;
    }

    if (proposals.length === 0) break;

    // 5. Gate, store, validate.
    let validated = 0;
    let keptThisRound = 0;
    let budgetStop = false;
    for (const proposal of proposals.slice(0, options.editsPerRound)) {
      const name = await storeProposal(dbs, proposal, options.runId, reject);
      if (!name) continue;

      // A model names the tasks it meant to fix, but the set it may name is the
      // round's own train subset: a proposal cannot drag a held-out or stale task
      // into a validation set.
      const subsetIds = new Set(tasks.map(task => task.id));
      const proposed = (proposal.targets ?? []).filter(taskId => subsetIds.has(taskId));
      let targeted = (proposed.length > 0 ? proposed : failedIds).filter(
        taskId => !suspect.has(taskId)
      );
      // Every named target was task noise. Measure the round's other failures
      // instead of validating an empty set, which would reject the edit without
      // ever solving a task.
      if (targeted.length === 0) {
        targeted = failedIds.filter(taskId => !suspect.has(taskId));
      }
      if (targeted.length === 0) continue;
      validated += 1;
      const sampleFrom = passedAttempts
        .map(attempt => attempt.taskId)
        .filter(taskId => !targeted.includes(taskId) && !suspect.has(taskId));

      let verdict;
      try {
        verdict = await validateCandidate(dbs, name, {
          targeted,
          sampleFrom,
          sampleSize: config.validateSample,
          seed: round + 1,
          solve: options.solve ?? solveTask,
          runId: options.runId,
          budget: options.budget,
          model,
          runAgent: options.runAgent,
          judge: options.judge,
          pids,
        });
      } catch (error) {
        // A validation re-solve spends the same call budget as a solve. Spent
        // means stop, with every keep so far retained (§7 rule 10a).
        if (error instanceof BudgetExhausted) {
          // The candidate was not activated: validateCandidate spends the budget
          // before it keeps. Entries already pushed to `kept` stay there.
          result.stopped = true;
          budgetStop = true;
          break;
        }
        throw error;
      }

      if (verdict.keep) {
        keptThisRound += 1;
        result.kept.push(name);
      }
    }

    // A round that validated something and kept none is the stop condition; a
    // round whose proposals all failed the gate is not, because the next round
    // can still produce a usable proposal from the same failures.
    if (budgetStop) break;
    if (validated > 0 && keptThisRound === 0) break;
  }

  return result;
}
