/**
 * The `@danielsimonjr/memoryjs` adapter.
 *
 * This is the ONLY module in the repository that imports memoryjs, and it
 * imports from the package root only (the repo's `tsconfig` uses node10 module
 * resolution, which ignores the package `exports` map, so a subpath import such
 * as `@danielsimonjr/memoryjs/sqlite` does not typecheck).
 *
 * Every other module sees `KnowledgeEntry` from `./types.js`.
 *
 * Two invariants matter more than anything else here:
 *
 * 1. **Environment scoping.** memoryjs reads a large family of `MEMORY_*`
 *    variables at construction and gives them precedence over explicit
 *    options. `MEMORY_STORAGE_TYPE=jsonl` would silently turn this store into a
 *    JSONL graph; `MEMORY_OBSERVATION_DEDUP=true` would fuzzy-drop near-duplicate
 *    observation lines (which is to say, body lines that differ only in their
 *    citation marks); the default embedding provider downloads a model from the
 *    network. So construction happens inside `withScopedMemoryEnv`, which saves
 *    and removes every `^MEMORY_` key, sets exactly the two keys this store
 *    needs, constructs, and restores in `finally`.
 *
 * 2. **Nothing auto-constructing.** `ctx.hybridSearchManager` always builds a
 *    manager, so it is never touched. `ctx.semanticSearch` is read once, only to
 *    assert it is null under `MEMORY_EMBEDDING_PROVIDER=none`. The decay,
 *    consolidation, archive, compression and semantic-forget managers are never
 *    exposed.
 *
 * Every memoryjs write and search call returns a Promise in 4.5.0, so every
 * store method that touches the store is `async`.
 */
import type { Entity } from '@danielsimonjr/memoryjs';
import type { Confidence, KnowledgeEntry, KnowledgeKind, KnowledgeStatus, ProcedureStepSpec, SourceRef, TrustLevel, ValidationRecord } from './types.js';
/** Thrown when memoryjs does not come up the way this adapter requires. */
export declare class KnowledgeStoreMisconfigured extends Error {
    constructor(message: string);
}
export interface SearchOptions {
    kinds?: KnowledgeKind[];
    /** A project key, or `*`. Rows for this project and `*` are both returned. */
    project?: string;
    limit?: number;
}
export interface CreateReflectionInput {
    scope: 'project' | 'global';
    project: string;
    /** Cited entity names, e.g. `exchange:<id>` and `attempt:<id>`. */
    evidence: string[];
    summary: string;
    confidence: Confidence;
    /** Attempt ids to cite as `attempt:<id>` reference entities. */
    attempts?: number[];
    /** Exchange sources to record on the entry and cite. */
    sources?: SourceRef[];
    runId?: string;
    /** Entry overrides; derived from the summary when absent. */
    slug?: string;
    title?: string;
    description?: string;
    scopeText?: string;
    trust?: TrustLevel;
    status?: KnowledgeStatus;
    /** Extra attempts to cite, matched with `attempts` for the reference rows. */
    attemptTasks?: Array<{
        id: number;
        taskId: number;
    }>;
}
export interface CreateReflectionResult {
    duplicate: boolean;
    id: string | null;
}
export interface ProcedureMatchLike {
    procedure: {
        id: string;
        name: string;
        description: string;
    };
    score: number;
}
/** A parsed raw entity, as tests and `knowledge-db` inspect it. */
export interface RawEntityView {
    name: string;
    entityType: string;
    observations: string[];
    tags: string[];
    isLatest: boolean;
    parentEntityName: string | null;
    supersededBy: string | null;
}
export interface HeuristicView {
    id: string;
    condition: string;
    action: string;
    support: number;
    contradictions: number;
    confidence: number;
}
export interface DecisionView {
    id: string;
    status: string;
    context: string;
    decision: string;
    alternatives: string[];
    consequences: string[];
}
/**
 * Parse an entity back into the `KnowledgeEntry` shape.
 *
 * The logical `version` comes from the `version:` observation (and, failing
 * that, from the `:v<n>` suffix of the name), never from `Entity.version`,
 * which memoryjs increments on every OCC-guarded write.
 */
