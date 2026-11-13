/**
 * Bootstrapping: map the archive's projects and propose the first knowledge.
 *
 * Spec §6.1. The run has four stages, and each one is a gate rather than a
 * formality:
 *
 * 1. **Bootstrappers.** One isolated subprocess per eligible project, in
 *    parallel under a bound. Each gets the four read-only tools plus
 *    `propose_entry` and maps its corpus: periods, topics, the user's terms,
 *    what supersedes what, what is absent. It proposes one `navigation` skill
 *    and one `exploration-notes` skill.
 * 2. **Gates.** Every proposal goes through `gateEntry` with resolvers backed by
 *    the index database and `learning_attempt`; a failure is recorded on the run
 *    with its reason instead of being retried or repaired. The two bootstrap
 *    skills' cited lines are also mirrored into the project context — that copy
 *    feeds learner prompts only, never the rendered block, so nothing uncited
 *    can reach a session.
 * 3. **Merge.** One text call consolidates the candidates into a single global
 *    instruction in the template grammar. Each of its lines is also a heuristic,
 *    which is what makes a later `reinforce` meaningful.
 * 4. **Measurement.** Generate tasks if the archive has none, solve the signal
 *    train set first with an empty snapshot and then with the candidates, and
 *    decide with the paper's Figure 4 rule: keep a candidate when both sides
 *    graded the same number of tasks, the pass rate does not fall, and either
 *    mean turns or USD per task falls by at least
 *    `EPISODIC_MEMORY_LEARN_MIN_SAVING`. An unmeasured or partially measured
 *    candidate stays a candidate.
 *
 * A spend cap stops the run (`stopped`) and keeps everything already validated;
 * it does not throw away the bootstrapping work.
 *
 * Additive only: nothing here deletes an entry. A candidate that fails the gain
 * rule keeps its row and its validation record and waits for a human.
 */

import type Database from 'better-sqlite3';
import { learnConfig, type LearnConfig } from './learn-config.js';
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
import {
  activate,
  createSnapshot,
  insertKnowledgeEntry,
  DuplicateEntry,
} from './knowledge-db.js';
import { gateEntry } from './knowledge-gate.js';
import type { IdCitationResolver, ResolvedExchange } from './cited-ids.js';
import { createSemaphore, globalAgentSemaphore } from './semaphore.js';
import { BudgetExhausted, CallBudget, solveMany } from './solver.js';
import { buildLearnToolServer } from './sdk-tools.js';
import { runAgent, type PidRegistry } from './agent-runner.js';
import {
  BOOTSTRAP_SKILL_SLUGS,
  bootstrapperBrief,
  bootstrapperSystemPrompt,
  mergeInstructionPrompt,
  reflectPrompt,
} from './prompts.js';
import { writeLearnedBlocks } from './learned-block.js';
import { checkTasks, generateTasks, MIN_PER_PROJECT } from './tasks.js';
import type {
  KnowledgeEntry,
  LearnDbs,
  LearningKind,
  ProposedEntry,
  SourceRef,
  ValidationRecord,
} from './types.js';

/** The slug of the global instruction the merge step writes. */
export const BOOTSTRAP_INSTRUCTION_SLUG = 'bootstrap-map';

/** The slug of the run's reflection. */
export const BOOTSTRAP_REFLECTION_SLUG = 'bootstrap-reflection';

/**
 * The options for `runBootstrap`. Only `budget` is required.
 */
export interface BootstrapOptions {
  /** Test seam: defaults to `runAgent`. */
  runAgent?: typeof runAgent;
  /** Model for the bootstrapper subprocesses. */
  model?: string;
  /** Judge for a `recall` solve; unused by the signal set, passed through anyway. */
  judge?: (prompt: string) => Promise<string>;
  /** Cap on concurrent bootstrapper subprocesses. */
  concurrency?: number;
  /** Source exchanges per project for task generation. */
  perProject?: number;
  seed?: number;
  /** The run's shared call budget. */
  budget: CallBudget;
  /** Where a run records the subprocesses it owns. */
  pids?: PidRegistry;
  /** Text-only model for the merge and reflection calls. Defaults to `callLearnModel`. */
  textModel?: (prompt: string) => Promise<string>;
}

