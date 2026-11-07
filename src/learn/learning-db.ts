/**
 * The learning trace: runs, tasks and attempts, in `learning.sqlite`.
 *
 * `learning.sqlite` is the plugin's own database (spec §5.3), beside the
 * knowledge store (`knowledge.db`) under `learned/`. This module owns the three
 * `learning_*` tables; `learning-store.ts` owns the file and calls
 * `ensureLearningSchema` from `migrateLearningSchema`.
 *
 * Two invariants shape the read paths:
 *
 * - `listTasks` is the **only** read path for tasks, and its `split` argument is
 *   mandatory. The SQL predicate keeps the `test` split out of every learner
 *   prompt, never by convention (spec §7 rule 13).
 * - The reads and every metric skip a `stale` task. A task goes stale when its
 *   source address does not resolve (a re-indexed session, a pruned project).
 *   Scoring it as a failure punishes a solver for a moved file.
 *
 * Additive only: nothing here deletes a run, task or attempt.
 */

import type Database from 'better-sqlite3';
import { randomBytes } from 'crypto';
import { redactSecrets } from '../redact.js';
import type {
  AttemptOutcome,
  AttemptRow,
  Cost,
  LearningKind,
  LearningTier,
  TaskStatus,
  TaskTruth,
  TraceStep,
} from './types.js';

/** One generated task, as `learning_task` stores it. */
export interface LearningTask {
  id: number;
  runId: string;
  kind: LearningKind;
  tier: LearningTier;
  split: 'train' | 'test';
  project: string;
  prompt: string;
  truth: TaskTruth;
  status: TaskStatus;
}

/** One run's rejection, as `learn report` prints it. */
export interface RunRejection {
  slug: string;
  reason: string;
}

/** `learning_run`, as read back. */
export interface LearningRun {
  id: string;
  phase: 'bootstrap' | 'improve';
  parentRunId: string | null;
  project: string | null;
  status: 'running' | 'done' | 'stopped' | 'failed' | 'deferred';
  startedAt: string;
  finishedAt: string | null;
  budget: Record<string, unknown>;
  metrics: Record<string, unknown>;
  seed: number | null;
  rejections: RunRejection[];
}

/** The input of createRun. */
export interface CreateRunInput {
  phase: 'bootstrap' | 'improve';
  /** The id of the parent run. Stored as NULL when omitted. */
  parentRunId?: string;
  /** The project that the run covers. Stored as NULL when omitted. */
  project?: string;
  seed: number;
  /** The budget of the run. Stored as JSON. */
  budget: Record<string, unknown>;
}

/** Options for listTasks. */
export interface ListTasksOptions {
  split: 'train' | 'test';
  project?: string;
  kinds?: LearningKind[];
  tiers?: LearningTier[];
  ids?: number[];
  /** Include rows `checkTasks` marked stale. Default false. */
  includeStale?: boolean;
}

/** Options for listAttempts. */
export interface ListAttemptsOptions {
  runId: string;
  /** Only the attempts of these tasks. An empty list returns no attempts. */
  taskIds?: number[];
  role?: AttemptRow['role'];
  /** Only this outcome. `'graded'` is the common case: only graded attempts count. */
  outcome?: AttemptOutcome;
}

/**
 * The pass counts and cost of one run on one snapshot.
 *
 * Each task counts once, from its latest graded attempt. `byKindTier` uses the key `kind:tier`.
 */
export interface PassRate {
  /** The number of counted tasks that passed. */
  passed: number;
  /** The number of counted tasks. */
  total: number;
  /** The mean number of turns per counted task. Zero when no task counts. */
  meanTurns: number;
  /** The sum of the recorded cost in US dollars. */
  usd: number;
  /** The pass counts for each `kind:tier` cell. */
  byKindTier: Record<string, { passed: number; total: number }>;
}

/**
 * The task kinds that carry the learning signal (spec §4.4, §7 rule 5).
 * `passRate` uses them when the caller sets `signalOnly`. Callers of `listTasks` pass them to select the training tasks.
 */
export const SIGNAL_KINDS: LearningKind[] = ['locate', 'when', 'multi'];
/** The task tiers that carry the learning signal. `passRate` uses them when the caller sets `signalOnly`. Callers of `listTasks` pass them with `SIGNAL_KINDS`. */
export const SIGNAL_TIERS: LearningTier[] = [2, 3];

