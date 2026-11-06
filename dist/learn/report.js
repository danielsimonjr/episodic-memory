/**
 * `learn report`: what a run changed, what it cost, and what it refused.
 *
 * A report is built from the trace (`learning.sqlite`) and the store, and it is
 * deliberately blunt: the numbers a run is judged by (pass rate per split and
 * tier, before and after) sit beside the entries the run kept, the candidates a
 * human still has to approve, and every rejection with the gate that produced
 * it. A run that rejected everything is not a failure to hide — it is the
 * feature working, and the report says so in the same place it says how much
 * was spent.
 *
 * "Before" and "after" are the first and last snapshot of the run: the solver's
 * knowledge is `K^(t)`, and the two ends of the snapshot sequence are the only
 * comparison the trace can support without assuming which edit landed when. A
 * run with a single snapshot reports the same rate on both sides, because a
 * fabricated "before" of zero would read as a spectacular gain.
 */
import { getRun, latestRun, listAttempts, passRate, } from './learning-db.js';
import { listActive, listCandidates } from './knowledge-db.js';
/** The run's snapshots, oldest first. */
function snapshotIds(db, runId) {
    const rows = db
        .prepare('SELECT id FROM knowledge_snapshot WHERE run_id = ? ORDER BY id')
        .all(runId);
    return rows.map(row => Number(row.id));
}
function emptyRate() {
    return { passed: 0, total: 0, meanTurns: 0, usd: 0, byKindTier: {} };
}
function splitReport(db, runId, snapshots, split) {
    if (snapshots.length === 0) {
        const rate = emptyRate();
        return { before: rate, after: rate, byKindTier: {} };
    }
    const firstId = snapshots[0];
    const lastId = snapshots[snapshots.length - 1];
    const before = passRate(db, runId, firstId, { split, signalOnly: false });
    const after = firstId === lastId ? before : passRate(db, runId, lastId, { split, signalOnly: false });
    const keys = new Set([...Object.keys(before.byKindTier), ...Object.keys(after.byKindTier)]);
    const byKindTier = {};
    for (const key of [...keys].sort()) {
        byKindTier[key] = {
            before: before.byKindTier[key] ?? { passed: 0, total: 0 },
            after: after.byKindTier[key] ?? { passed: 0, total: 0 },
        };
    }
    return { before, after, byKindTier };
}
function usedCalls(db, runId) {
    const row = db.prepare('SELECT COUNT(*) AS n FROM learning_attempt WHERE run_id = ?').get(runId);
    return Number(row?.n ?? 0);
}
function budgetNumber(budget, key) {
    const value = budget[key];
    const parsed = typeof value === 'number' ? value : Number(value);
    return Number.isFinite(parsed) ? parsed : null;
}
/**
 * Build the report for one run.
 *
 * Async because the store-backed halves (`kept`, `pending`, `reflections`) come
 * from the knowledge store, whose methods return promises.
 */
