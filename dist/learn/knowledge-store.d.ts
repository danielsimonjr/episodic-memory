/**
 * The knowledge store: learned entries, their citations and the records the
 * learner keeps beside them (heuristics, procedures, decisions, failures,
 * reflections, project context), on better-sqlite3 directly.
 *
 * Every other module sees `KnowledgeEntry` from `./types.js`; this module is
 * the only one that knows how an entry is laid out on disk.
 *
 * On-disk layout. Two tables, `entities` and `relations`, in the shape the
 * previous adapter (`@danielsimonjr/memoryjs` 4.x) created them, so a
 * `knowledge.db` written before this module can be opened by it unchanged:
 *
 * - a learned entry is one `entities` row per version, named
 *   `learned:<kind>:<project>:<slug>:v<n>`, with its fields as `key: value`
 *   observation lines and `kind:` / `project:` / `trust:` / `status:` tags;
 * - an `exchange:<id>` or `attempt:<id>` reference row is cited through a
 *   `cites` relation;
 * - every other record is one row whose typed payload lives in the
 *   `agentMetadata` JSON column (`heuristicRecord`, `decisionRecord`, ...).
 *
 * Reads go straight to SQLite, so a write through one handle is visible to
 * every other open handle at once. Construction is synchronous and starts no
 * timers; the methods stay `async` because callers already await them.
 */
import type { Confidence, KnowledgeEntry, KnowledgeKind, KnowledgeStatus, ProcedureStepSpec, SourceRef, TrustLevel, ValidationRecord } from './types.js';
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
export interface ProcedureStep {
    order: number;
    action: string;
    parameters: Record<string, string>;
}
export interface ProcedureView {
    id: string;
    name: string;
    description: string;
    steps: ProcedureStep[];
    triggers: string[];
    successRate: number | null;
    executionCount: number | null;
}
/** One `entities` row, decoded. */
export interface StoredEntity {
    name: string;
    entityType: string;
    observations: string[];
    tags: string[];
    importance: number | null;
    createdAt: string;
    lastModified: string;
    projectId: string | null;
    /** Row write counter, unrelated to the logical entry version. */
    version: number;
    parentEntityName: string | null;
    rootEntityName: string | null;
    isLatest: boolean;
    supersededBy: string | null;
    metadata: Record<string, unknown>;
}
/**
 * Parse an entity back into the `KnowledgeEntry` shape.
 *
 * The logical `version` comes from the `version:` observation (and, failing
 * that, from the `:v<n>` suffix of the name), never from the row's write
 * counter.
 */
