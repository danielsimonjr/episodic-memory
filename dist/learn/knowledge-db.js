/**
 * The `KnowledgeEntry` API over the memoryjs adapter and the learning trace.
 *
 * Everything here speaks the shapes in `./types.js`; only `./knowledge-store.js`
 * imports memoryjs. Every function that touches the store is `async`.
 *
 * Additive only: nothing in this module deletes an entry. A revision inserts a
 * new version and marks the older one `supersededBy`; retirement sets `status`.
 */
import { entryName, procedureIdFor, rootName, } from './knowledge-store.js';
import { isValidSlug, } from './types.js';
/** A proposal whose body matches the latest version of the same key. */
export class DuplicateEntry extends Error {
    kind;
    project;
    slug;
    existingId;
    constructor(kind, project, slug, existingId) {
        super(`duplicate entry ${kind}/${project}/${slug} (identical body to ${existingId})`);
        this.kind = kind;
        this.project = project;
        this.slug = slug;
        this.existingId = existingId;
        this.name = 'DuplicateEntry';
    }
}
/** An entry name was malformed. */
export class InvalidEntryName extends Error {
    constructor(name) {
        super(`not a learned entry name: ${name}`);
        this.name = 'InvalidEntryName';
    }
}
/** The order `listActive` returns kinds in. */
const KIND_ORDER = { instruction: 0, skill: 1, reflection: 2 };
/**
 * Insert a new candidate entry.
 *
 * Rejects an invalid or reserved slug, and an identical body against the latest
 * version of the same `(kind, project, slug)` (spec §7 rule 17). A changed body
 * gets the next logical version, with `parentEntityName` pointing at its
 * predecessor.
 *
 * Side effects beyond the entry itself, all of them additive:
 * - an instruction gets one heuristic record per body line, and a decision
 * - a procedure skill (`steps` present) gets a `proc:<project>:<slug>` record
 * - every entry gets a proposed decision so a later `activate` can accept it
 */
export async function insertKnowledgeEntry(store, entry) {
    if (!isValidSlug(entry.slug)) {
        if (/^[a-z0-9][a-z0-9-]{0,63}$/.test(entry.slug)) {
            throw new Error(`slug is a reserved device name: ${entry.slug}`);
        }
        throw new Error(`invalid slug: ${entry.slug}`);
    }
    const previous = await store.getBySlug(entry.kind, entry.project, entry.slug);
    if (previous && previous.body === entry.body) {
        throw new DuplicateEntry(entry.kind, entry.project, entry.slug, previous.id);
    }
    const version = previous ? previous.version + 1 : 1;
    const id = entryName(entry.kind, entry.project, entry.slug, version);
    const heuristicIds = [];
    if (entry.kind === 'instruction') {
        for (const line of entry.body.split('\n').map(l => l.trim()).filter(Boolean)) {
            heuristicIds.push(await store.addHeuristic({
                condition: entry.scope,
                action: line,
                priority: confidencePriority(entry.confidence),
                initialConfidence: confidenceScore(entry.confidence),
            }));
        }
    }
    let procedureId = null;
    if (entry.steps && entry.steps.length > 0) {
        procedureId = procedureIdFor(entry.project, entry.slug);
    }
    const decisionId = await store.proposeDecision({
        context: previous
            ? `revise ${entry.kind} ${entry.project}/${entry.slug} from v${previous.version}`
            : `add ${entry.kind} ${entry.project}/${entry.slug}`,
        decision: entry.title,
        alternatives: [],
        consequences: [`${entry.kind} ${entry.project}/${entry.slug} v${version} becomes a candidate`],
        sourceProjectId: entry.project,
    });
    const record = {
        id,
        kind: entry.kind,
        project: entry.project,
        slug: entry.slug,
        version,
        title: entry.title,
        description: entry.description,
        body: entry.body,
        scope: entry.scope,
        confidence: entry.confidence,
        trust: entry.trust,
        sources: entry.sources,
        status: entry.status,
        runId: entry.runId,
        createdAt: new Date().toISOString(),
        supersededBy: null,
        validation: null,
        heuristicIds,
        decisionId,
        procedureId,
    };
    if (entry.steps)
        record.steps = entry.steps;
    await store.putEntry(record);
    if (procedureId && entry.steps) {
        await store.putProcedure({
            id: procedureId,
            name: entry.title,
            description: entry.description,
            steps: entry.steps,
            triggers: [entry.description, ...entry.body.split('\n').map(stripMarks)],
        });
    }
    if (entry.kind === 'reflection') {
        // The memoryjs reflection record is the derived overlay that its own
        // managers read; the entry entity above stays the thing every gate and the
        // rendered block use.
        await store.recordReflectionRecord({
            scope: entry.project === '*' ? 'global' : 'project',
            project: entry.project,
            entryId: id,
            summary: entry.body,
            evidence: entry.sources.map(source => `exchange:${source.id}`),
            confidence: entry.confidence,
        });
    }
    return id;
}
/**
 * Activate an entry: status `active` / `published`, the given trust level,
 * optional validation record, every other active version of the same key
 * superseded (and kept), the instruction's heuristics reinforced, the edit's
 * decision accepted.
 *
 * `trust` is restricted to the two levels a validation or a human approval can
 * confer. An `unverified` entry is only ever a candidate.
 */
