/**
 * The `KnowledgeEntry` API over the knowledge store and the learning trace.
 *
 * Everything here speaks the shapes in `./types.js`; only `./knowledge-store.js`
 * opens `knowledge.db`. Every function that touches the store is `async`.
 *
 * Additive only: nothing in this module deletes an entry. A revision inserts a
 * new version and marks the older one `supersededBy`; retirement sets `status`.
 */
import type { Database } from '../sqlite.js';
import { entryName, procedureIdFor, rootName, type KnowledgeStore } from './knowledge-store.js';
import { type KnowledgeEntry, type KnowledgeKind, type KnowledgeStatus, type NewKnowledgeEntry, type ValidationRecord } from './types.js';
/** A proposal whose body matches the latest version of the same key. */
export declare class DuplicateEntry extends Error {
    readonly kind: KnowledgeKind;
    readonly project: string;
    readonly slug: string;
    readonly existingId: string;
    constructor(kind: KnowledgeKind, project: string, slug: string, existingId: string);
}
/** An entry name was malformed. */
export declare class InvalidEntryName extends Error {
    constructor(name: string);
}
/**
 * Insert a new candidate entry.
 *
 * The function rejects an invalid or reserved slug.
 * The function also rejects an identical body (spec §7 rule 17).
 * An identical body matches the body of the latest version of the same `(kind, project, slug)`.
 * A changed body gets the next logical version, with `parentEntityName` pointing at its
 * predecessor.
 *
 * Side effects beyond the entry itself are all additive.
 * - An instruction gets one heuristic record per non-blank body line, and a decision.
 * - A procedure skill (`steps` with at least one step) gets a `proc:<project>:<slug>` record.
 * - Every entry gets a proposed decision, so a later `activate` can accept that decision.
 */
export declare function insertKnowledgeEntry(store: KnowledgeStore, entry: NewKnowledgeEntry): Promise<string>;
/**
 * Activate an entry.
 * The entry gets status `active` / `published`, the given trust level, and the optional validation record.
 * Every other active version of the same key is superseded and kept.
 * The call reinforces the instruction's heuristics and accepts the edit's decision.
 *
 * `trust` is restricted to the two levels a validation or a human approval can
 * confer. An `unverified` entry is only ever a candidate.
 */
export declare function activate(store: KnowledgeStore, name: string, validation: ValidationRecord | null, trust: 'verified' | 'ground-truth'): Promise<void>;
/** Retire an entry: status `retired` / `archived`. The row is kept. */
export declare function retire(store: KnowledgeStore, name: string): Promise<void>;
/**
 * Every active, not-superseded entry for `project` (including `*` rows).
 *
 * Order: project rows before `*` rows, then kind order instruction, skill,
 * reflection, then slug.
 */
export declare function listActive(store: KnowledgeStore, kinds: KnowledgeKind[], project: string): Promise<KnowledgeEntry[]>;
/** Candidate entries, optionally filtered by kind. */
export declare function listCandidates(store: KnowledgeStore, kind?: KnowledgeKind): Promise<KnowledgeEntry[]>;
/** One entry by entity name, or null. */
export declare function getEntry(store: KnowledgeStore, name: string): Promise<KnowledgeEntry | null>;
/** The latest version of a `(kind, project, slug)` chain, or null. */
export declare function getBySlug(store: KnowledgeStore, kind: KnowledgeKind, project: string, slug: string): Promise<KnowledgeEntry | null>;
/** Text search over active entries of a project (and `*`). */
export declare function searchKnowledge(store: KnowledgeStore, query: string, project?: string, limit?: number): Promise<KnowledgeEntry[]>;
/**
 * Record the set of entries a solver ran with (`K^(t)`).
 *
 * With no explicit names, every active not-superseded entry name in `store` is
 * recorded, so `store` is required in that form. Later additions are not
 * retro-actively included: a snapshot is a point-in-time set, which is what
 * makes before/after comparison meaningful.
 */
export declare function createSnapshot(learningDb: Database, runId: string, entryNames?: string[], store?: KnowledgeStore): Promise<number>;
/**
 * Read a snapshot's entry names.
 *
 * Synchronous: this runs against `learning.sqlite`, not the knowledge store.
 */
export declare function getSnapshot(learningDb: Database, id: number): string[];
/** Re-exported so callers do not need the adapter module for these names. */
export { entryName, rootName, procedureIdFor };
/** The set of statuses that count as live. */
export declare const LIVE_STATUSES: KnowledgeStatus[];
