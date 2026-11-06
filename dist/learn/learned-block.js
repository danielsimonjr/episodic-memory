/**
 * Render and persist the learned block for every project that has active
 * entries, plus one shared `*` row.
 *
 * This module is on the `learn` CLI's slow path only: it needs the memoryjs
 * store to list active entries, and it writes `learning.sqlite`. The hook never
 * imports it — it reads the rows this function wrote (spec §6.3).
 */
import { redactSecrets } from '../redact.js';
import { redactPii, renderLearnedBlock } from './learn-inject.js';
/** Project rows before `*` rows, then kind order instruction → skill, then slug. */
function orderForBlock(a, b) {
    const aGlobal = a.project === '*' ? 1 : 0;
    const bGlobal = b.project === '*' ? 1 : 0;
    if (aGlobal !== bGlobal)
        return aGlobal - bGlobal;
    const kindOrder = { instruction: 0, skill: 1 };
    const kindDiff = (kindOrder[a.kind] ?? 2) - (kindOrder[b.kind] ?? 2);
    if (kindDiff !== 0)
        return kindDiff;
    if (a.project !== b.project)
        return a.project < b.project ? -1 : 1;
    return a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0;
}
/**
 * Render one block per project that has active entries and one for `*`.
 *
 * Upsert, not insert: the block is derived output, so re-rendering replaces the
 * previous text for that project. `rendered_at` is rewritten so a later reader
 * can tell how stale the text is.
 */
export async function writeLearnedBlocks(store, learningDb, maxChars, opts = {}) {
    const entries = (await store.listByStatus(['active'], ['instruction', 'skill']))
        .filter(entry => entry.supersededBy === null)
        .sort(orderForBlock);
    const projects = new Set(['*']);
    for (const entry of entries)
        projects.add(entry.project);
    const upsert = learningDb.prepare('INSERT INTO learned_block (project, text, rendered_at) VALUES (?, ?, ?) ' +
        'ON CONFLICT(project) DO UPDATE SET text = excluded.text, rendered_at = excluded.rendered_at');
    const clear = learningDb.prepare('DELETE FROM learned_block WHERE project = ?');
    const now = new Date().toISOString();
    // A project that used to have a row can disappear from `entries` when its last
    // instruction or skill is retired. Those rows have to be cleared too, or the
    // hook keeps injecting the stale block.
    let stored = [];
    try {
        stored = learningDb.prepare('SELECT project FROM learned_block').all().map(row => row.project);
    }
    catch {
        // A stub or a pre-migration handle: only the projects in this pass are known.
    }
    for (const project of stored)
        projects.add(project);
    const storePii = store.redactPii;
    const redact = opts.redact ??
        (typeof storePii === 'function'
            ? (text) => storePii.call(store, redactSecrets(text))
            : (text) => redactPii(redactSecrets(text)));
    for (const project of projects) {
        // `*` renders the global rows alone; a project renders its own rows plus the
        // global ones, which is what a session searching that project should see.
        const rows = project === '*'
            ? entries.filter(entry => entry.project === '*')
            : entries.filter(entry => entry.project === project || entry.project === '*');
        const text = renderLearnedBlock(rows, maxChars, opts.screen, redact);
        if (!text) {
            clear.run(project);
            continue;
        }
        upsert.run(project, text, now);
    }
}
