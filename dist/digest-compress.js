import { callDigestModel } from './summarizer.js';
import { buildCompressPrompt } from './digest-prompts.js';
import { parseCitedLines, redactEntryText } from './digest-validate.js';
import { insertDigestEntry, listActiveByTier, supersede } from './digest-db.js';
const DEFAULT_DAY_CAP = 5;
const DEFAULT_WEEK_CAP = 2;
function envInt(name, fallback) {
    const n = Number(process.env[name]);
    return Number.isInteger(n) && n > 0 ? n : fallback;
}
/** UTC calendar day, `YYYY-MM-DD`. */
function dayOf(iso) {
    return new Date(iso).toISOString().slice(0, 10);
}
/** Monday of the UTC ISO week containing the instant, `YYYY-MM-DD`. */
function weekStartOf(iso) {
    const d = new Date(iso);
    const dow = (d.getUTCDay() + 6) % 7; // Monday = 0
    const monday = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - dow));
    return monday.toISOString().slice(0, 10);
}
function groupBy(entries, keyOf) {
    const groups = new Map();
    for (const e of entries) {
        const k = `${e.project}\u0000${keyOf(e)}`;
        const g = groups.get(k);
        if (g)
            g.push(e);
        else
            groups.set(k, [e]);
    }
    return groups;
}
async function mergeGroup(db, model, group, tier, periodStart, result) {
    const { prompt, marks } = buildCompressPrompt(group, tier);
    let raw;
    try {
        raw = await model(prompt);
    }
    catch (err) {
        console.error(`digest: ${tier} compression failed: ${err instanceof Error ? err.message : String(err)}`);
        result.failed++;
        return;
    }
    const parsed = parseCitedLines(String(raw ?? ''), marks);
    if (parsed.lines.length === 0)
        return;
    const id = insertDigestEntry(db, {
        tier,
        project: group[0].project,
        periodStart,
        periodEnd: group.reduce((max, e) => (e.periodEnd > max ? e.periodEnd : max), group[0].periodEnd),
        text: redactEntryText(parsed.lines.join('\n')),
        sources: parsed.sources,
        model: process.env.EPISODIC_MEMORY_API_MODEL || 'haiku',
        handoff: false,
    });
    if (id === null)
        return; // key already taken: leave the originals active
    supersede(db, group.map(e => e.id), id);
    result.created++;
}
/**
 * Merge many session entries of a past day into one day entry, and many day entries of a finished
 * week into one week entry. Originals are marked superseded, never deleted.
 */
export async function compressDigest(db, opts = {}) {
    const result = { created: 0, failed: 0 };
    const model = opts.model ?? callDigestModel;
    const now = (opts.now ?? new Date()).toISOString();
    const dayCap = opts.dayCap ?? envInt('EPISODIC_MEMORY_DIGEST_DAY_CAP', DEFAULT_DAY_CAP);
    const weekCap = opts.weekCap ?? envInt('EPISODIC_MEMORY_DIGEST_WEEK_CAP', DEFAULT_WEEK_CAP);
    const today = dayOf(now);
    const thisWeek = weekStartOf(now);
    for (const group of groupBy(listActiveByTier(db, 'session'), e => dayOf(e.periodStart)).values()) {
        const day = dayOf(group[0].periodStart);
        if (day >= today || group.length <= dayCap)
            continue;
        await mergeGroup(db, model, group, 'day', `${day}T00:00:00.000Z`, result);
    }
    for (const group of groupBy(listActiveByTier(db, 'day'), e => weekStartOf(e.periodStart)).values()) {
        const week = weekStartOf(group[0].periodStart);
        if (week >= thisWeek || group.length <= weekCap)
            continue;
        await mergeGroup(db, model, group, 'week', `${week}T00:00:00.000Z`, result);
    }
    return result;
}
