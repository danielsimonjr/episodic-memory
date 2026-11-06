/**
 * The recursive learner (spec §6.2, Algorithm 1).
 *
 * One `learn improve` run is a loop of rounds. A round is five moves:
 *
 * 1. **Solve.** Every `train` signal task is solved with the snapshot `K^(t)`.
 *    That is both the round's measurement and its failure set.
 * 2. **Split.** A single project whose failures fit `leafMax` gets one leaf
 *    learner. Otherwise the failures are cut by project, and a project still
 *    over `leafMax` is cut again by failure category — one model call whose
 *    answer is validated as a partition of exactly the failed task ids. An
 *    answer that is not a partition is discarded and the cut stays by project.
 *    Every subset becomes a child run with `parent_run_id`.
 * 3. **Learn.** The leaf learners run in parallel, bounded by `concurrency`
 *    (and by the one global subprocess semaphore underneath).
 * 4. **Merge.** The same `(kind, project, slug)` kept by two children is one
 *    entry, not two: one model call writes the merged body, which passes the
 *    same gates as any other proposal. A seeded sample of every child's signal
 *    tasks is then re-solved against the merged snapshot (`merge-check`); a
 *    child whose gains regress gets its own text back and the merged version is
 *    retired. `detectHeuristicConflicts()` names instruction lines that now
 *    contradict each other; one more model call may resolve them, and lines it
 *    cannot resolve are retired with the conflict written into the reflection.
 * 5. **Reflect.** One screened reflection per round, citing the round's attempt
 *    ids and exchange ids.
 *
 * The loop stops when a round keeps nothing, when `rounds` is reached, or when
 * the call budget is spent (`stopped`, with every validated entry kept). Only
 * then is the `test` split solved — once, with the final snapshot. No learner
 * prompt can hold a `test` task: `listTasks` is the only task read path and its
 * `split` predicate is mandatory.
 *
 * Additive only: nothing here deletes an entry, a task or an attempt. A revert
 * retires the merged version and writes the child's body again; the merged row
 * stays readable.
 */

import { learnConfig } from './learn-config.js';
import { indexExchangeResolver } from './bootstrap.js';
import { gateEntry } from './knowledge-gate.js';
import type { IdCitationResolver } from './cited-ids.js';
import {
  DuplicateEntry,
  activate,
  createSnapshot,
  getEntry,
  insertKnowledgeEntry,
  retire,
} from './knowledge-db.js';
import {
  SIGNAL_KINDS,
  SIGNAL_TIERS,
  addRejection,
  attemptsExist,
  createRun,
  finishRun,
  listAttempts,
  listTasks,
  passRate,
  type LearningTask,
  type PassRate,
} from './learning-db.js';
import { mergeEntriesPrompt, reflectPrompt, splitPrompt } from './prompts.js';
import { createSemaphore } from './semaphore.js';
import { runAgent, type PidRegistry } from './agent-runner.js';
import { BudgetExhausted, CallBudget, solveMany, type solveTask } from './solver.js';
import { runLeafLearner } from './leaf-learner.js';
import { sampleIds } from './validate.js';
import { writeLearnedBlocks } from './learned-block.js';
import type { AttemptRow, KnowledgeEntry, LearnDbs, ProposedEntry, SourceRef } from './types.js';

/** The failure categories the split call may assign (spec §6.2 step 3). */
export const FAILURE_CATEGORIES = [
  'wrong project',
  'right session wrong lines',
  'right text wrong date',
  'paraphrase not matched',
  'rejected a correct result',
];

/** The slug prefix of a round's reflection. */
export const REFLECTION_SLUG_PREFIX = 'reflection-round';

/** What one merged entry did, for the report and the reflection. */
export interface MergeRecord {
  /** `kind|project|slug`. */
  key: string;
  /** The name of the merged version. */
  merged: string;
  /** Every cited exchange id the merge unions. */
  sources: string[];
  /** The version restored when the merge regressed a child, or null. */
  revertedTo: string | null;
  /** Task ids that regressed under the merged snapshot. */
  regressions: number[];
}

export interface LearnResult {
  runId: string;
  status: 'done' | 'stopped' | 'failed';
  /** Projects a child run was created for, in first-seen order. */
  projects: string[];
  /** Child run ids, in creation order. */
  children: string[];
  /** Entry names this run kept (and activated, when its kind may). */
  kept: string[];
  rejected: Array<{ slug: string; reason: string }>;
  merges: MergeRecord[];
  /** Names of the reflections the run wrote. */
  reflections: string[];
  /** The signal train rate before the first round and after the last. */
  before: PassRate;
  after: PassRate;
  test: PassRate;
  rounds: number;
}