export declare function parseEntity(entity: Entity): KnowledgeEntry | null;
/** `learned:<kind>:<project>:<slug>:v<n>`. */
export declare function entryName(kind: KnowledgeKind, project: string, slug: string, version: number): string;
/** `learned:<kind>:<project>:<slug>:v1`, the root of the version chain. */
export declare function rootName(kind: KnowledgeKind, project: string, slug: string): string;
/** `proc:<project>:<slug>`, the id a procedure skill's record carries. */
export declare function procedureIdFor(project: string, slug: string): string;
export declare class KnowledgeStore {
    private readonly ctx;
    private readonly pii;
    private closed;
    /** The concrete storage class memoryjs built. `SQLiteStorage` means sqlite. */
    readonly storageConstructorName: string;
    /** Asserted once, at construction. */
    readonly semanticSearchIsNull: boolean;
    private constructor();
    /**
     * Constructing is synchronous (memoryjs loads the graph lazily and the
     * constructor starts no timers), but every method that touches the store is
     * async.
     */
    static create(dbPath: string): KnowledgeStore;
    /** Release the underlying storage handle. Idempotent. */
    close(): void;
    /** PII redaction, for `knowledge-db` and the gates to reuse. */
    redactPii(text: string): string;
    /** The raw entity, for tests and for `knowledge-db`'s duplicate check. */
    getRawEntity(name: string): Promise<RawEntityView | null>;
    /**
     * Write one entity for one version, plus the reference entities and `cites`
     * relations it needs. References are created first: `createRelations`
     * validates that both endpoints exist.
     */
    putEntry(entry: KnowledgeEntry, reflectionHash?: string): Promise<void>;
    /** Create an `exchange:<id>` reference entity when it is absent. */
    private ensureExchangeRefs;
    /** Create an `attempt:<id>` reference entity, citing it from `from`. */
    citeAttempt(from: string, attemptId: number, taskId: number, runId: string): Promise<void>;
    /**
     * Replace the observation set and the tags of an existing entity. The
     * `expectedVersion` is read immediately before the write: memoryjs's
     * `Entity.version` is unrelated to the logical entry version.
     */
    private rewriteEntity;
    /** Set `supersededBy` and clear `isLatest` on the older version. */
    supersede(olderName: string, newerName: string): Promise<void>;
    /** Set the status (and the `status:` observation and tag) of one entry. */
    setStatus(name: string, status: KnowledgeStatus): Promise<void>;
    /** Set the trust level (observation and tag) of one entry. */
    setTrust(name: string, trust: TrustLevel): Promise<void>;
    /**
     * Activate one entry in a single guarded write: status, trust and validation
     * together, so a rejected write cannot leave two of the three applied.
     */
    promote(name: string, trust: TrustLevel, validation: ValidationRecord | null): Promise<void>;
    /** Record a validation record on one entry. */
    setValidation(name: string, validation: ValidationRecord | null): Promise<void>;
    /** Record a decision id on one entry. */
    setDecision(name: string, decisionId: string | null): Promise<void>;
    /** Record a procedure id on one entry. */
    setProcedure(name: string, procedureId: string | null): Promise<void>;
    /** Record the heuristic ids of one entry. */
    setHeuristics(name: string, heuristicIds: string[]): Promise<void>;
    /** Read one entry by entity name. */
    getEntry(name: string): Promise<KnowledgeEntry | null>;
    /** The latest version of a `(kind, project, slug)` chain. */
    getBySlug(kind: KnowledgeKind, project: string, slug: string): Promise<KnowledgeEntry | null>;
    /** Highest logical version in a chain (by `version:` / name), not `isLatest`. */
    private latestEntryInChain;
    /** Every learned entity. */
    private allEntities;
    /** Every learned entry, one row per chain (highest logical version), any status. */
    listEntries(): Promise<KnowledgeEntry[]>;
    /**
     * Every learned entry with a given status, including superseded and older
     * versions. Lifecycle bookkeeping (`activate`'s supersede sweep) must see
     * those rows, so this deliberately does not filter on `isLatest`.
     */
    listByStatus(statuses: KnowledgeStatus[], kinds?: KnowledgeKind[], project?: string): Promise<KnowledgeEntry[]>;
    /**
     * Text search over entries.
     *
     * `searchNodesRanked` is async; its 6th argument is an exact-match `projectId`,
     * which cannot express "this project or `*`", so the project filter runs in
     * code here. Draft and archived rows are dropped too.
     *
     * memoryjs's TF-IDF score is `tf * log(N / docsWithTerm)`, which is exactly 0
     * when every document in a small corpus contains the query token, so a store
     * with one or two entries would return nothing at all. The ranked pass is
     * therefore complemented by a deterministic token-overlap pass over the same
     * filtered set; ranked hits keep their order and token-only hits follow.
     */
    search(query: string, options?: SearchOptions): Promise<KnowledgeEntry[]>;
    /**
     * Rebuild the search index.
     *
     * memoryjs constructs `RankedSearch` without a `storageDir`, so its
     * `buildIndex()` throws by design and its on-the-fly scoring path is always
     * current. This is a deliberate no-op that expresses the caller's intent
     * ("writes happened; make search see them") without a throw.
     */
    buildIndex(): Promise<void>;
    /** Add an instruction line as a heuristic record. Returns its id. */
    addHeuristic(input: {
        condition: string;
        action: string;
        priority?: number;
        initialConfidence?: number;
    }): Promise<string>;
    /** Reinforce an instruction's heuristic after a kept validation. */
    reinforceHeuristic(id: string): Promise<boolean>;
    /** Record a contradiction against an instruction's heuristic on a drop. */
    contradictHeuristic(id: string): Promise<boolean>;
    /** Every heuristic conflict, for the merge step's conflict resolution. */
    detectHeuristicConflicts(): Promise<Array<{
        a: string;
        b: string;
        kind: 'overlap' | 'contradiction';
        reason: string;
    }>>;
    /** A heuristic by id, or null. */
    getHeuristic(id: string): HeuristicView | null;
    /** Store a procedure skill's steps. Returns the procedure id. */
    putProcedure(input: {
        id: string;
        name: string;
        description: string;
        steps: ProcedureStepSpec[];
        triggers: string[];
    }): Promise<void>;
    /** A stored procedure, or null. */
    getProcedure(id: string): Promise<{
        id: string;
        name: string;
        description: string;
        steps: Array<{
            order: number;
            action: string;
            parameters: Record<string, string>;
        }>;
        triggers: string[];
        successRate: number | null;
        executionCount: number | null;
    } | null>;
    /** Rank stored procedures against a context description. */
    matchProcedures(context: string, ids: string[]): Promise<ProcedureMatchLike[]>;
    /** Telemetry only: record whether a procedure skill's attempt succeeded. */
    refineProcedure(id: string, succeeded: boolean, notes?: string): Promise<void>;
    /** Upsert a project's structured context (learner prompts only). */
    upsertProjectContext(project: string, input: {
        facts?: string[];
        conventions?: string[];
        glossary?: Array<{
            term: string;
            definition: string;
        }>;
    }): Promise<void>;
    /** The project's context rendered as prose, budgeted. */
    forContext(project: string, budgetChars?: number): Promise<string>;
    /** Propose a decision for an edit. Returns the decision id. */
    proposeDecision(input: {
        context: string;
        decision: string;
        alternatives: string[];
        consequences: string[];
        sourceProjectId?: string;
    }): Promise<string>;
    /** Accept a proposed decision (a kept edit). */
    acceptDecision(id: string): Promise<boolean>;
    /** Reject a proposed decision (a dropped edit). */
    rejectDecision(id: string, reason: string): Promise<boolean>;
    /** Supersede an accepted decision with a newer one. */
    supersedeDecision(id: string, by: string): Promise<boolean>;
    /** A decision by id, or null. */
    getDecision(id: string): DecisionView | null;
    /** A decision rendered as ADR markdown. Synchronous in memoryjs. */
    exportDecisionAsAdr(id: string): string;
    /** Record a structured failure for the diagnose step. */
    recordFailure(input: {
        context: string;
        attempted: string;
        failure_mode: string;
        root_cause: string;
        applicability_hint: string;
        alternative_taken?: string;
    }): Promise<void>;
    /** Failures relevant to a task description, open only. */
    lookupFailures(taskContext: string, limit?: number): Promise<Array<{
        context: string;
        attempted: string;
        failure_mode: string;
        root_cause: string;
    }>>;
    /**
     * Store a reflection: a `learned-reflection` entry plus a memoryjs reflection
     * record.
     *
     * memoryjs's own dedup hash covers only the scope and the sorted evidence, so
     * two different conclusions over the same evidence would collapse into one.
     * The adapter therefore keeps its own hash over
     * `(scope, project, sorted evidence, NFKC summary)`: an exact match is reported
     * as `duplicate`, and a same-evidence different-summary reflection gets the
     * entry's own name appended to the evidence so the two records stay distinct.
     *
     * Additive only: a duplicate returns the existing entry's name and writes
     * nothing.
     */
    createReflection(input: CreateReflectionInput): Promise<CreateReflectionResult>;
    /**
     * Write the memoryjs reflection record that accompanies a
     * `learned-reflection` entry written by someone else (e.g.
     * `knowledge-db.insertKnowledgeEntry`).
     *
     * memoryjs's content hash covers only the scope and the sorted evidence, so a
     * second record over the same evidence would otherwise collapse into the
     * first. The entry id is appended to the evidence whenever an existing record
     * already claims that set.
     */
    recordReflectionRecord(input: {
        scope: 'project' | 'global';
        project: string;
        entryId: string;
        summary: string;
        evidence: string[];
        confidence: Confidence;
    }): Promise<void>;
    /** Find a learned-reflection entry carrying this adapter hash. */
    private findReflectionByHash;
    /** Find a memoryjs reflection record over the same scope and evidence set. */
    private findReflectionByEvidence;
    /** Reflections currently readable, oldest first. */
    listReflections(): Promise<Array<{
        id: string;
        scope: string;
        summary: string;
        evidence: string[];
    }>>;
}
export interface OpenKnowledgeStoreOptions {
    /** Override the file path (tests). Defaults to `getKnowledgeDbPath()`. */
    dbPath?: string;
}
/**
 * Open the knowledge store. Construction is synchronous; memoryjs loads the
 * graph lazily and the constructor starts no timers.
 */
export declare function openKnowledgeStore(options?: OpenKnowledgeStoreOptions): KnowledgeStore;
