/**
 * Validation: does a candidate edit actually earn its place?
 *
 * The decision is made in Node, never in the model (spec §6.2 step 4, §7 rule 5).
 * A candidate is kept only when at least one task it targeted now passes **and**
 * no task that passed before starts failing. Anything else — no gain, a
 * regression, an unmeasurable run — leaves the row a candidate: it is written
 * down, never deleted, and `learn status` lists it as awaiting approval.
 *
 * The evaluation snapshot is `K^(t)` with the candidate applied: every currently
 * active not-superseded entry, minus the version this candidate supersedes, plus
 * the candidate. Without the subtraction a revision would be scored against
 * itself.
 *
 * Additive only: nothing here deletes an entry or an attempt.
 */
import { learnConfig } from './learn-config.js';
import { activate, createSnapshot, getBySlug, getEntry, entryName, } from './knowledge-db.js';
import { listAttempts, listTasks } from './learning-db.js';
import { writeLearnedBlocks } from './learned-block.js';
/** Where a run records the subprocesses it owns. */
const NO_PIDS = { add() { }, remove() { } };
/** A deterministic 32-bit generator, so a seed picks the same sample twice. */
function mulberry32(seed) {
    let state = seed >>> 0;
    return () => {
        state = (state + 0x6d2b79f5) >>> 0;
        let t = state;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}
/**
 * A seeded sample of `ids`, without replacement, in a stable order.
 *
 * Sorting first makes the sample a function of `(ids, size, seed)` alone, so a
 * rerun with the same seed validates the same tasks.
 */
export function sampleIds(ids, size, seed) {
    const unique = [...new Set(ids)].sort((a, b) => a - b);
    const wanted = Math.max(0, Math.min(Math.floor(size), unique.length));
    if (wanted === 0)
        return [];
    const random = mulberry32(seed);
    const pool = [...unique];
    const picked = [];
    while (picked.length < wanted) {
        const index = Math.floor(random() * pool.length);
        picked.push(pool.splice(index, 1)[0]);
    }
    return picked.sort((a, b) => a - b);
}
function totalsOf(pairs) {
    const totals = { passed: 0, turns: 0, usd: 0, measured: 0 };
    for (const pair of pairs) {
        if (pair.passed)
            totals.passed += 1;
        if (!pair.attempt)
            continue;
        totals.measured += 1;
        totals.turns += Number(pair.attempt.cost?.turns) || 0;
        totals.usd += Number(pair.attempt.cost?.usd) || 0;
    }
    return totals;
}
function mean(total, count) {
    return count === 0 ? null : total / count;
}
/** Every active, not-superseded entry name in the store, sorted. */
async function activeNames(dbs) {
    const entries = await dbs.store.listByStatus(['active']);
    return entries
        .filter(entry => entry.supersededBy === null)
        .map(entry => entry.id)
        .sort();
}
/**
 * The snapshot the candidate is scored in.
 *
 * Active entries, with the version this candidate supersedes removed: for a
 * revision that is the previous version of the same key (the chain head before
 * the candidate was inserted). Comparing against a snapshot that still held the
 * old version would measure both at once.
 */
async function evaluationSnapshot(dbs, entry, runId) {
    const names = await activeNames(dbs);
    const superseded = [];
    if (entry.version > 1) {
        superseded.push(entryName(entry.kind, entry.project, entry.slug, entry.version - 1));
    }
    const chain = await getBySlug(dbs.store, entry.kind, entry.project, entry.slug);
    if (chain && chain.id !== entry.id && chain.status === 'active')
        superseded.push(chain.id);
    const removed = new Set(superseded);
    const kept = names.filter(name => !removed.has(name) &&
        // Belt and braces: any active version of the same key is what this
        // candidate replaces, whatever the version arithmetic says.
        !(name.startsWith(`learned:${entry.kind}:${entry.project}:${entry.slug}:`)));
    return createSnapshot(dbs.learning, runId, [...kept, entry.id]);
}
/** The newest graded `solve` attempt per task, as the before side. */
function beforeAttempts(dbs, runId, taskIds) {
    if (taskIds.length === 0)
        return new Map();
    const attempts = listAttempts(dbs.learning, {
        runId,
        taskIds,
        role: 'solve',
        outcome: 'graded',
    });
    const latest = new Map();
    for (const attempt of attempts) {
        const existing = latest.get(attempt.taskId);
        if (!existing || existing.id < attempt.id)
            latest.set(attempt.taskId, attempt);
    }
    return latest;
}
/** Solve one task in the evaluation snapshot and return its attempt. */
async function reSolve(dbs, taskId, snapshotId, opts, model) {
    // Stale tasks are excluded (§7 rule 13). A missing or stale id is not a solve.
    const task = listTasks(dbs.learning, {
        split: 'train',
        ids: [taskId],
    })[0];
    if (!task)
        return null;
    return opts.solve(dbs, task, {
        snapshotId,
        runId: opts.runId,
        role: 'validate',
        model,
        pids: opts.pids ?? NO_PIDS,
        runAgent: opts.runAgent,
        judge: opts.judge,
        budget: opts.budget,
    });
}
/**
 * Validate one candidate and act on the verdict.
 *
 * On a keep the entry is activated (`verified`) when its kind can activate
 * itself — a skill, or an instruction under `approve: none` — and left a
 * candidate otherwise, with its record. On a drop the record is written, the
 * instruction's heuristics take a contradiction, a procedure's success rate
 * falls, and the edit's decision is rejected with the reason.
 */
export async function validateCandidate(dbs, candidateName, opts) {
    const entry = await getEntry(dbs.store, candidateName);
    if (!entry)
        throw new Error(`knowledge entry not found: ${candidateName}`);
    const config = learnConfig();
    const model = opts.model ?? config.model;
    const requested = [...new Set(opts.targeted)];
    const requestedSample = sampleIds(opts.sampleFrom.filter(id => !requested.includes(id)), opts.sampleSize, opts.seed);
    const liveIds = new Set(listTasks(dbs.learning, {
        split: 'train',
        ids: [...requested, ...requestedSample],
    }).map(task => task.id));
    const targeted = requested.filter(id => liveIds.has(id));
    const sample = requestedSample.filter(id => liveIds.has(id));
    // Nothing left to measure (every target was stale or already filtered out).
    // Leave the candidate unvalidated: do not reject its decision or its heuristics.
    if (targeted.length === 0) {
        return {
            targeted,
            sample,
            passedBefore: 0,
            passedAfter: 0,
            regressions: [],
            judgedAt: new Date().toISOString(),
            meanTurnsBefore: null,
            meanTurnsAfter: null,
            usdBefore: null,
            usdAfter: null,
            keep: false,
        };
    }
    // Every proposal is a decision before it is a measurement, so the reason a
    // candidate was dropped survives as a rejected decision, not just a record.
    const decisionId = await dbs.store.proposeDecision({
        context: `validate ${entry.kind} ${entry.project}/${entry.slug} v${entry.version} ` +
            `against targets ${opts.targeted.join(', ') || 'none'}`,
        decision: entry.title,
        alternatives: ['keep the current entries unchanged'],
        consequences: [
            `if kept, ${candidateName} becomes active`,
            `if dropped, ${candidateName} stays a candidate and its contradiction is recorded`,
        ],
        sourceProjectId: entry.project,
    });
    await dbs.store.setDecision(candidateName, decisionId);
    const before = beforeAttempts(dbs, opts.runId, [...targeted, ...sample]);
    const snapshotId = await evaluationSnapshot(dbs, entry, opts.runId);
    const after = new Map();
    for (const taskId of [...targeted, ...sample]) {
        const attempt = await reSolve(dbs, taskId, snapshotId, opts, model);
        if (attempt)
            after.set(taskId, attempt);
    }
    const regressions = sample.filter(taskId => {
        const wasPassing = before.get(taskId)?.passed === true;
        const nowPassing = after.get(taskId)?.passed === true;
        return wasPassing && !nowPassing;
    });
    const targetedPasses = targeted.filter(taskId => after.get(taskId)?.passed === true).length;
    const keep = targetedPasses >= 1 && regressions.length === 0;
    const beforeTotals = totalsOf([...targeted, ...sample].map(taskId => ({
        passed: before.get(taskId)?.passed === true,
        attempt: before.get(taskId) ?? null,
    })));
    const afterTotals = totalsOf([...targeted, ...sample].map(taskId => ({
        passed: after.get(taskId)?.passed === true,
        attempt: after.get(taskId) ?? null,
    })));
    const record = {
        targeted,
        sample,
        passedBefore: beforeTotals.passed,
        passedAfter: afterTotals.passed,
        regressions,
        judgedAt: new Date().toISOString(),
        meanTurnsBefore: mean(beforeTotals.turns, beforeTotals.measured),
        meanTurnsAfter: mean(afterTotals.turns, afterTotals.measured),
        usdBefore: beforeTotals.measured === 0 ? null : beforeTotals.usd,
        usdAfter: afterTotals.measured === 0 ? null : afterTotals.usd,
    };
    if (!keep) {
        await dbs.store.setValidation(candidateName, record);
        if (entry.kind === 'instruction') {
            for (const heuristicId of entry.heuristicIds) {
                await dbs.store.contradictHeuristic(heuristicId);
            }
        }
        if (entry.procedureId)
            await dbs.store.refineProcedure(entry.procedureId, false);
        await dbs.store.rejectDecision(decisionId, regressions.length > 0
            ? `regressed tasks ${regressions.join(', ')}`
            : 'no targeted task passed');
        return { ...record, keep: false };
    }
    const canActivate = entry.kind === 'skill' || (entry.kind === 'instruction' && config.approve === 'none');
    if (canActivate) {
        // `activate` supersedes the older active version, reinforces the
        // instruction's heuristics, accepts the decision and credits the procedure,
        // so none of those are repeated here.
        await activate(dbs.store, candidateName, record, 'verified');
        await writeLearnedBlocks(dbs.store, dbs.learning, config.maxChars);
        return { ...record, keep: true };
    }
    // A kept instruction waiting for approval still records its gain: the
    // reinforcement makes the edit outrank a stale line, and the accepted decision
    // is what `learn approve` later builds on.
    await dbs.store.setValidation(candidateName, record);
    if (entry.kind === 'instruction') {
        for (const heuristicId of entry.heuristicIds) {
            await dbs.store.reinforceHeuristic(heuristicId);
        }
    }
    if (entry.procedureId)
        await dbs.store.refineProcedure(entry.procedureId, true);
    await dbs.store.acceptDecision(decisionId);
    return { ...record, keep: true };
}