/**
 * The outcome of one `runBootstrap` call.
 *
 * `status` is `stopped` when the call budget ran out, or could not cover the next step, before the run finished.
 */
export interface BootstrapResult {
  runId: string;
  projects: number;
  /** Proposals the gates accepted and stored as candidates. */
  proposed: number;
  rejected: Array<{ slug: string; reason: string }>;
  /** Entry names this run activated. */
  activated: string[];
  /** Entry names left as candidates (awaiting a measured gain or a human). */
  pending: string[];
  before: PassRate;
  after: PassRate;
  status: 'done' | 'stopped';
}

/** One project's corpus shape, from the index alone. */
export interface ProjectStats {
  project: string;
  exchanges: number;
  sessions: number;
  first: string;
  last: string;
}

/**
 * Projects with at least `MIN_PER_PROJECT` indexed exchanges (spec §6.1 step 2).
 *
 * The order is deterministic, and sidechains are excluded. A project with a dozen
 * exchanges makes every one of its tasks trivially findable. A sidechain is not a
 * conversation a user would search for.
 */
export function eligibleProjects(
  indexDb: Database.Database,
  minPerProject: number = MIN_PER_PROJECT
): ProjectStats[] {
  const rows = indexDb
    .prepare(
      `SELECT project,
              COUNT(*) AS exchanges,
              COUNT(DISTINCT session_id) AS sessions,
              MIN(timestamp) AS first,
              MAX(timestamp) AS last
         FROM exchanges
        WHERE COALESCE(is_sidechain, 0) = 0
        GROUP BY project
       HAVING COUNT(*) >= ?
        ORDER BY project`
    )
    .all(minPerProject) as Array<{
    project: string;
    exchanges: number;
    sessions: number;
    first: string;
    last: string;
  }>;

  return rows.map(row => ({
    project: row.project,
    exchanges: Number(row.exchanges),
    sessions: Number(row.sessions),
    first: String(row.first ?? ''),
    last: String(row.last ?? ''),
  }));
}

/** An exchange resolver over the index database, for the citation gate. */
export function indexExchangeResolver(indexDb: Database.Database): IdCitationResolver['exchange'] {
  const stmt = indexDb.prepare(
    `SELECT id, archive_path, line_start, line_end, session_id, user_message, assistant_message
       FROM exchanges
      WHERE id = ?`
  );
  return (id: string): ResolvedExchange | null => {
    const row = stmt.get(id) as
      | {
          id: string;
          archive_path: string;
          line_start: number;
          line_end: number;
          session_id: string | null;
          user_message: string;
          assistant_message: string;
        }
      | undefined;
    if (!row) return null;
    const ref: SourceRef = {
      id: row.id,
      path: row.archive_path,
      lineStart: Number(row.line_start),
      lineEnd: Number(row.line_end),
      sessionId: row.session_id ?? null,
    };
    return { ref, text: `${row.user_message}\n${row.assistant_message}` };
  };
}

/** A concurrency-bounded map that preserves input order. */
async function mapBounded<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>
): Promise<R[]> {
  const semaphore = createSemaphore(limit);
  return Promise.all(items.map(item => semaphore.run(() => fn(item))));
}

/** What one bootstrapper subprocess produced. */
interface BootstrapProject {
  project: string;
  proposals: ProposedEntry[];
  skipped: boolean;
  /** Why the bootstrapper failed, when it did. Recorded as a rejection. */
  failure?: string;
}

function defaultTextModel(prompt: string): Promise<string> {
  return import('../summarizer.js').then(({ callLearnModel }) => callLearnModel(prompt));
}

/** The gain rule's numbers. */
function savings(before: PassRate, after: PassRate): {
  turnSavingPct: number;
  usdSavingPct: number;
  rateFell: boolean;
} {
  const rateFell =
    before.total > 0 && after.total > 0 && after.passed / after.total < before.passed / before.total;
  const turnSavingPct =
    before.total > 0 && after.total > 0 && before.meanTurns > 0
      ? ((before.meanTurns - after.meanTurns) / before.meanTurns) * 100
      : 0;
  const beforeUsd = before.total > 0 ? before.usd / before.total : 0;
  const afterUsd = after.total > 0 ? after.usd / after.total : 0;
  const usdSavingPct = beforeUsd > 0 ? ((beforeUsd - afterUsd) / beforeUsd) * 100 : 0;
  return { turnSavingPct, usdSavingPct, rateFell };
}

