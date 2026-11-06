/**
 * The learning trace: runs, tasks and attempts, in `learning.sqlite`.
 *
 * `learning.sqlite` is the plugin's own database (spec §5.3), beside the
 * memoryjs knowledge store under `learned/`. This module owns the three
 * `learning_*` tables; `learning-store.ts` owns the file and calls
 * `ensureLearningSchema` from `migrateLearningSchema`.
 *
 * Two invariants shape the read paths:
 *
 * - `listTasks` is the **only** way tasks are read, and its `split` argument is
 *   mandatory. The `test` split is excluded from every learner prompt by this
 *   SQL predicate, never by convention (spec §7 rule 13).
 * - A `stale` task is excluded from reads and from every metric. A task going
 *   stale means its source address no longer resolves (a re-indexed session, a
 *   pruned project); scoring it as a failure would punish a solver for a moved
 *   file.
 *
 * Additive only: nothing here deletes a run, task or attempt.
 */
import { randomBytes } from 'crypto';
import { redactSecrets } from '../redact.js';
/** The kinds and tiers that carry the learning signal (spec §4.4, §7 rule 5). */
export const SIGNAL_KINDS = ['locate', 'when', 'multi'];
export const SIGNAL_TIERS = [2, 3];
/** Create the `learning_*` tables. Idempotent; called from `migrateLearningSchema`. */
export function ensureLearningSchema(db) {
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
 * Sortable by creation time to the second, and unique enough that two runs
 * started in the same second by different processes do not collide (the lock
 * makes that rare, but a crashed run leaves a stale lock).
 */
function newRunId(now) {
    return `run-${now.toISOString().replace(/[:.]/g, '')}-${randomBytes(3).toString('hex')}`;
}
export function createRun(db, input) {
    const id = newRunId(new Date());
    db.prepare(`INSERT INTO learning_run
       (id, phase, parent_run_id, project, status, started_at, finished_at, budget, metrics, seed, rejections)
     VALUES (?, ?, ?, ?, 'running', ?, NULL, ?, '{}', ?, '[]')`).run(id, input.phase, input.parentRunId ?? null, input.project ?? null, new Date().toISOString(), JSON.stringify(input.budget ?? {}), input.seed);
    return id;
}
export function finishRun(db, id, status, metrics = {}) {
    db.prepare('UPDATE learning_run SET status = ?, finished_at = ?, metrics = ? WHERE id = ?').run(status, new Date().toISOString(), JSON.stringify(metrics ?? {}), id);
}
export function addRejection(db, runId, rejection) {
    const row = db.prepare('SELECT rejections FROM learning_run WHERE id = ?').get(runId);
    if (!row)
        return;
    const list = parseJson(row.rejections, []);
    list.push({ slug: rejection.slug, reason: rejection.reason });
    db.prepare('UPDATE learning_run SET rejections = ? WHERE id = ?').run(JSON.stringify(list), runId);
}
function parseJson(raw, fallback) {
    if (typeof raw !== 'string' || !raw)
        return fallback;
    try {
        return JSON.parse(raw);
    }
    catch {
        return fallback;
    }
}
function runFromRow(row) {
    return {
        id: row.id,
        phase: row.phase,
        parentRunId: row.parent_run_id ?? null,
        project: row.project ?? null,
        status: row.status,
        startedAt: row.started_at,
        finishedAt: row.finished_at ?? null,
        budget: parseJson(row.budget, {}),
        metrics: parseJson(row.metrics, {}),
        seed: row.seed === null || row.seed === undefined ? null : Number(row.seed),
        rejections: parseJson(row.rejections, []),
    };
}
export function getRun(db, id) {
    const row = db.prepare('SELECT * FROM learning_run WHERE id = ?').get(id);
    return row ? runFromRow(row) : null;
}
/** The newest run by start time, or null when none exists. */
export function latestRun(db) {
    const row = db
        .prepare('SELECT * FROM learning_run ORDER BY started_at DESC, rowid DESC LIMIT 1')
        .get();
    return row ? runFromRow(row) : null;
}
export function insertTask(db, task) {
    const info = db
        .prepare(`INSERT INTO learning_task (run_id, kind, tier, split, project, prompt, truth, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(task.runId, task.kind, task.tier, task.split, task.project, task.prompt, JSON.stringify(task.truth), task.status);
    return Number(info.lastInsertRowid);
}
function taskFromRow(row) {
    return {
        id: row.id,
        runId: row.run_id,
        kind: row.kind,
        tier: Number(row.tier),
        split: row.split,
        project: row.project,
        prompt: row.prompt,
        truth: parseJson(row.truth, {
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
 * held-out split. Stale rows are excluded unless `includeStale` is set (the
 * `--check` command and `learn report` want to see them).
 */
export function listTasks(db, options) {
    const where = ['split = ?'];
    const params = [options.split];
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
    }
    else if (options.kinds && options.kinds.length === 0) {
        return [];
    }
    if (options.tiers && options.tiers.length > 0) {
        where.push(`tier IN (${options.tiers.map(() => '?').join(',')})`);
        params.push(...options.tiers);
    }
    else if (options.tiers && options.tiers.length === 0) {
        return [];
    }
    if (options.ids) {
        if (options.ids.length === 0)
            return [];
        where.push(`id IN (${options.ids.map(() => '?').join(',')})`);
        params.push(...options.ids);
    }
    const rows = db
        .prepare(`SELECT * FROM learning_task WHERE ${where.join(' AND ')} ORDER BY id`)
        .all(...params);
    return rows.map(taskFromRow);
}
/** Mark tasks stale. Additive: the row stays, and `includeStale` can still read it. */
export function markStale(db, ids) {
    if (ids.length === 0)
        return;
    const stmt = db.prepare("UPDATE learning_task SET status = 'stale' WHERE id = ?");
    const run = db.transaction((list) => {
        for (const id of list)
            stmt.run(id);
    });
    run(ids);
}
/** `learning_attempt.answer` is redacted and capped, so one runaway answer cannot bloat the trace. */
export const MAX_ANSWER_CHARS = 4000;
export function insertAttempt(db, attempt) {
    const answer = redactSecrets(String(attempt.answer ?? '')).slice(0, MAX_ANSWER_CHARS);
    const info = db
        .prepare(`INSERT INTO learning_attempt
         (task_id, run_id, snapshot_id, role, passed, score, answer, trace, cost, outcome, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(attempt.taskId, attempt.runId, attempt.snapshotId, attempt.role, attempt.passed ? 1 : 0, attempt.score, answer, JSON.stringify(attempt.trace ?? []), JSON.stringify(attempt.cost ?? {}), attempt.outcome, new Date().toISOString());
    return Number(info.lastInsertRowid);
}
function attemptFromRow(row) {
    return {
        id: row.id,
        taskId: row.task_id,
        runId: row.run_id,
        snapshotId: Number(row.snapshot_id),
        role: row.role,
        passed: Boolean(row.passed),
        score: Number(row.score),
        answer: row.answer,
        trace: parseJson(row.trace, []),
        cost: parseJson(row.cost, { turns: 0, inputTokens: 0, outputTokens: 0, usd: null }),
        outcome: row.outcome,
        createdAt: row.created_at,
    };
}
export function listAttempts(db, options) {
    const where = ['run_id = ?'];
    const params = [options.runId];
    if (options.taskIds) {
        if (options.taskIds.length === 0)
            return [];
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
export function attemptsExist(db, ids) {
    if (ids.length === 0)
        return false;
    const rows = db
        .prepare(`SELECT DISTINCT id FROM learning_attempt WHERE id IN (${ids.map(() => '?').join(',')})`)
        .all(...ids);
    return rows.length === ids.length;
}
/**
 * The pass rate of one snapshot of one run.
 *
 * Counts the **newest graded attempt per task**, so a task re-solved later in the
 * round supersedes its own earlier attempt rather than double-counting. Tasks
 * from the other split and stale tasks never contribute. `signalOnly` restricts
 * the count to `locate`/`when`/`multi` at tiers 2 and 3 — the metric that
 * decides whether an edit is kept (spec §7 rule 5).
 */
export function passRate(db, runId, snapshotId, options) {
    const where = ['a.run_id = ?', 'a.snapshot_id = ?', "a.outcome = 'graded'", 't.split = ?', "t.status = 'ok'"];
    const params = [runId, snapshotId, options.split];
    if (options.signalOnly) {
        where.push(`t.kind IN (${SIGNAL_KINDS.map(() => '?').join(',')})`);
        params.push(...SIGNAL_KINDS);
        where.push(`t.tier IN (${SIGNAL_TIERS.map(() => '?').join(',')})`);
        params.push(...SIGNAL_TIERS);
    }
    const rows = db
        .prepare(`SELECT t.kind AS kind, t.tier AS tier, a.passed AS passed, a.cost AS cost
         FROM learning_attempt a
         JOIN learning_task t ON t.id = a.task_id
        WHERE ${where.join(' AND ')}
          AND a.id = (
            SELECT MAX(a2.id) FROM learning_attempt a2
             WHERE a2.task_id = a.task_id AND a2.run_id = a.run_id
               AND a2.snapshot_id = a.snapshot_id AND a2.outcome = 'graded'
          )
        ORDER BY a.id`)
        .all(...params);
    const byKindTier = {};
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
        const cost = parseJson(row.cost, { turns: 0, inputTokens: 0, outputTokens: 0, usd: null });
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