/** Create the `learning_*` tables. Idempotent; called from `migrateLearningSchema`. */
export function ensureLearningSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS learning_run (
      id TEXT PRIMARY KEY,
      phase TEXT NOT NULL,
      parent_run_id TEXT,
      project TEXT,
      status TEXT NOT NULL,
      started_at TEXT NOT NULL,
      finished_at TEXT,
      budget TEXT NOT NULL DEFAULT '{}',
      metrics TEXT NOT NULL DEFAULT '{}',
      seed INTEGER,
      rejections TEXT NOT NULL DEFAULT '[]'
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS learning_task (
      id INTEGER PRIMARY KEY,
      run_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      tier INTEGER NOT NULL,
      split TEXT NOT NULL,
      project TEXT NOT NULL,
      prompt TEXT NOT NULL,
      truth TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'ok'
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS learning_attempt (
      id INTEGER PRIMARY KEY,
      task_id INTEGER NOT NULL,
      run_id TEXT NOT NULL,
      snapshot_id INTEGER NOT NULL,
      role TEXT NOT NULL,
      passed INTEGER NOT NULL,
      score REAL NOT NULL,
      answer TEXT NOT NULL,
      trace TEXT NOT NULL DEFAULT '[]',
      cost TEXT NOT NULL DEFAULT '{}',
      outcome TEXT NOT NULL,
      created_at TEXT NOT NULL
    )
  `);

  db.exec('CREATE INDEX IF NOT EXISTS idx_learning_task_split ON learning_task(split, status)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_learning_task_run ON learning_task(run_id)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_learning_attempt_run ON learning_attempt(run_id)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_learning_attempt_task ON learning_attempt(task_id)');
}

/**
 * A run id: `run-<iso timestamp>-<random>`.
 *
 * The id sorts by creation time to the millisecond. The random suffix keeps two
 * runs that start in the same millisecond by different processes apart. The lock
 * makes that case rare, but a crashed run leaves a stale lock.
 */
function newRunId(now: Date): string {
  return `run-${now.toISOString().replace(/[:.]/g, '')}-${randomBytes(3).toString('hex')}`;
}

/**
 * Create a run in the `running` state and return its id.
 *
 * The function sets the start time to the current time and stores the budget as JSON.
 */
export function createRun(db: Database.Database, input: CreateRunInput): string {
  const id = newRunId(new Date());
  db.prepare(
    `INSERT INTO learning_run
       (id, phase, parent_run_id, project, status, started_at, finished_at, budget, metrics, seed, rejections)
     VALUES (?, ?, ?, ?, 'running', ?, NULL, ?, '{}', ?, '[]')`
  ).run(
    id,
    input.phase,
    input.parentRunId ?? null,
    input.project ?? null,
    new Date().toISOString(),
    JSON.stringify(input.budget ?? {}),
    input.seed
  );
  return id;
}

/**
 * Set the status of a run, its finish time and its metrics.
 *
 * The function sets the finish time to the current time and stores the metrics as JSON.
 */
export function finishRun(
  db: Database.Database,
  id: string,
  status: LearningRun['status'],
  metrics: Record<string, unknown> = {}
): void {
  db.prepare('UPDATE learning_run SET status = ?, finished_at = ?, metrics = ? WHERE id = ?').run(
    status,
    new Date().toISOString(),
    JSON.stringify(metrics ?? {}),
    id
  );
}

/**
 * Append one rejection to the rejections list of a run.
 *
 * The function does nothing when no run has the id.
 */
export function addRejection(
  db: Database.Database,
  runId: string,
  rejection: RunRejection
): void {
  const row = db.prepare('SELECT rejections FROM learning_run WHERE id = ?').get(runId) as
    | { rejections: string }
    | undefined;
  if (!row) return;
  const list = parseJson<RunRejection[]>(row.rejections, []);
  list.push({ slug: rejection.slug, reason: rejection.reason });
  db.prepare('UPDATE learning_run SET rejections = ? WHERE id = ?').run(JSON.stringify(list), runId);
}

function parseJson<T>(raw: unknown, fallback: T): T {
  if (typeof raw !== 'string' || !raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function runFromRow(row: any): LearningRun {
  return {
    id: row.id,
    phase: row.phase,
    parentRunId: row.parent_run_id ?? null,
    project: row.project ?? null,
    status: row.status,
    startedAt: row.started_at,
    finishedAt: row.finished_at ?? null,
    budget: parseJson<Record<string, unknown>>(row.budget, {}),
    metrics: parseJson<Record<string, unknown>>(row.metrics, {}),
    seed: row.seed === null || row.seed === undefined ? null : Number(row.seed),
    rejections: parseJson<RunRejection[]>(row.rejections, []),
  };
}

/** Return the run with this id, or null when no run has the id. */
export function getRun(db: Database.Database, id: string): LearningRun | null {
  const row = db.prepare('SELECT * FROM learning_run WHERE id = ?').get(id);
  return row ? runFromRow(row) : null;
}

/** The newest run by start time, or null when none exists. */
export function latestRun(db: Database.Database): LearningRun | null {
  const row = db
    .prepare('SELECT * FROM learning_run ORDER BY started_at DESC, rowid DESC LIMIT 1')
    .get();
  return row ? runFromRow(row) : null;
}

/** Insert one task row and return the new task id. */
export function insertTask(
  db: Database.Database,
  task: Omit<LearningTask, 'id'>
): number {
  const info = db
    .prepare(
      `INSERT INTO learning_task (run_id, kind, tier, split, project, prompt, truth, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      task.runId,
      task.kind,
      task.tier,
      task.split,
      task.project,
      task.prompt,
      JSON.stringify(task.truth),
      task.status
    );
  return Number(info.lastInsertRowid);
}

function taskFromRow(row: any): LearningTask {
  return {
    id: row.id,
    runId: row.run_id,
    kind: row.kind,
    tier: Number(row.tier) as LearningTask['tier'],
    split: row.split,
    project: row.project,
    prompt: row.prompt,
    truth: parseJson<TaskTruth>(row.truth, {
      exchanges: [],
      sessionDateRange: ['', ''],
      project: row.project,
      assistantMessage: '',
    }),
    status: row.status,
  };
}

/**
 * The only task read path.
 *
 * `split` is mandatory, so no caller can accidentally hand a learner the
 * held-out split. The function excludes stale rows unless the caller sets
 * `includeStale`. The `--check` command and `learn report` want to see them.
 */
export function listTasks(db: Database.Database, options: ListTasksOptions): LearningTask[] {
  const where = ['split = ?'];
  const params: unknown[] = [options.split];
  if (!options.includeStale) {
    where.push("status = 'ok'");
  }
  if (options.project !== undefined) {
    where.push('project = ?');
    params.push(options.project);
  }
  if (options.kinds && options.kinds.length > 0) {
    where.push(`kind IN (${options.kinds.map(() => '?').join(',')})`);
    params.push(...options.kinds);
  } else if (options.kinds && options.kinds.length === 0) {
    return [];
  }
  if (options.tiers && options.tiers.length > 0) {
    where.push(`tier IN (${options.tiers.map(() => '?').join(',')})`);
    params.push(...options.tiers);
  } else if (options.tiers && options.tiers.length === 0) {
    return [];
  }
  if (options.ids) {
    if (options.ids.length === 0) return [];
    where.push(`id IN (${options.ids.map(() => '?').join(',')})`);
    params.push(...options.ids);
  }

  const rows = db
    .prepare(`SELECT * FROM learning_task WHERE ${where.join(' AND ')} ORDER BY id`)
    .all(...params);
  return rows.map(taskFromRow);
}

/** Mark tasks stale. Additive: the row stays, and `includeStale` can still read it. */
export function markStale(db: Database.Database, ids: number[]): void {
  if (ids.length === 0) return;
  const stmt = db.prepare("UPDATE learning_task SET status = 'stale' WHERE id = ?");
  const run = db.transaction((list: number[]) => {
    for (const id of list) stmt.run(id);
  });
  run(ids);
}

/** `insertAttempt` redacts `learning_attempt.answer` and shortens it to `MAX_ANSWER_CHARS` characters, so one runaway answer cannot bloat the trace. */
export const MAX_ANSWER_CHARS = 4000;

/**
 * Insert one attempt row and return the new attempt id.
 *
 * The function redacts the answer, caps its length and stamps the creation time.
 */
export function insertAttempt(db: Database.Database, attempt: Omit<AttemptRow, 'id' | 'createdAt'>): number {
  const answer = redactSecrets(String(attempt.answer ?? '')).slice(0, MAX_ANSWER_CHARS);
  const info = db
    .prepare(
      `INSERT INTO learning_attempt
         (task_id, run_id, snapshot_id, role, passed, score, answer, trace, cost, outcome, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      attempt.taskId,
      attempt.runId,
      attempt.snapshotId,
      attempt.role,
      attempt.passed ? 1 : 0,
      attempt.score,
      answer,
      JSON.stringify(attempt.trace ?? []),
      JSON.stringify(attempt.cost ?? {}),
      attempt.outcome,
      new Date().toISOString()
    );
  return Number(info.lastInsertRowid);
}

function attemptFromRow(row: any): AttemptRow {
  return {
    id: row.id,
    taskId: row.task_id,
    runId: row.run_id,
    snapshotId: Number(row.snapshot_id),
    role: row.role,
    passed: Boolean(row.passed),
    score: Number(row.score),
    answer: row.answer,
    trace: parseJson<TraceStep[]>(row.trace, []),
    cost: parseJson<Cost>(row.cost, { turns: 0, inputTokens: 0, outputTokens: 0, usd: null }),
    outcome: row.outcome,
    createdAt: row.created_at,
  };
}

/**
 * Return the attempts of one run that match the options. An empty `taskIds` list returns no attempts.
 */
export function listAttempts(db: Database.Database, options: ListAttemptsOptions): AttemptRow[] {
  const where = ['run_id = ?'];
  const params: unknown[] = [options.runId];
  if (options.taskIds) {
    if (options.taskIds.length === 0) return [];
    where.push(`task_id IN (${options.taskIds.map(() => '?').join(',')})`);
    params.push(...options.taskIds);
  }
  if (options.role) {
    where.push('role = ?');
    params.push(options.role);
  }
  if (options.outcome) {
    where.push('outcome = ?');
    params.push(options.outcome);
  }
  const rows = db
    .prepare(`SELECT * FROM learning_attempt WHERE ${where.join(' AND ')} ORDER BY id`)
    .all(...params);
  return rows.map(attemptFromRow);
}

/** True only when every id names a stored attempt (and the list is non-empty). */
export function attemptsExist(db: Database.Database, ids: number[]): boolean {
  if (ids.length === 0) return false;
  const rows = db
    .prepare(
      `SELECT DISTINCT id FROM learning_attempt WHERE id IN (${ids.map(() => '?').join(',')})`
    )
    .all(...ids) as Array<{ id: number }>;
  return rows.length === ids.length;
}

/**
 * The pass rate of one snapshot of one run.
 *
 * Counts the **newest graded attempt per task**. So a task re-solved later in the round
 * supersedes its own earlier attempt rather than double-counting. Tasks from the other split and
 * stale tasks never contribute. `signalOnly` restricts the count to `locate`/`when`/`multi` at
 * tiers 2 and 3. The metric decides whether to keep an edit (spec §7 rule 5).
 */
export function passRate(
  db: Database.Database,
  runId: string,
  snapshotId: number,
  options: { split: 'train' | 'test'; signalOnly: boolean }
): PassRate {
  const where = ['a.run_id = ?', 'a.snapshot_id = ?', "a.outcome = 'graded'", 't.split = ?', "t.status = 'ok'"];
  const params: unknown[] = [runId, snapshotId, options.split];
  if (options.signalOnly) {
    where.push(`t.kind IN (${SIGNAL_KINDS.map(() => '?').join(',')})`);
    params.push(...SIGNAL_KINDS);
    where.push(`t.tier IN (${SIGNAL_TIERS.map(() => '?').join(',')})`);
    params.push(...SIGNAL_TIERS);
  }

  const rows = db
    .prepare(
      `SELECT t.kind AS kind, t.tier AS tier, a.passed AS passed, a.cost AS cost
         FROM learning_attempt a
         JOIN learning_task t ON t.id = a.task_id
        WHERE ${where.join(' AND ')}
          AND a.id = (
            SELECT MAX(a2.id) FROM learning_attempt a2
             WHERE a2.task_id = a.task_id AND a2.run_id = a.run_id
               AND a2.snapshot_id = a.snapshot_id AND a2.outcome = 'graded'
          )
        ORDER BY a.id`
    )
    .all(...params) as Array<{ kind: string; tier: number; passed: number; cost: string }>;

  const byKindTier: Record<string, { passed: number; total: number }> = {};
  let passed = 0;
  let turns = 0;
  let usd = 0;
  for (const row of rows) {
    const key = `${row.kind}:${row.tier}`;
    const cell = byKindTier[key] ?? { passed: 0, total: 0 };
    cell.total += 1;
    if (row.passed) {
      cell.passed += 1;
      passed += 1;
    }
    byKindTier[key] = cell;
    const cost = parseJson<Cost>(row.cost, { turns: 0, inputTokens: 0, outputTokens: 0, usd: null });
    turns += Number(cost.turns) || 0;
    usd += Number(cost.usd) || 0;
  }

  const total = rows.length;
  return {
    passed,
    total,
    meanTurns: total === 0 ? 0 : turns / total,
    usd,
    byKindTier,
  };
}