/**
 * The bootstrap gain rule: keep when the signal pass rate does not fall.
 * Mean turns or USD per task must also fall by at least `minSavingPct`.
 *
 * Both sides must have been measured, and they must have graded the same number
 * of tasks. `passRate` counts only graded attempts, so an abort shrinks one
 * side's total. A smaller after side can contain only the easy tasks. Such a side is not
 * evidence that the candidate saved turns at equal accuracy, so the candidate waits.
 */
export function bootstrapGain(
  before: PassRate,
  after: PassRate,
  minSavingPct: number
): { keep: boolean; turnSavingPct: number; usdSavingPct: number; reason: string } {
  const { turnSavingPct, usdSavingPct, rateFell } = savings(before, after);
  if (before.total === 0 || after.total === 0) {
    return { keep: false, turnSavingPct, usdSavingPct, reason: 'unmeasured' };
  }
  if (before.total !== after.total) {
    return { keep: false, turnSavingPct, usdSavingPct, reason: 'unequal-coverage' };
  }
  if (rateFell) {
    return { keep: false, turnSavingPct, usdSavingPct, reason: 'pass-rate-fell' };
  }
  if (turnSavingPct >= minSavingPct || usdSavingPct >= minSavingPct) {
    return { keep: true, turnSavingPct, usdSavingPct, reason: 'saving' };
  }
  return { keep: false, turnSavingPct, usdSavingPct, reason: 'no-saving' };
}

/** The lines a bootstrap skill contributes to the project context. */
function citedLines(entry: KnowledgeEntry): string[] {
  return entry.body
    .split('\n')
    .map(line => line.trim())
    .filter(line => line.length > 0);
}

/**
 * Mirror the two bootstrap skills' cited lines into the project context.
 *
 * The mirrored copy is for learner prompts only. `forContext` is never rendered into a session.
 * Therefore the lines keep their marks here, rather than being flattened into prose.
 */
async function mirrorProjectContext(
  store: LearnDbs['store'],
  project: string,
  entries: KnowledgeEntry[]
): Promise<void> {
  const navigation = entries.find(entry => entry.slug === BOOTSTRAP_SKILL_SLUGS[0]);
  const exploration = entries.find(entry => entry.slug === BOOTSTRAP_SKILL_SLUGS[1]);
  if (!navigation && !exploration) return;

  const facts = navigation ? citedLines(navigation) : [];
  const conventions = exploration ? citedLines(exploration) : [];
  if (facts.length === 0 && conventions.length === 0) return;

  await store.upsertProjectContext(project, {
    ...(facts.length > 0 ? { facts } : {}),
    ...(conventions.length > 0 ? { conventions } : {}),
    glossary: [],
  });
}

function emptyRate(): PassRate {
  return { passed: 0, total: 0, meanTurns: 0, usd: 0, byKindTier: {} };
}

/** Build the validation record a bootstrap verdict is stored with. */
function validationFor(
  before: PassRate,
  after: PassRate,
  sample: number[]
): ValidationRecord {
  return {
    targeted: [],
    sample,
    passedBefore: before.passed,
    passedAfter: after.passed,
    regressions: [],
    judgedAt: new Date().toISOString(),
    meanTurnsBefore: before.total > 0 ? before.meanTurns : null,
    meanTurnsAfter: after.total > 0 ? after.meanTurns : null,
    usdBefore: before.total > 0 ? before.usd : null,
    usdAfter: after.total > 0 ? after.usd : null,
    gradedBefore: before.total,
    gradedAfter: after.total,
  };
}

/**
 * The signal tasks the measurement solves twice.
 *
 * `listTasks` is the only read path. The split predicate is mandatory, so the held-out rows
 * cannot enter the returned list even by a caller's mistake.
 */
function signalTrainTasks(db: Database.Database): LearningTask[] {
  return listTasks(db, { split: 'train', kinds: SIGNAL_KINDS, tiers: SIGNAL_TIERS });
}

async function countTasks(db: Database.Database): Promise<number> {
  const row = db.prepare('SELECT COUNT(*) AS n FROM learning_task').get() as { n: number } | undefined;
  return Number(row?.n ?? 0);
}