export async function buildReport(dbs, runId) {
    const run = getRun(dbs.learning, runId);
    if (!run)
        throw new Error(`no such learning run: ${runId}`);
    const snapshots = snapshotIds(dbs.learning, runId);
    const project = run.project ?? '*';
    const childRows = dbs.learning
        .prepare('SELECT id FROM learning_run WHERE parent_run_id = ? ORDER BY started_at, rowid')
        .all(runId);
    const usedUsd = listAttempts(dbs.learning, { runId }).reduce((sum, attempt) => {
        const usd = Number(attempt.cost?.usd ?? 0);
        return sum + (Number.isFinite(usd) ? usd : 0);
    }, 0);
    const active = await listActive(dbs.store, ['instruction', 'skill'], project);
    const candidates = await listCandidates(dbs.store);
    // Reflections are recorded as the run writes them and are not activated by
    // anything, so the report reads them by kind and status rather than by
    // `listActive` — a reflection that never left `candidate` is still this run's
    // memory of what it learned.
    const reflections = (await dbs.store.listByStatus(['candidate', 'active', 'retired'], ['reflection'])).filter(entry => entry.project === project || entry.project === '*' || entry.runId === runId);
    return {
        run,
        train: splitReport(dbs.learning, runId, snapshots, 'train'),
        test: splitReport(dbs.learning, runId, snapshots, 'test'),
        kept: active,
        pending: candidates.filter(entry => entry.project === project || entry.project === '*'),
        rejected: run.rejections,
        budget: {
            maxCalls: budgetNumber(run.budget, 'maxCalls'),
            usedCalls: usedCalls(dbs.learning, runId),
            maxUsd: budgetNumber(run.budget, 'maxUsd'),
            usedUsd,
        },
        childRuns: childRows
            .map(row => getRun(dbs.learning, row.id))
            .filter((child) => child !== null),
        reflections,
        merges: mergesOf(run),
    };
}
/** The merges a run recorded in its metrics, or an empty list. */
function mergesOf(run) {
    const raw = run.metrics?.merges;
    if (!Array.isArray(raw))
        return [];
    return raw
        .filter((value) => Boolean(value) && typeof value === 'object')
        .map(value => ({
        key: String(value.key ?? ''),
        merged: String(value.merged ?? ''),
        sources: Array.isArray(value.sources) ? value.sources.map(String) : [],
        revertedTo: value.revertedTo === null || value.revertedTo === undefined ? null : String(value.revertedTo),
        regressions: Array.isArray(value.regressions) ? value.regressions.map(Number) : [],
    }));
}
/** The latest run id, for a CLI that was given no `--run`. */
export function latestRunId(db) {
    return latestRun(db)?.id ?? null;
}
// ---------------------------------------------------------------------------
// text
// ---------------------------------------------------------------------------
function ratio(rate) {
    return `${rate.passed}/${rate.total}`;
}
function pct(rate) {
    if (rate.total === 0)
        return 'n/a';
    return `${Math.round((rate.passed / rate.total) * 100)}%`;
}
function splitLines(label, split) {
    const lines = [
        `${label}: ${ratio(split.before)} before (${pct(split.before)}), ${ratio(split.after)} after (${pct(split.after)})`,
    ];
    for (const key of Object.keys(split.byKindTier).sort()) {
        const cell = split.byKindTier[key];
        lines.push(`  ${key}: ${cell.before.passed}/${cell.before.total} before, ${cell.after.passed}/${cell.after.total} after`);
    }
    return lines;
}
/** Render a model as a human report or as JSON. */
export function formatReport(model, json) {
    if (json)
        return JSON.stringify(model, null, 2);
    const run = model.run;
    const lines = [];
    lines.push(`run ${run.id}`);
    lines.push(`phase ${run.phase}${run.project ? ` · project ${run.project}` : ''} · status ${run.status}`);
    lines.push(`started ${run.startedAt}${run.finishedAt ? ` · finished ${run.finishedAt}` : ''}`);
    lines.push('');
    lines.push(...splitLines('train', model.train));
    lines.push(...splitLines('test', model.test));
    lines.push('');
    lines.push(`budget: ${model.budget.usedCalls}/${model.budget.maxCalls ?? '?'} calls` +
        (model.budget.maxUsd !== null ? `, $${model.budget.usedUsd.toFixed(2)}/$${model.budget.maxUsd}` : ''));
    lines.push('');
    lines.push(`kept (${model.kept.length}):`);
    for (const entry of model.kept)
        lines.push(`  ${entry.kind} ${entry.project}/${entry.slug} v${entry.version}`);
    if (model.kept.length === 0)
        lines.push('  none');
    lines.push('');
    lines.push(`awaiting approval (${model.pending.length}):`);
    for (const entry of model.pending)
        lines.push(`  ${entry.kind} ${entry.project}/${entry.slug} v${entry.version}`);
    if (model.pending.length === 0)
        lines.push('  none');
    lines.push('');
    lines.push(`rejected (${model.rejected.length}):`);
    for (const rejection of model.rejected)
        lines.push(`  ${rejection.slug}: ${rejection.reason}`);
    if (model.rejected.length === 0)
        lines.push('  none');
    lines.push('');
    lines.push(`child runs (${model.childRuns.length}):`);
    for (const child of model.childRuns) {
        const metrics = child.metrics ?? {};
        const kept = metrics.kept === undefined ? '' : ` · ${String(metrics.kept)} kept`;
        const rejected = metrics.rejected === undefined ? '' : ` · ${String(metrics.rejected)} rejected`;
        lines.push(`  ${child.id} · ${child.phase} · ${child.status}${child.project ? ` · ${child.project}` : ''}${kept}${rejected}`);
    }
    if (model.childRuns.length === 0)
        lines.push('  none');
    lines.push('');
    lines.push(`merges (${model.merges.length}):`);
    for (const merge of model.merges) {
        const outcome = merge.revertedTo
            ? `reverted to ${merge.revertedTo} after regressing ${merge.regressions.join(', ')}`
            : 'kept';
        lines.push(`  ${merge.merged} · ${merge.sources.length} source(s) · ${outcome}`);
    }
    if (model.merges.length === 0)
        lines.push('  none');
    lines.push('');
    lines.push(`reflections (${model.reflections.length}):`);
    for (const reflection of model.reflections) {
        lines.push(`  ${reflection.project}/${reflection.slug}: ${reflection.description}`);
    }
    if (model.reflections.length === 0)
        lines.push('  none');
    return lines.join('\n') + '\n';
}