export interface LearnOptions {
  /** Test seam: defaults to `runAgent`. */
  runAgent?: typeof runAgent;
  model?: string;
  judge?: (prompt: string) => Promise<string>;
  /** Test seam: defaults to `solveTask`. */
  solve?: typeof solveTask;
  concurrency: number;
  rounds: number;
  leafMax: number;
  project?: string;
  dryRun?: boolean;
  budget: CallBudget;
  /** Test seam: the text-only model for split, merge and reflect. */
  textModel?: (prompt: string) => Promise<string>;
  pids?: PidRegistry;
  seed?: number;
}

const NO_PIDS: PidRegistry = { add() {}, remove() {} };

function emptyRate(): PassRate {
  return { passed: 0, total: 0, meanTurns: 0, usd: 0, byKindTier: {} };
}

function defaultTextModel(prompt: string): Promise<string> {
  return import('../summarizer.js').then(({ callLearnModel }) => callLearnModel(prompt));
}

/** Every active, not-superseded entry name, sorted. */
async function activeNames(dbs: LearnDbs): Promise<string[]> {
  const entries = await dbs.store.listByStatus(['active']);
  return entries
    .filter(entry => entry.supersededBy === null)
    .map(entry => entry.id)
    .sort();
}

/** The train signal tasks — the only set a learner ever sees. */
function signalTrainTasks(dbs: LearnDbs, project?: string): LearningTask[] {
  return listTasks(dbs.learning, {
    split: 'train',
    kinds: SIGNAL_KINDS,
    tiers: SIGNAL_TIERS,
    ...(project === undefined ? {} : { project }),
  });
}

/** One subset of failures that becomes a leaf learner. */
export interface LearnSubset {
  project: string;
  taskIds: number[];
  category?: string;
}

/** A failed task, reduced to what the split decision needs. */
interface Failure {
  taskId: number;
  project: string;
  answer: string;
  kind: LearningTask['kind'];
}

function parseLines(raw: string): string[] {
  return String(raw ?? '')
    .split('\n')
    .map(line => line.replace(/^\s*(?:[-*\u2022]|\d+[.)])\s+/, '').trim())
    .filter(line => line.length > 0);
}

/**
 * The category each failed task was assigned, or null when the answer is not a
 * partition.
 *
 * A partition means every failed id appears exactly once and no id the run did
 * not fail on appears at all. A duplicate assignment is not a partition either:
 * a task in two subsets would be solved and edited twice.
 */
export function parseAssignment(raw: string, failedIds: number[]): Map<number, string> | null {
  const wanted = new Set(failedIds);
  const assigned = new Map<number, string>();
  for (const line of parseLines(raw)) {
    const match = /^(.+?):\s*(.*)$/.exec(line);
    if (!match) continue;
    const category = match[1].trim().toLowerCase();
    const tokens = match[2]
      .split(',')
      .map(token => token.trim())
      .filter(token => token.length > 0 && token.toLowerCase() !== 'none');
    for (const token of tokens) {
      if (!/^\d+$/.test(token)) return null;
      const id = Number(token);
      if (!wanted.has(id)) return null;
      if (assigned.has(id)) return null;
      assigned.set(id, category);
    }
  }
  if (assigned.size !== wanted.size) return null;
  return assigned;
}

/**
 * Cut the round's failures into leaf subsets.
 *
 * By project first, because a project's vocabulary is what an instruction is
 * scoped to. A project over the leaf cap is then cut by failure category, which
 * needs one model call; when that answer is not a partition the project stays
 * whole, because a bad split is worse than a big subset.
 */
export async function splitFailures(
  failures: Failure[],
  leafMax: number,
  textModel: (prompt: string) => Promise<string>
): Promise<LearnSubset[]> {
  const byProject = new Map<string, Failure[]>();
  for (const failure of failures) {
    const list = byProject.get(failure.project) ?? [];
    list.push(failure);
    byProject.set(failure.project, list);
  }
  const projects = [...byProject.keys()].sort();

  const oversize = projects.some(project => byProject.get(project)!.length > leafMax);
  // One split call per round whenever a split is happening at all: the answer
  // decides the category cut for the projects that still need one, and a
  // multi-project round still gets exactly one call rather than one per project.
  const needsSplit = oversize || projects.length > 1;
  let assignment: Map<number, string> | null = null;
  if (needsSplit) {
    const answer = await textModel(
      splitPrompt({
        failed: failures.map(failure => ({
          taskId: failure.taskId,
          project: failure.project,
          kind: failure.kind,
          answer: failure.answer,
        })),
        categories: FAILURE_CATEGORIES,
      })
    );
    assignment = parseAssignment(
      answer,
      failures.map(failure => failure.taskId)
    );
  }

  const subsets: LearnSubset[] = [];
  for (const project of projects) {
    const list = byProject.get(project)!;
    if (list.length <= leafMax || !assignment) {
      subsets.push({ project, taskIds: list.map(failure => failure.taskId) });
      continue;
    }
    const byCategory = new Map<string, number[]>();
    for (const failure of list) {
      const category = assignment.get(failure.taskId) ?? 'unclassified';
      const ids = byCategory.get(category) ?? [];
      ids.push(failure.taskId);
      byCategory.set(category, ids);
    }
    for (const category of [...byCategory.keys()].sort()) {
      subsets.push({ project, taskIds: byCategory.get(category)!, category });
    }
  }
  return subsets;
}