export declare function parseEntity(entity: StoredEntity): KnowledgeEntry | null;
/** `learned:<kind>:<project>:<slug>:v<n>`. */
export declare function entryName(kind: KnowledgeKind, project: string, slug: string, version: number): string;
/** `learned:<kind>:<project>:<slug>:v1`, the root of the version chain. */
export declare function rootName(kind: KnowledgeKind, project: string, slug: string): string;
/** `proc:<project>:<slug>`, the id a procedure skill's record carries. */
export declare function procedureIdFor(project: string, slug: string): string;
export declare class KnowledgeStore {
    private readonly db;
    private closed;
    private constructor();
    /** Open (creating when absent) the store at `dbPath`. */
    static create(dbPath: string): KnowledgeStore;
    /** Release the database handle. Idempotent. */
    close(): void;
    /** PII redaction, for `knowledge-db` and the gates to reuse. */
    redactPii(text: string): string;
    private readEntity;
    private entitiesOfType;
    /** Every learned entity, in insertion order. */
    private learnedEntities;
    /** Insert the rows that do not exist yet. An existing name is left as it is. */
    private insertEntities;
    /** Overwrite the mutable columns of one row and bump its write counter. */
    private updateEntity;
    /** Insert the relations that do not exist yet. Both endpoints must exist. */
    private insertRelations;
    private relationsFrom;
    /** The raw entity, for tests and for `knowledge-db`'s duplicate check. */
    getRawEntity(name: string): Promise<RawEntityView | null>;
    /**
     * Write one entity for one version, plus the reference entities and `cites`
     * relations it needs, in one transaction. An entity that already exists
     * under this name is left untouched.
     */
    putEntry(entry: KnowledgeEntry, reflectionHash?: string): Promise<void>;
    /** Create an `attempt:<id>` reference entity, citing it from `from`. */
    citeAttempt(from: string, attemptId: number, taskId: number, runId: string): Promise<void>;
    /** Re-render the observations, tags and lifecycle of one entry after `mutate`. */
    private rewriteEntity;
    /** Set `supersededBy` and clear `isLatest` on the older version. */
    supersede(olderName: string, newerName: string): Promise<void>;
    /** Set the status (and the `status:` observation and tag) of one entry. */
    setStatus(name: string, status: KnowledgeStatus): Promise<void>;
    /** Set the trust level (observation and tag) of one entry. */
    setTrust(name: string, trust: TrustLevel): Promise<void>;
    /**
     * Activate one entry in a single write: status, trust and validation
     * together, so a failed write cannot leave two of the three applied.
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
    /** The latest version of a `(kind, project, slug)` chain, by logical version. */
    getBySlug(kind: KnowledgeKind, project: string, slug: string): Promise<KnowledgeEntry | null>;
    /**
     * Learned entries that are still chain-visible (`isLatest`), any status. A
     * candidate revision does not clear the parent's `isLatest`, so both rows
     * are returned until `supersede`. Callers that want one row per chain use
     * `getBySlug`; callers that want lifecycle use `listByStatus`.
     */
    listEntries(): Promise<KnowledgeEntry[]>;
    /**
     * Every learned entry with a given status, including superseded and older
     * versions. Lifecycle bookkeeping (`activate`'s supersede sweep) must see
     * those rows, so this deliberately does not filter on `isLatest`.
     */
    listByStatus(statuses: KnowledgeStatus[], kinds?: KnowledgeKind[], project?: string): Promise<KnowledgeEntry[]>;
    /**
     * Text search over active, unsuperseded, chain-visible entries.
     *
     * Deterministic term overlap: an entry scores one point per distinct query
     * term found in its slug, title, description, body or scope, with total
     * occurrences and then the id as tie-breakers. There is no document
     * frequency weighting, so a store with one or two entries still answers.
     */
    search(query: string, options?: SearchOptions): Promise<KnowledgeEntry[]>;
    /** Search reads the tables directly, so there is no index to rebuild. */
    buildIndex(): Promise<void>;
    private heuristicRecord;
    private allHeuristics;
    /** Add an instruction line as a heuristic record. Returns its id. */
    addHeuristic(input: {
        condition: string;
        action: string;
        priority?: number;
        initialConfidence?: number;
    }): Promise<string>;
    private updateHeuristic;
    /** Reinforce a heuristic after a kept validation: support up, confidence toward 1. */
    reinforceHeuristic(id: string): Promise<boolean>;
    /** Record a contradiction against a heuristic on a drop: confidence down by a fifth. */
    contradictHeuristic(id: string): Promise<boolean>;
    /**
     * Every pair of heuristics whose conditions overlap by at least half of the
     * larger token set but whose actions differ: a `contradiction` when one
     * action negates the other, an `overlap` otherwise.
     */
    detectHeuristicConflicts(): Promise<Array<{
        a: string;
        b: string;
        kind: 'overlap' | 'contradiction';
        reason: string;
    }>>;
    /** A heuristic by id, or null. */
    getHeuristic(id: string): HeuristicView | null;
    /** Store a procedure skill's steps. Additive: an existing id is never rewritten. */
    putProcedure(input: {
        id: string;
        name: string;
        description: string;
        steps: ProcedureStepSpec[];
        triggers: string[];
    }): Promise<void>;
    /** A stored procedure, or null. */
    getProcedure(id: string): Promise<ProcedureView | null>;
    /**
     * Steps of a procedure the previous adapter wrote as one `procedure-step`
     * row per step, linked by `has_step` relations, ordered by `[order]`.
     */
    private loadStepEntities;
    /**
     * Rank stored procedures against a context description by token overlap
     * between the context and the procedure's name and triggers.
     */
    matchProcedures(context: string, ids: string[]): Promise<ProcedureMatchLike[]>;
    /** Telemetry only: fold whether a procedure skill's attempt succeeded into its success rate. */
    refineProcedure(id: string, succeeded: boolean, _notes?: string): Promise<void>;
    private projectContext;
    /** Upsert a project's structured context (learner prompts only). Arrays append and dedup. */
    upsertProjectContext(project: string, input: {
        facts?: string[];
        conventions?: string[];
        glossary?: Array<{
            term: string;
            definition: string;
        }>;
    }): Promise<void>;
    /** The project's context rendered as prose, cut to `budgetChars`. */
    forContext(project: string, budgetChars?: number): Promise<string>;
    private decisionRecord;
    /** Propose a decision for an edit. Returns the decision id. */
    proposeDecision(input: {
        context: string;
        decision: string;
        alternatives: string[];
        consequences: string[];
        sourceProjectId?: string;
    }): Promise<string>;
    private transitionDecision;
    /** Accept a proposed decision (a kept edit). */
    acceptDecision(id: string): Promise<boolean>;
    /** Reject a proposed decision (a dropped edit). */
    rejectDecision(id: string, reason: string): Promise<boolean>;
    /** Supersede an accepted decision with a newer one. */
    supersedeDecision(id: string, by: string): Promise<boolean>;
    /** A decision by id, or null. */
    getDecision(id: string): DecisionView | null;
    /** A decision rendered as ADR markdown. Throws when the id is unknown. */
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
    /**
     * Open failures relevant to a task description, best first: each
     * whitespace-separated token of the task scores 3 in the applicability
     * hint, 2 in the context and 1 in the attempted action.
     */
    lookupFailures(taskContext: string, limit?: number): Promise<Array<{
        context: string;
        attempted: string;
        failure_mode: string;
        root_cause: string;
    }>>;
    /**
     * Store a reflection: a `learned-reflection` entry plus a reflection record.
     *
     * The dedup hash covers `(scope, project, sorted evidence, NFKC summary)`:
     * an exact match is reported as `duplicate` and writes nothing, while a
     * same-evidence different-summary reflection is stored as its own entry
     * and record. Additive only.
     */
    createReflection(input: CreateReflectionInput): Promise<CreateReflectionResult>;
    /**
     * Write the reflection record that accompanies a `learned-reflection` entry
     * written by someone else (e.g. `knowledge-db.insertKnowledgeEntry`).
     */
    recordReflectionRecord(input: {
        scope: 'project' | 'global';
        project: string;
        entryId: string;
        summary: string;
        evidence: string[];
        confidence: Confidence;
    }): Promise<void>;
    private insertReflectionRecord;
    /** Find a learned-reflection entry carrying this dedup hash. */
    private findReflectionByHash;
    /** Reflection records, oldest first. */
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
/** Open the knowledge store. Synchronous; starts no timers. */
export declare function openKnowledgeStore(options?: OpenKnowledgeStoreOptions): KnowledgeStore;