export async function activate(store, name, validation, trust) {
    if (trust !== 'verified' && trust !== 'ground-truth') {
        throw new Error(`activate needs trust 'verified' or 'ground-truth', got '${String(trust)}'`);
    }
    const entry = await store.getEntry(name);
    if (!entry)
        throw new InvalidEntryName(name);
    await store.promote(name, trust, validation);
    // Every other active version of the same key is superseded, not deleted.
    const siblings = await store.listByStatus(['active'], [entry.kind], entry.project);
    for (const sibling of siblings) {
        if (sibling.id === name)
            continue;
        if (sibling.slug !== entry.slug)
            continue;
        if (sibling.supersededBy)
            continue;
        await store.supersede(sibling.id, name);
    }
    for (const heuristicId of entry.heuristicIds) {
        await store.reinforceHeuristic(heuristicId);
    }
    if (entry.decisionId)
        await store.acceptDecision(entry.decisionId);
    if (entry.procedureId)
        await store.refineProcedure(entry.procedureId, true);
}
/** Retire an entry: status `retired` / `archived`. The row is kept. */
export async function retire(store, name) {
    const entry = await store.getEntry(name);
    if (!entry)
        throw new InvalidEntryName(name);
    await store.setStatus(name, 'retired');
}
/**
 * Every active, not-superseded entry for `project` (including `*` rows).
 *
 * Order: project rows before `*` rows, then kind order instruction, skill,
 * reflection, then slug.
 */
export async function listActive(store, kinds, project) {
    const entries = await store.listEntries();
    const wanted = kinds.length > 0 ? kinds : ['instruction', 'skill', 'reflection'];
    return entries
        .filter(entry => entry.status === 'active' &&
        entry.supersededBy === null &&
        wanted.includes(entry.kind) &&
        (entry.project === project || entry.project === '*'))
        .sort(compareEntries);
}
/** Candidate entries, optionally filtered by kind. */
export async function listCandidates(store, kind) {
    const entries = await store.listByStatus(['candidate'], kind ? [kind] : undefined);
    return entries.sort(compareEntries);
}
/** One entry by entity name, or null. */
export async function getEntry(store, name) {
    return store.getEntry(name);
}
/** The latest version of a `(kind, project, slug)` chain, or null. */
export async function getBySlug(store, kind, project, slug) {
    return store.getBySlug(kind, project, slug);
}
/** Text search over active entries of a project (and `*`). */
export async function searchKnowledge(store, query, project, limit = 10) {
    return store.search(query, { project, limit });
}
/**
 * Record the set of entries a solver ran with (`K^(t)`).
 *
 * With no explicit names, every active not-superseded entry name in `store` is
 * recorded, so `store` is required in that form. Later additions are not
 * retro-actively included: a snapshot is a point-in-time set, which is what
 * makes before/after comparison meaningful.
 */
export async function createSnapshot(learningDb, runId, entryNames, store) {
    let names = entryNames;
    if (!names) {
        if (!store) {
            throw new Error('createSnapshot needs a store when entryNames is omitted');
        }
        const entries = await store.listEntries();
        names = entries
            .filter(entry => entry.status === 'active' && entry.supersededBy === null)
            .map(entry => entry.id)
            .sort();
    }
    const info = learningDb
        .prepare('INSERT INTO knowledge_snapshot (run_id, created_at, entry_names) VALUES (?, ?, ?)')
        .run(runId, new Date().toISOString(), JSON.stringify(names));
    return Number(info.lastInsertRowid);
}
/**
 * Read a snapshot's entry names.
 *
 * Synchronous: this runs against `learning.sqlite`, not the memoryjs store.
 */
export function getSnapshot(learningDb, id) {
    const row = learningDb
        .prepare('SELECT entry_names FROM knowledge_snapshot WHERE id = ?')
        .get(id);
    if (!row)
        return [];
    try {
        const parsed = JSON.parse(row.entry_names);
        return Array.isArray(parsed) ? parsed.map(String) : [];
    }
    catch {
        return [];
    }
}
// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------
function compareEntries(a, b) {
    // Project rows before '*' rows.
    const aGlobal = a.project === '*' ? 1 : 0;
    const bGlobal = b.project === '*' ? 1 : 0;
    if (aGlobal !== bGlobal)
        return aGlobal - bGlobal;
    const kindDiff = KIND_ORDER[a.kind] - KIND_ORDER[b.kind];
    if (kindDiff !== 0)
        return kindDiff;
    if (a.project !== b.project)
        return a.project < b.project ? -1 : 1;
    return a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0;
}
function confidencePriority(confidence) {
    return confidence === 'high' ? 8 : confidence === 'medium' ? 5 : 3;
}
function confidenceScore(confidence) {
    return confidence === 'high' ? 0.8 : confidence === 'medium' ? 0.55 : 0.3;
}
/** Drop a trailing `[#id,...]` mark group, leaving the line's prose. */
function stripMarks(line) {
    return line.replace(/\s*\[(?:#[0-9a-f]{32}|@\d+)(?:\s*,\s*(?:#[0-9a-f]{32}|@\d+))*\]\s*$/, '').trim();
}
/** Re-exported so callers do not need the adapter module for these names. */
export { entryName, rootName, procedureIdFor };
/** The set of statuses that count as live. */
export const LIVE_STATUSES = ['active'];