/** How many tasks of each kind and tier the run generated or measured. */
function kindTierTotals(tasks: LearningTask[]): Record<string, number> {
  const totals: Record<string, number> = {};
  for (const task of tasks) {
    const key = `${task.kind}:${task.tier}`;
    totals[key] = (totals[key] ?? 0) + 1;
  }
  return totals;
}

/** Parse the merge answer: template lines, one per body line. */
function mergeLines(raw: string): string[] {
  return String(raw ?? '')
    .split('\n')
    .map(line => line.replace(/^\s*(?:[-*\u2022]|\d+[.)])\s+/, '').trim())
    .filter(line => line.length > 0);
}

/**
 * Run the bootstrap.
 *
 * Everything the run needs is injected: `runAgent`, the text model, the budget and the PID
 * registry. So a test never reaches a model, a GPU or a subprocess.
 */
export async function runBootstrap(
  dbs: LearnDbs,
  options: BootstrapOptions
): Promise<BootstrapResult> {
  const config = learnConfig();
  const seed = options.seed ?? 1;
  const perProject = options.perProject ?? 8;
  const model = options.model ?? config.model;
  const concurrency = options.concurrency ?? config.concurrency;
  const runAgentFn = options.runAgent ?? runAgent;
  const textModel = options.textModel ?? defaultTextModel;
  const budget = options.budget;

  const runId = createRun(dbs.learning, {
    phase: 'bootstrap',
    seed,
    budget: { maxCalls: budget.max, maxUsd: config.maxUsd },
  });

  const resolve: IdCitationResolver = {
    exchange: indexExchangeResolver(dbs.index),
    attempt: (id: number) => attemptsExist(dbs.learning, [id]),
  };
  const gateDeps = {
    resolve,
    redactPii: (text: string) => dbs.store.redactPii(text),
    config: config as Pick<LearnConfig, 'minGrounding'>,
    runId,
  };

  const projects = eligibleProjects(dbs.index);
  const rejected: Array<{ slug: string; reason: string }> = [];
  const accepted: KnowledgeEntry[] = [];
  let status: 'done' | 'stopped' = 'done';
  let before = emptyRate();
  let after = emptyRate();
  const activated: string[] = [];
  const pending: string[] = [];

  const reject = (slug: string, reason: string): void => {
    rejected.push({ slug, reason });
    addRejection(dbs.learning, runId, { slug, reason });
  };

  try {
    // 1. Bootstrappers, one per eligible project, bounded.
    const perProjectResults = await mapBounded<ProjectStats, BootstrapProject>(
      projects,
      concurrency,
      async stats => {
        const proposals: ProposedEntry[] = [];
        try {
          budget.spend();
        } catch (error) {
          if (error instanceof BudgetExhausted) return { project: stats.project, proposals, skipped: true };
          throw error;
        }
        const server = buildLearnToolServer({
          project: stats.project,
          hideExchangeIds: [],
          allowPropose: true,
          onPropose: proposal => proposals.push(proposal),
        });
        // The global limiter bounds every subprocess in the process; the stage's
        // own bound (`opts.concurrency`) is the tighter of the two in a test.
        try {
          await globalAgentSemaphore().run(() =>
            runAgentFn({
              prompt: bootstrapperBrief(stats.project, {
                exchanges: stats.exchanges,
                sessions: stats.sessions,
                first: stats.first,
                last: stats.last,
              }),
              systemPrompt: bootstrapperSystemPrompt(),
              server,
              allowPropose: true,
              maxTurns: config.learnerMaxTurns,
              maxBudgetUsd: 1,
              timeoutMs: 300_000,
              model,
              pids: options.pids,
            })
          );
        } catch (error) {
          // One project's bootstrapper failing is not the run failing: the other
          // projects' proposals are still worth gating. A spend exhaustion is
          // different — it stops the measuring stage, which the caller sees.
          if (error instanceof BudgetExhausted) throw error;
          return {
            project: stats.project,
            proposals,
            skipped: false,
            failure: error instanceof Error ? error.message : String(error),
          };
        }
        return { project: stats.project, proposals, skipped: false };
      }
    );

    if (perProjectResults.some(result => result.skipped)) status = 'stopped';

    // 2. Gates, storage, project context and procedures.
    for (const result of perProjectResults) {
      if (result.failure) reject(result.project, `bootstrapper failed: ${result.failure}`);
      const stored: KnowledgeEntry[] = [];
      for (const proposal of result.proposals) {
        const gated = gateEntry(proposal, gateDeps);
        if ('rejected' in gated) {
          reject(proposal.slug, gated.rejected);
          continue;
        }
        try {
          const name = await insertKnowledgeEntry(dbs.store, gated.entry);
          const entry = await dbs.store.getEntry(name);
          if (entry) {
            // The adapter keeps citations as `cites` relations and does not
            // parse them back into `sources`; the gate's resolved sources are
            // the in-memory copy this run needs (project context, reflection).
            const withSources = { ...entry, sources: gated.entry.sources };
            stored.push(withSources);
            accepted.push(withSources);
          }
        } catch (error) {
          if (error instanceof DuplicateEntry) {
            reject(proposal.slug, 'duplicate');
            continue;
          }
          reject(proposal.slug, error instanceof Error ? error.message : String(error));
        }
      }

      if (stored.length > 0) await mirrorProjectContext(dbs.store, result.project, stored);

      // `insertKnowledgeEntry` already registers a procedure for a skill with
      // steps; this call is the explicit, idempotent statement of the rule so a
      // future change to the insert path cannot silently drop procedures.
      for (const entry of stored) {
        if (entry.kind !== 'skill' || !entry.steps || entry.steps.length === 0) continue;
        if (!entry.procedureId) continue;
        await dbs.store.putProcedure({
          id: entry.procedureId,
          name: entry.title,
          description: entry.description,
          steps: entry.steps,
          triggers: [entry.description, ...citedLines(entry).map(stripMarks)],
        });
      }
    }

    // 3. Merge the candidates into one global instruction.
    const candidateSkills = accepted.filter(entry => entry.kind === 'skill');
    if (candidateSkills.length > 0) {
      let merged: string[] = [];
      try {
        merged = mergeLines(await textModel(mergeInstructionPrompt(candidateSkills)));
      } catch (error) {
        merged = [];
        reject(
          BOOTSTRAP_INSTRUCTION_SLUG,
          `merge failed: ${error instanceof Error ? error.message : String(error)}`
        );
      }
      if (merged.length > 0) {
        const gated = gateEntry(
          {
            kind: 'instruction',
            project: '*',
            slug: BOOTSTRAP_INSTRUCTION_SLUG,
            title: 'Bootstrapped archive map',
            description: 'Which project holds what, which mode suits which question, and the terms to search.',
            body: merged.join('\n'),
            scope: 'all projects',
            confidence: 'medium',
          },
          gateDeps
        );
        if ('rejected' in gated) {
          reject(BOOTSTRAP_INSTRUCTION_SLUG, gated.rejected);
        } else {
          try {
            const name = await insertKnowledgeEntry(dbs.store, gated.entry);
            const entry = await dbs.store.getEntry(name);
            if (entry) accepted.push({ ...entry, sources: gated.entry.sources });
          } catch (error) {
            if (error instanceof DuplicateEntry) reject(BOOTSTRAP_INSTRUCTION_SLUG, 'duplicate');
            else reject(BOOTSTRAP_INSTRUCTION_SLUG, error instanceof Error ? error.message : String(error));
          }
        }
      }
    }

    // 4. Self-practice: generate tasks if the archive has none, then measure.
    if ((await countTasks(dbs.learning)) === 0) {
      try {
        await generateTasks(dbs.learning, dbs.index, {
          runId,
          seed,
          perProject,
          maxTasks: config.maxTasks,
          model: textModel,
        });
      } catch (error) {
        if (error instanceof BudgetExhausted) status = 'stopped';
        else reject('tasks', error instanceof Error ? error.message : String(error));
      }
    }
    checkTasks(dbs.learning, dbs.index);

    const signalTasks = signalTrainTasks(dbs.learning);
    const sample = signalTasks.map(task => task.id);
    const candidateNames = accepted.map(entry => entry.id);

    // The baseline precheck: the measurement solves the signal set twice, so a
    // run that cannot afford 2× the set would spend a bootstrapper's cost and
    // still have no verdict. Stop before that spend, keeping what was proposed.
    if (signalTasks.length * 2 > budget.remaining()) {
      status = 'stopped';
      reject(
        'baseline',
        `baseline needs ${signalTasks.length * 2} subprocess calls, above the ` +
          `${budget.remaining()} calls left of a ${budget.max}-call budget; stopped before measuring`
      );
    } else if (signalTasks.length > 0) {
      const solveOptions = {
        runId,
        role: 'solve' as const,
        model,
        pids: options.pids ?? { add() {}, remove() {} },
        runAgent: options.runAgent,
        judge: options.judge,
        budget,
      };

      try {
        const emptySnapshot = await createSnapshot(dbs.learning, runId, []);
        await solveMany(dbs, signalTasks, { ...solveOptions, snapshotId: emptySnapshot });
        before = passRate(dbs.learning, runId, emptySnapshot, { split: 'train', signalOnly: true });

        const activeNow = (await dbs.store.listByStatus(['active']))
          .filter(entry => entry.supersededBy === null)
          .map(entry => entry.id)
          .sort();
        const knowledgeSnapshot = await createSnapshot(dbs.learning, runId, [
          ...activeNow,
          ...candidateNames,
        ]);
        await solveMany(dbs, signalTasks, { ...solveOptions, snapshotId: knowledgeSnapshot });
        after = passRate(dbs.learning, runId, knowledgeSnapshot, { split: 'train', signalOnly: true });
      } catch (error) {
        if (!(error instanceof BudgetExhausted)) throw error;
        status = 'stopped';
        // Keep whichever side was measured; `passRate` reads the attempts that
        // did land, so a partial baseline is still an honest number.
        const snapshots = dbs.learning
          .prepare('SELECT id FROM knowledge_snapshot WHERE run_id = ? ORDER BY id')
          .all(runId) as Array<{ id: number }>;
        if (snapshots.length > 0) {
          before = passRate(dbs.learning, runId, Number(snapshots[0].id), {
            split: 'train',
            signalOnly: true,
          });
        }
        if (snapshots.length > 1) {
          after = passRate(dbs.learning, runId, Number(snapshots[snapshots.length - 1].id), {
            split: 'train',
            signalOnly: true,
          });
        }
      }
    }

    // 5. Activate per the gain rule and the approval mode.
    const verdict = bootstrapGain(before, after, config.minSavingPct);
    const validation = validationFor(before, after, sample);

    for (const entry of accepted) {
      if (!verdict.keep) {
        // An unmeasured verdict has no measurement to store. The candidate stays unvalidated, as in
        // validate.ts. `learn approve` refuses the candidate until a run measures the candidate.
        if (verdict.reason !== 'unmeasured') await dbs.store.setValidation(entry.id, validation);
        pending.push(entry.id);
        continue;
      }
      if (entry.kind === 'skill') {
        await activate(dbs.store, entry.id, validation, 'verified');
        activated.push(entry.id);
        continue;
      }
      // An instruction is always-loaded context: under the default mode a human
      // approves it, so the run leaves it a candidate with its measurement.
      if (config.approve === 'none') {
        await activate(dbs.store, entry.id, validation, 'verified');
        activated.push(entry.id);
      } else {
        await dbs.store.setValidation(entry.id, validation);
        pending.push(entry.id);
      }
    }

    // 6. One reflection, gated like everything else.
    await writeReflection(dbs, {
      runId,
      project: projects[0]?.project ?? '*',
      accepted,
      rejected,
      before,
      after,
      textModel,
      gateDeps,
      reject,
    });

    const finalTasks = signalTrainTasks(dbs.learning);
    finishRun(dbs.learning, runId, status, {
      projects: projects.length,
      proposed: accepted.length,
      activated: activated.length,
      pending: pending.length,
      rejected: rejected.length,
      signalTasks: finalTasks.length,
      byKindTier: kindTierTotals(finalTasks),
      before,
      after,
      gain: verdict,
      budgetUsed: budget.used,
    });
  } catch (error) {
    finishRun(dbs.learning, runId, 'failed', {
      projects: projects.length,
      proposed: accepted.length,
      rejected: rejected.length,
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }

  // Derived output, written last: every path that changes the active set does
  // this, and the hook reads what it wrote.
  await writeLearnedBlocks(dbs.store, dbs.learning, config.maxChars);

  return {
    runId,
    projects: projects.length,
    proposed: accepted.length,
    rejected,
    activated,
    pending,
    before,
    after,
    status,
  };
}

/** Drop a trailing `[#id,...]` mark group, leaving a line's prose. */
function stripMarks(line: string): string {
  return line
    .replace(/\s*\[(?:#[0-9a-f]{32}|@\d+)(?:\s*,\s*(?:#[0-9a-f]{32}|@\d+))*\]\s*$/, '')
    .trim();
}

interface ReflectionInput {
  runId: string;
  project: string;
  accepted: KnowledgeEntry[];
  rejected: Array<{ slug: string; reason: string }>;
  before: PassRate;
  after: PassRate;
  textModel: (prompt: string) => Promise<string>;
  gateDeps: Parameters<typeof gateEntry>[1];
  reject: (slug: string, reason: string) => void;
}

/** Task kinds for the attempts a reflection cites. Missing rows are omitted. */
function taskKinds(db: Database.Database, taskIds: number[]): Map<number, LearningKind> {
  const unique = [...new Set(taskIds)];
  if (unique.length === 0) return new Map();
  const rows = db
    .prepare(`SELECT id, kind FROM learning_task WHERE id IN (${unique.map(() => '?').join(',')})`)
    .all(...unique) as Array<{ id: number; kind: LearningKind }>;
  return new Map(rows.map(row => [Number(row.id), row.kind]));
}

/**
 * Write the run's reflection, citing the attempts and exchanges it saw.
 *
 * A reflection with no cited exchange cannot pass the gate. The gate drops a line that has
 * only `@` marks. So a run whose candidates cited nothing simply records no reflection rather
 * than storing an uncited one.
 */
async function writeReflection(dbs: LearnDbs, input: ReflectionInput): Promise<void> {
  const sources: SourceRef[] = [];
  const seen = new Set<string>();
  for (const entry of input.accepted) {
    for (const source of entry.sources) {
      if (seen.has(source.id)) continue;
      seen.add(source.id);
      sources.push(source);
    }
  }
  if (sources.length === 0) return;

  const attempts = listAttempts(dbs.learning, { runId: input.runId });
  const cited = attempts.slice(0, 20);
  const kinds = taskKinds(
    dbs.learning,
    cited.map(attempt => attempt.taskId)
  );
  const evidence = cited.map(attempt => ({
    attemptId: attempt.id,
    taskId: attempt.taskId,
    ...(kinds.has(attempt.taskId) ? { kind: kinds.get(attempt.taskId)! } : {}),
    passed: attempt.passed,
  }));

  let body: string[] = [];
  try {
    body = mergeLines(
      await input.textModel(
        reflectPrompt({
          runId: input.runId,
          project: input.project,
          kept: input.accepted.map(entry => entry.id),
          rejected: input.rejected,
          before: { passed: input.before.passed, total: input.before.total },
          after: { passed: input.after.passed, total: input.after.total },
          evidence,
          sources,
        })
      )
    );
  } catch (error) {
    body = [];
    input.reject(
      BOOTSTRAP_REFLECTION_SLUG,
      `reflection failed: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  if (body.length === 0) return;

  const gated = gateEntry(
    {
      kind: 'reflection',
      project: input.project,
      slug: BOOTSTRAP_REFLECTION_SLUG,
      title: 'Bootstrap reflection',
      description: 'What the bootstrap mapped, what it kept and what it refused.',
      body: body.join('\n'),
      scope: input.project === '*' ? 'all projects' : input.project,
      confidence: 'low',
    },
    input.gateDeps
  );
  if ('rejected' in gated) {
    input.reject(BOOTSTRAP_REFLECTION_SLUG, gated.rejected);
    return;
  }

  try {
    const name = await insertKnowledgeEntry(dbs.store, gated.entry);
    for (const attemptId of gated.attempts) {
      const attempt = attempts.find(candidate => candidate.id === attemptId);
      await dbs.store.citeAttempt(name, attemptId, attempt?.taskId ?? 0, input.runId);
    }
  } catch (error) {
    if (error instanceof DuplicateEntry) input.reject(BOOTSTRAP_REFLECTION_SLUG, 'duplicate');
    else input.reject(BOOTSTRAP_REFLECTION_SLUG, error instanceof Error ? error.message : String(error));
  }
}