/** A kept entry, tracked with the child that kept it and its cited sources. */
interface KeptEntry {
  name: string;
  childRunId: string;
  entry: KnowledgeEntry;
  sources: SourceRef[];
}

/** The merge key of an entry: same key means the same thing in two children. */
function mergeKey(entry: KnowledgeEntry): string {
  return `${entry.kind}|${entry.project}|${entry.slug}`;
}

/**
 * The exchanges an entry cites, read back from its body's marks.
 *
 * The adapter stores citations as relations and does not parse them back into
 * `sources`, so this resolves the marks against the index database — the same
 * resolver the gate used when it accepted the body.
 */
function sourcesFromBody(dbs: LearnDbs, body: string): SourceRef[] {
  const resolve = indexExchangeResolver(dbs.index);
  const found = new Map<string, SourceRef>();
  for (const match of body.matchAll(/#([0-9a-f]{32})/g)) {
    const id = match[1];
    if (found.has(id)) continue;
    const resolved = resolve(id);
    if (resolved) found.set(id, resolved.ref);
  }
  return [...found.values()].sort((a, b) => (a.id < b.id ? -1 : 1));
}

/** The union of several source lists, de-duplicated and ordered by id. */
function unionSources(lists: Array<readonly SourceRef[]>): SourceRef[] {
  const seen = new Map<string, SourceRef>();
  for (const list of lists) {
    for (const source of list) {
      if (!seen.has(source.id)) seen.set(source.id, source);
    }
  }
  return [...seen.values()].sort((a, b) => (a.id < b.id ? -1 : 1));
}

function resolveFor(dbs: LearnDbs): IdCitationResolver {
  return {
    exchange: indexExchangeResolver(dbs.index),
    attempt: (id: number) => attemptsExist(dbs.learning, [id]),
  };
}

/**
 * The tasks one child's own work passed, from its newest graded attempt.
 *
 * Both roles count: a child's *gain* on a task is usually the `validate`
 * attempt that proved the candidate, not the `solve` attempt that failed before
 * it. Taking the newest attempt per task is what makes "the child's gains" a
 * property of the child rather than of one round of its loop.
 */
function childPassSet(dbs: LearnDbs, childRunId: string, taskIds: number[]): Set<number> {
  const latest = new Map<number, AttemptRow>();
  for (const role of ['solve', 'validate'] as const) {
    for (const attempt of listAttempts(dbs.learning, {
      runId: childRunId,
      taskIds,
      role,
      outcome: 'graded',
    })) {
      const existing = latest.get(attempt.taskId);
      if (!existing || existing.id < attempt.id) latest.set(attempt.taskId, attempt);
    }
  }
  const passed = new Set<number>();
  for (const [taskId, attempt] of latest) if (attempt.passed) passed.add(taskId);
  return passed;
}

/**
 * The tasks still failing in one snapshot, from the newest graded attempt.
 *
 * Scoped to the snapshot: an earlier round's pass on the same task must not
 * hide a failure the current knowledge causes, and an earlier round's failure
 * must not survive a fix that has since landed. `aborted`, `killed` and `error`
 * attempts are excluded by the `graded` predicate — they are evidence the run
 * was cut short, not that the solver missed.
 */
function failingTaskIds(
  dbs: LearnDbs,
  runId: string,
  snapshotId: number,
  taskIds: number[]
): number[] {
  const latest = new Map<number, AttemptRow>();
  for (const role of ['solve', 'validate'] as const) {
    for (const attempt of listAttempts(dbs.learning, {
      runId,
      taskIds,
      role,
      outcome: 'graded',
    })) {
      if (attempt.snapshotId !== snapshotId) continue;
      const existing = latest.get(attempt.taskId);
      if (!existing || existing.id < attempt.id) latest.set(attempt.taskId, attempt);
    }
  }
  const failed: number[] = [];
  for (const [taskId, attempt] of latest) if (!attempt.passed) failed.push(taskId);
  return failed.sort((a, b) => a - b);
}

/** The newest graded attempt for one task in one snapshot. */
function newestAttempt(dbs: LearnDbs, runId: string, snapshotId: number, taskId: number) {
  return listAttempts(dbs.learning, { runId, taskIds: [taskId], outcome: 'graded' })
    .filter(attempt => attempt.snapshotId === snapshotId)
    .reduce<AttemptRow | null>((best, attempt) => (best === null || attempt.id > best.id ? attempt : best), null);
}

/**
 * Run one `learn improve`.
 *
 * Everything that would reach a model, a subprocess or a GPU is injected, so a
 * test drives the whole recursion with fakes and never leaves the process.
 */
export async function runLearn(dbs: LearnDbs, options: LearnOptions): Promise<LearnResult> {
  const config = learnConfig();
  const model = options.model ?? config.model;
  const pids = options.pids ?? NO_PIDS;
  const textModel = options.textModel ?? defaultTextModel;
  const budget = options.budget;
  const seed = options.seed ?? 1;

  const runId = createRun(dbs.learning, {
    phase: 'improve',
    ...(options.project === undefined ? {} : { project: options.project }),
    seed,
    budget: { maxCalls: budget.max, maxUsd: config.maxUsd },
  });

  const result: LearnResult = {
    runId,
    status: 'done',
    projects: [],
    children: [],
    kept: [],
    rejected: [],
    merges: [],
    reflections: [],
    before: emptyRate(),
    after: emptyRate(),
    test: emptyRate(),
    rounds: 0,
  };

  const reject = (slug: string, reason: string): void => {
    result.rejected.push({ slug, reason });
    addRejection(dbs.learning, runId, { slug, reason });
  };

  const tasks = signalTrainTasks(dbs, options.project);
  const taskIds = tasks.map(task => task.id);
  const taskById = new Map(tasks.map(task => [task.id, task]));

  const solveOptions = {
    runId,
    role: 'solve' as const,
    model,
    pids,
    runAgent: options.runAgent,
    judge: options.judge,
    solve: options.solve,
  };

  try {
    // 1. Baseline: the snapshot the run starts from, solved over the signal set.
    const beforeSnapshot = await createSnapshot(
      dbs.learning,
      runId,
      await activeNames(dbs),
      dbs.store
    );
    if (tasks.length > 0) {
      try {
        await solveMany(dbs, tasks, { ...solveOptions, snapshotId: beforeSnapshot, budget });
      } catch (error) {
        if (!(error instanceof BudgetExhausted)) throw error;
        result.status = 'stopped';
      }
    }
    result.before = passRate(dbs.learning, runId, beforeSnapshot, {
      split: 'train',
      signalOnly: true,
    });

    // 2. The round loop. A dry run measures and stops here.
    //
    // Round 0 measures the baseline snapshot. A later round first establishes
    // `K^(t)` again — the active set the previous round left — and re-solves the
    // whole signal set against it, because an edit kept last round can have
    // fixed some tasks *and* broken others, and only a fresh solve says which.
    const totalRounds = options.dryRun ? 0 : options.rounds;
    let roundSnapshot = beforeSnapshot;
    for (let round = 0; round < totalRounds; round += 1) {
      if (result.status === 'stopped' || budget.used >= budget.max) {
        result.status = 'stopped';
        break;
      }
      result.rounds = round + 1;

      if (round > 0) {
        roundSnapshot = await createSnapshot(
          dbs.learning,
          runId,
          await activeNames(dbs),
          dbs.store
        );
        if (tasks.length > 0) {
          try {
            await solveMany(dbs, tasks, { ...solveOptions, snapshotId: roundSnapshot, budget });
          } catch (error) {
            if (!(error instanceof BudgetExhausted)) throw error;
            result.status = 'stopped';
            break;
          }
        }
      }

      const failures: Failure[] = [];
      for (const taskId of failingTaskIds(dbs, runId, roundSnapshot, taskIds)) {
        const task = taskById.get(taskId);
        if (!task) continue;
        const newest = newestAttempt(dbs, runId, roundSnapshot, taskId);
        failures.push({
          taskId,
          project: task.project,
          answer: newest?.answer ?? '',
          kind: task.kind,
        });
      }
      if (failures.length === 0) break;

      const subsets = await splitFailures(failures, options.leafMax, textModel);
      const keptBefore = result.kept.length;
      const roundKept: KeptEntry[] = [];

      // 3. Leaf learners, in parallel and bounded. One project that fits the
      //    leaf cap is one leaf in this very run; anything else is a child run.
      const single = subsets.length === 1 && subsets[0].taskIds.length <= options.leafMax;
      if (single) {
        const subset = subsets[0];
        try {
          const leaf = await runLeafLearner(dbs, {
            runId,
            project: subset.project,
            taskIds: subset.taskIds,
            rounds: 1,
            editsPerRound: config.editsPerRound,
            budget,
            model,
            pids,
            runAgent: options.runAgent,
            solve: options.solve,
            judge: options.judge,
          });
          result.kept.push(...leaf.kept);
          roundKept.push(...(await collectKept(dbs, leaf.kept, runId)));
        } catch (error) {
          if (!(error instanceof BudgetExhausted)) throw error;
          result.status = 'stopped';
        }
      } else {
        const semaphore = createSemaphore(options.concurrency);
        const children = await Promise.all(
          subsets.map(subset =>
            semaphore.run(async () => {
              const childRunId = createRun(dbs.learning, {
                phase: 'improve',
                parentRunId: runId,
                project: subset.project,
                seed,
                budget: { maxCalls: budget.max, maxUsd: config.maxUsd },
              });
              result.children.push(childRunId);
              if (!result.projects.includes(subset.project)) result.projects.push(subset.project);
              try {
                const leaf = await runLeafLearner(dbs, {
                  runId: childRunId,
                  project: subset.project,
                  taskIds: subset.taskIds,
                  rounds: 1,
                  editsPerRound: config.editsPerRound,
                  budget,
                  model,
                  pids,
                  runAgent: options.runAgent,
                  solve: options.solve,
                  judge: options.judge,
                });
                finishRun(dbs.learning, childRunId, 'done', {
                  kept: leaf.kept.length,
                  rejected: leaf.rejected.length,
                  suspect: leaf.suspect.length,
                  category: subset.category ?? null,
                });
                return { childRunId, subset, leaf };
              } catch (error) {
                if (error instanceof BudgetExhausted) {
                  finishRun(dbs.learning, childRunId, 'stopped', {});
                  return { childRunId, subset, leaf: null };
                }
                finishRun(dbs.learning, childRunId, 'failed', {});
                throw error;
              }
            })
          )
        );

        for (const child of children) {
          if (!child.leaf) {
            result.status = 'stopped';
            continue;
          }
          result.kept.push(...child.leaf.kept);
          roundKept.push(...(await collectKept(dbs, child.leaf.kept, child.childRunId)));
        }

        // 4. Merge duplicates across children, then prove the merge.
        await mergeRound(dbs, {
          runId,
          round,
          kept: roundKept,
          children: children.map(child => ({ runId: child.childRunId, taskIds: child.subset.taskIds })),
          seed,
          budget,
          solveOptions,
          textModel,
          reject,
          result,
        });
      }

      // 5. One reflection per round.
      const roundPassed = tasks.length - failures.length;
      const reflectionName = await reflectRound(dbs, {
        runId,
        round,
        project: options.project ?? (result.projects.length === 1 ? result.projects[0] : '*'),
        kept: roundKept.map(kept => kept.name),
        rejected: result.rejected,
        before: result.before,
        after: { passed: roundPassed, total: tasks.length },
        tasks,
        reject,
        textModel,
      });
      if (reflectionName) result.reflections.push(reflectionName);

      const keptThisRound = result.kept.length - keptBefore;
      if (keptThisRound > 0) {
        await writeLearnedBlocks(dbs.store, dbs.learning, config.maxChars);
      }

      if (result.status === 'stopped' || budget.used >= budget.max) {
        result.status = 'stopped';
        break;
      }
      if (keptThisRound === 0) break;
    }

    // 6. The after measurement, then the held-out split — once, and last.
    let finalSnapshot = beforeSnapshot;
    if (result.rounds > 0) {
      finalSnapshot = await createSnapshot(dbs.learning, runId, await activeNames(dbs), dbs.store);
      if (tasks.length > 0) {
        try {
          await solveMany(dbs, tasks, { ...solveOptions, snapshotId: finalSnapshot, budget });
        } catch (error) {
          if (!(error instanceof BudgetExhausted)) throw error;
          result.status = 'stopped';
        }
      }
    }
    result.after = passRate(dbs.learning, runId, finalSnapshot, {
      split: 'train',
      signalOnly: true,
    });

    const testTasks = listTasks(dbs.learning, {
      split: 'test',
      ...(options.project === undefined ? {} : { project: options.project }),
    });
    if (testTasks.length > 0) {
      try {
        // The held-out evaluation is not training spend: it runs even after the
        // training budget stopped the run, so a stopped run is still judged.
        await solveMany(dbs, testTasks, {
          ...solveOptions,
          snapshotId: finalSnapshot,
          budget: new CallBudget(Number.MAX_SAFE_INTEGER),
        });
      } catch {
        // A failed held-out solve leaves the test rate where it is.
      }
    }
    result.test = passRate(dbs.learning, runId, finalSnapshot, { split: 'test', signalOnly: false });

    finishRun(dbs.learning, runId, result.status, {
      projects: result.projects.length,
      children: result.children.length,
      rounds: result.rounds,
      kept: result.kept.length,
      rejected: result.rejected.length,
      merges: result.merges,
      reflections: result.reflections,
      train: { before: result.before, after: result.after },
      test: result.test,
      budgetUsed: budget.used,
    });
  } catch (error) {
    result.status = 'failed';
    finishRun(dbs.learning, runId, 'failed', {
      kept: result.kept.length,
      rejected: result.rejected.length,
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }

  return result;
}

/** Read back each kept entry with the sources its body cites. */
async function collectKept(
  dbs: LearnDbs,
  names: string[],
  childRunId: string
): Promise<KeptEntry[]> {
  const kept: KeptEntry[] = [];
  for (const name of names) {
    const entry = await getEntry(dbs.store, name);
    if (!entry) continue;
    kept.push({ name, childRunId, entry, sources: sourcesFromBody(dbs, entry.body) });
  }
  return kept;
}

interface MergeRoundInput {
  runId: string;
  round: number;
  kept: KeptEntry[];
  children: Array<{ runId: string; taskIds: number[] }>;
  seed: number;
  budget: CallBudget;
  solveOptions: {
    runId: string;
    role: 'solve';
    model: string;
    pids: PidRegistry;
    runAgent?: typeof runAgent;
    judge?: (prompt: string) => Promise<string>;
    solve?: typeof solveTask;
  };
  textModel: (prompt: string) => Promise<string>;
  reject: (slug: string, reason: string) => void;
  result: LearnResult;
}

/**
 * Merge the duplicates this round's children kept, then prove the merge.
 *
 * A merge that regresses a child is undone by retiring the merged version and
 * writing the child's body again as the next version, which is what makes the
 * chain head the child's own text again. Nothing is deleted.
 */
async function mergeRound(dbs: LearnDbs, input: MergeRoundInput): Promise<void> {
  const byKey = new Map<string, KeptEntry[]>();
  for (const kept of input.kept) {
    const key = mergeKey(kept.entry);
    const list = byKey.get(key) ?? [];
    list.push(kept);
    byKey.set(key, list);
  }

  const config = learnConfig();
  const created: Array<{ record: MergeRecord; kept: KeptEntry[]; entry: KnowledgeEntry }> = [];
  for (const [key, kept] of byKey) {
    const childRuns = new Set(kept.map(entry => entry.childRunId));
    if (childRuns.size < 2) continue;

    const entries = kept.map(entry => entry.entry);
    const first = entries[0];
    const sources = unionSources(kept.map(entry => entry.sources));

    let body: string;
    try {
      body = parseLines(await input.textModel(mergeEntriesPrompt(entries))).join('\n');
    } catch (error) {
      input.reject(first.slug, `merge failed: ${error instanceof Error ? error.message : String(error)}`);
      continue;
    }
    if (!body) {
      input.reject(first.slug, 'merge produced no body');
      continue;
    }

    const proposal: ProposedEntry = {
      kind: first.kind,
      project: first.project,
      slug: first.slug,
      title: first.title,
      description: first.description,
      body,
      scope: first.scope,
      confidence: first.confidence,
    };
    const gated = gateEntry(proposal, {
      resolve: resolveFor(dbs),
      redactPii: (text: string) => dbs.store.redactPii(text),
      config,
      runId: input.runId,
    });
    if ('rejected' in gated) {
      input.reject(first.slug, `merge: ${gated.rejected}`);
      continue;
    }

    let mergedName: string;
    try {
      mergedName = await insertKnowledgeEntry(dbs.store, gated.entry);
    } catch (error) {
      if (error instanceof DuplicateEntry) input.reject(first.slug, 'merge: duplicate');
      else input.reject(first.slug, `merge: ${error instanceof Error ? error.message : String(error)}`);
      continue;
    }

    const entry = await getEntry(dbs.store, mergedName);
    if (!entry) continue;
    created.push({
      kept,
      entry,
      record: {
        key,
        merged: mergedName,
        sources: sources.map(source => source.id),
        revertedTo: null,
        regressions: [],
      },
    });
  }
  if (created.length === 0) return;

  // The merged set is `K` with each merge's key replaced by its candidate — the
  // same substitution `validateCandidate` makes, so the check does not score a
  // child's version against itself.
  const replacedPrefixes = created.map(
    merge => `learned:${merge.entry.kind}:${merge.entry.project}:${merge.entry.slug}:`
  );
  const mergedSnapshot = await createSnapshot(
    dbs.learning,
    input.runId,
    [
      ...(await activeNames(dbs)).filter(
        name => !replacedPrefixes.some(prefix => name.startsWith(prefix))
      ),
      ...created.map(merge => merge.record.merged),
    ].sort(),
    dbs.store
  );

  const samples = input.children
    .map(child => ({
      runId: child.runId,
      taskIds: sampleIds(child.taskIds, config.validateSample, input.seed + input.round),
    }))
    .filter(sample => sample.taskIds.length > 0);

  const regressionsByChild = new Map<string, number[]>();
  for (const sample of samples) {
    const before = childPassSet(dbs, sample.runId, sample.taskIds);
    if (before.size === 0) continue;
    const sampleTasks = listTasks(dbs.learning, {
      split: 'train',
      ids: sample.taskIds,
      kinds: SIGNAL_KINDS,
      tiers: SIGNAL_TIERS,
    });
    let attempts: AttemptRow[];
    try {
      attempts = await solveMany(dbs, sampleTasks, {
        ...input.solveOptions,
        snapshotId: mergedSnapshot,
        role: 'merge-check',
        budget: input.budget,
      });
    } catch (error) {
      input.reject(
        'merge-check',
        `merge-check failed: ${error instanceof Error ? error.message : String(error)}`
      );
      continue;
    }
    const regressed = attempts.filter(attempt => before.has(attempt.taskId) && !attempt.passed);
    if (regressed.length > 0) {
      regressionsByChild.set(
        sample.runId,
        regressed.map(attempt => attempt.taskId)
      );
    }
  }

  for (const merge of created) {
    const regressedChildren = [...regressionsByChild.keys()].filter(childRunId =>
      merge.kept.some(entry => entry.childRunId === childRunId)
    );
    const regressions = [
      ...new Set(regressedChildren.flatMap(childRunId => regressionsByChild.get(childRunId) ?? [])),
    ].sort((a, b) => a - b);

    if (regressions.length > 0) {
      const first = merge.kept[0].entry;
      merge.record.regressions = regressions;
      merge.record.revertedTo = await restoreChildVersion(
        dbs,
        merge.record.merged,
        merge.kept,
        regressedChildren[0]
      );
      input.reject(
        first.slug,
        `merge reverted: the merged ${first.kind} ${first.project}/${first.slug} regressed task(s) ${regressions.join(', ')}`
      );
      input.result.merges.push(merge.record);
      continue;
    }

    // The merge stood: it becomes the key's active version, superseding the
    // children's copies the way any kept revision does.
    const canActivate =
      merge.entry.kind === 'skill' ||
      (merge.entry.kind === 'instruction' && config.approve === 'none');
    if (canActivate) await activate(dbs.store, merge.record.merged, null, 'verified');
    input.result.merges.push(merge.record);
  }

  // Instruction lines the merge made contradictory: one more model call may
  // resolve them, and a pair it cannot resolve is retired with the conflict
  // named in the round's reflection.
  await resolveConflicts(dbs, input);
}

/**
 * Resolve the heuristic conflicts a merge introduced.
 *
 * Each conflicting instruction entry is offered once more to the model, which
 * may return a body that resolves the contradiction. When it cannot, the
 * version is retired and the round records why; nothing is deleted.
 */
async function resolveConflicts(dbs: LearnDbs, input: MergeRoundInput): Promise<void> {
  let conflicts: Array<{ a: string; b: string; kind: 'overlap' | 'contradiction'; reason: string }>;
  try {
    conflicts = await dbs.store.detectHeuristicConflicts();
  } catch {
    return;
  }
  if (conflicts.length === 0) return;

  const instructions = input.kept.filter(kept => kept.entry.kind === 'instruction');
  const involved = instructions.filter(kept =>
    conflicts.some(
      conflict =>
        kept.entry.heuristicIds.includes(conflict.a) || kept.entry.heuristicIds.includes(conflict.b)
    )
  );

  const config = learnConfig();
  for (const kept of involved) {
    let resolved = false;
    try {
      const body = parseLines(await input.textModel(mergeEntriesPrompt([kept.entry]))).join('\n');
      if (body && body !== kept.entry.body) {
        const gated = gateEntry(
          {
            kind: kept.entry.kind,
            project: kept.entry.project,
            slug: kept.entry.slug,
            title: kept.entry.title,
            description: kept.entry.description,
            body,
            scope: kept.entry.scope,
            confidence: kept.entry.confidence,
          },
          {
            resolve: resolveFor(dbs),
            redactPii: (text: string) => dbs.store.redactPii(text),
            config,
            runId: input.runId,
          }
        );
        if (!('rejected' in gated)) {
          const name = await insertKnowledgeEntry(dbs.store, gated.entry);
          if (config.approve === 'none') await activate(dbs.store, name, null, 'verified');
          resolved = true;
        }
      }
    } catch {
      resolved = false;
    }
    if (!resolved) {
      await retire(dbs.store, kept.name);
      input.reject(
        `${kept.entry.slug}-conflict`,
        `conflicting instruction line retired: ${kept.name}`
      );
    }
  }
}

/**
 * Put a child's version back after a merge regressed it.
 *
 * The merged version is retired (kept, readable) and the child's body is written
 * again as the next version and activated, so the key's live text is the
 * child's own and the chain did not have to un-supersede anything. Returns the
 * restored name, or null when the body could not be written.
 */
async function restoreChildVersion(
  dbs: LearnDbs,
  mergedName: string,
  kept: KeptEntry[],
  childRunId: string | undefined
): Promise<string | null> {
  await retire(dbs.store, mergedName);

  const source = kept.find(entry => entry.childRunId === childRunId) ?? kept[kept.length - 1];
  if (!source) return null;

  try {
    const restored = await insertKnowledgeEntry(dbs.store, {
      kind: source.entry.kind,
      project: source.entry.project,
      slug: source.entry.slug,
      title: source.entry.title,
      description: source.entry.description,
      body: source.entry.body,
      scope: source.entry.scope,
      confidence: source.entry.confidence,
      trust: 'verified',
      sources: source.sources,
      status: 'candidate',
      runId: source.entry.runId,
      ...(source.entry.steps ? { steps: source.entry.steps } : {}),
    });
    await activate(dbs.store, restored, source.entry.validation, 'verified');
    return restored;
  } catch {
    return null;
  }
}


interface ReflectRoundInput {
  runId: string;
  round: number;
  project: string;
  kept: string[];
  rejected: Array<{ slug: string; reason: string }>;
  before: PassRate;
  after: { passed: number; total: number };
  tasks: LearningTask[];
  reject: (slug: string, reason: string) => void;
  textModel: (prompt: string) => Promise<string>;
}

/** The round's reflection, written through the same gates as any other entry. */
async function reflectRound(dbs: LearnDbs, input: ReflectRoundInput): Promise<string | null> {
  const slug = `${REFLECTION_SLUG_PREFIX}-${input.round + 1}`;
  const resolve = resolveFor(dbs);

  const attempts = listAttempts(dbs.learning, { runId: input.runId, role: 'solve' });
  const evidence = attempts.slice(0, 20).map(attempt => {
    const task = attempt.taskId;
    return { attemptId: attempt.id, taskId: task, passed: attempt.passed };
  });

  const sources = unionSources(input.tasks.map(task => task.truth.exchanges));
  if (sources.length === 0) return null;

  let body: string;
  try {
    body = parseLines(
      await input.textModel(
        reflectPrompt({
          runId: input.runId,
          project: input.project,
          kept: input.kept,
          rejected: input.rejected,
          before: { passed: input.before.passed, total: input.before.total },
          after: input.after,
          evidence,
          sources,
        })
      )
    ).join('\n');
  } catch (error) {
    input.reject(slug, `reflection failed: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
  if (!body) return null;

  const gated = gateEntry(
    {
      kind: 'reflection',
      project: input.project,
      slug,
      title: `Round ${input.round + 1} reflection`,
      description: 'What the round changed, what conflicted, and what a later pass should try.',
      body,
      scope: input.project === '*' ? 'all projects' : input.project,
      confidence: 'low',
    },
    {
      resolve,
      redactPii: (text: string) => dbs.store.redactPii(text),
      config: learnConfig(),
      runId: input.runId,
    }
  );
  if ('rejected' in gated) {
    input.reject(slug, gated.rejected);
    return null;
  }

  try {
    const name = await insertKnowledgeEntry(dbs.store, gated.entry);
    for (const attemptId of gated.attempts) {
      const attempt = attempts.find(candidate => candidate.id === attemptId);
      await dbs.store.citeAttempt(name, attemptId, attempt?.taskId ?? 0, input.runId);
    }
    return name;
  } catch (error) {
    if (error instanceof DuplicateEntry) input.reject(slug, 'duplicate');
    else input.reject(slug, error instanceof Error ? error.message : String(error));
    return null;
  }
}
