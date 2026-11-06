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

import fs from 'fs';
import path from 'path';
import { createHash } from 'node:crypto';
// Root import only: the repo's node10 module resolution ignores the package
// `exports` map, so a subpath such as `@danielsimonjr/memoryjs/sqlite` fails to
// typecheck.
import { ManagerContext, PiiRedactor, SQLiteStorage } from '@danielsimonjr/memoryjs';
import type { Entity, MemorySource, SearchResult } from '@danielsimonjr/memoryjs';
import { getKnowledgeDbPath } from '../paths.js';
import type {
  Confidence,
  KnowledgeEntry,
  KnowledgeKind,
  KnowledgeStatus,
  ProcedureStepSpec,
  SourceRef,
  TrustLevel,
  ValidationRecord,
} from './types.js';

/** Thrown when memoryjs does not come up the way this adapter requires. */
export class KnowledgeStoreMisconfigured extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'KnowledgeStoreMisconfigured';
  }
}

/** The exact observation key prefix for each field the adapter parses back. */
const OBS = {
  title: 'title: ',
  description: 'description: ',
  scope: 'scope: ',
  confidence: 'confidence: ',
  trust: 'trust: ',
  status: 'status: ',
  version: 'version: ',
  run: 'run: ',
  validation: 'validation: ',
  heuristic: 'heuristic: ',
  decision: 'decision: ',
  procedure: 'procedure: ',
  steps: 'steps: ',
  reflectionHash: 'reflection-hash: ',
  body: 'body: ',
} as const;

const IMPORTANCE_BY_CONFIDENCE: Record<Confidence, number> = { low: 3, medium: 5, high: 8 };

const LIFECYCLE_BY_STATUS: Record<KnowledgeStatus, 'draft' | 'published' | 'archived'> = {
  candidate: 'draft',
  active: 'published',
  retired: 'archived',
};

const STATUS_BY_LIFECYCLE: Record<'draft' | 'published' | 'archived', KnowledgeStatus> = {
  draft: 'candidate',
  published: 'active',
  archived: 'retired',
};

const RELIABILITY_BY_TRUST: Record<TrustLevel, number> = {
  unverified: 0.2,
  verified: 0.6,
  'ground-truth': 0.9,
};

/** memoryjs's reflection records take a numeric confidence in [0, 1]. */
const CONFIDENCE_SCORE: Record<Confidence, number> = { low: 0.3, medium: 0.6, high: 0.9 };

/** The entity-type prefix every learned entry shares. */
const ENTRY_TYPE_PREFIX = 'learned-';

const REFLECTION_TYPE = 'learned-reflection';

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
  attemptTasks?: Array<{ id: number; taskId: number }>;
}

export interface CreateReflectionResult {
  duplicate: boolean;
  id: string | null;
}

export interface ProcedureMatchLike {
  procedure: { id: string; name: string; description: string };
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
 * Run `fn` synchronously with every `MEMORY_*` key removed and exactly the two
 * values this store needs in place. The caller's environment is restored in
 * `finally`, including keys that were absent before.
 */
function withScopedMemoryEnv<T>(fn: () => T): T {
  const saved = new Map<string, string | undefined>();
  for (const key of Object.keys(process.env)) {
    if (key.startsWith('MEMORY_')) {
      saved.set(key, process.env[key]);
      delete process.env[key];
    }
  }
  process.env.MEMORY_STORAGE_TYPE = 'sqlite';
  process.env.MEMORY_EMBEDDING_PROVIDER = 'none';
  try {
    return fn();
  } finally {
    delete process.env.MEMORY_STORAGE_TYPE;
    delete process.env.MEMORY_EMBEDDING_PROVIDER;
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function observationValue(observations: readonly string[], prefix: string): string | null {
  const hit = observations.find(o => o.startsWith(prefix));
  return hit === undefined ? null : hit.slice(prefix.length);
}

function observationValues(observations: readonly string[], prefix: string): string[] {
  return observations.filter(o => o.startsWith(prefix)).map(o => o.slice(prefix.length));
}

function parseJson<T>(raw: string | null, fallback: T): T {
  if (raw === null) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function tagValue(tags: readonly string[], prefix: string): string | null {
  const hit = tags.find(t => t.startsWith(prefix));
  return hit === undefined ? null : hit.slice(prefix.length);
}

/**
 * Parse an entity back into the `KnowledgeEntry` shape.
 *
 * The logical `version` comes from the `version:` observation (and, failing
 * that, from the `:v<n>` suffix of the name), never from `Entity.version`,
 * which memoryjs increments on every OCC-guarded write.
 */
export function parseEntity(entity: Entity): KnowledgeEntry | null {
  if (!entity.entityType.startsWith(ENTRY_TYPE_PREFIX)) return null;
  const name = entity.name;
  const nameMatch = /^learned:([^:]+):(.*):([^:]+):v(\d+)$/.exec(name);
  const typeKind = entity.entityType.slice(ENTRY_TYPE_PREFIX.length);
  const kind = (nameMatch?.[1] ?? typeKind) as KnowledgeKind;
  const observations = entity.observations ?? [];
  const tags = entity.tags ?? [];

  const project = entity.projectId ?? nameMatch?.[2] ?? '*';
  const slug = nameMatch?.[3] ?? '';
  const versionFromName = nameMatch ? Number(nameMatch[4]) : 1;
  const versionFromObs = Number(observationValue(observations, OBS.version));
  const version =
    Number.isFinite(versionFromObs) && versionFromObs > 0 ? versionFromObs : versionFromName;

  const statusFromObs = observationValue(observations, OBS.status) as KnowledgeStatus | null;
  const lifecycle = entity.lifecycleStatus ?? 'published';
  const statusFromTag = tagValue(tags, 'status:') as KnowledgeStatus | null;
  const status: KnowledgeStatus = statusFromObs ?? statusFromTag ?? STATUS_BY_LIFECYCLE[lifecycle];

  const trustFromObs = observationValue(observations, OBS.trust) as TrustLevel | null;
  const trustFromTag = tagValue(tags, 'trust:') as TrustLevel | null;
  const trust: TrustLevel = trustFromObs ?? trustFromTag ?? 'unverified';

  const validation = parseJson<ValidationRecord | null>(
    observationValue(observations, OBS.validation),
    null
  );

  const steps = parseJson<ProcedureStepSpec[] | null>(observationValue(observations, OBS.steps), null);

  const entry: KnowledgeEntry = {
    id: name,
    kind,
    project,
    slug,
    version,
    title: observationValue(observations, OBS.title) ?? '',
    description: observationValue(observations, OBS.description) ?? '',
    body: observationValues(observations, OBS.body).join('\n'),
    scope: observationValue(observations, OBS.scope) ?? '',
    confidence: (observationValue(observations, OBS.confidence) as Confidence | null) ?? 'low',
    trust,
    sources: [],
    status,
    runId: observationValue(observations, OBS.run) ?? '',
    createdAt: entity.createdAt ?? '',
    supersededBy: entity.supersededBy ?? null,
    validation,
    heuristicIds: observationValues(observations, OBS.heuristic),
    decisionId: observationValue(observations, OBS.decision),
    procedureId: observationValue(observations, OBS.procedure),
  };
  if (steps) entry.steps = steps;
  return entry;
}

/**
 * Build the observation lines for an entry.
 *
 * `reflectionHash` is passed separately from the parsed entry because it is not a
 * `KnowledgeEntry` field: it is the adapter's own dedup marker, and it must
 * survive an update, so callers that rewrite an entity re-read it from the
 * existing observations and hand it back here.
 */
function buildObservations(entry: KnowledgeEntry, reflectionHash?: string): string[] {
  const observations: string[] = [
    `${OBS.title}${entry.title}`,
    `${OBS.description}${entry.description}`,
    `${OBS.scope}${entry.scope}`,
    `${OBS.confidence}${entry.confidence}`,
    `${OBS.trust}${entry.trust}`,
    `${OBS.status}${entry.status}`,
    `${OBS.version}${entry.version}`,
    `${OBS.run}${entry.runId}`,
  ];
  if (entry.validation) observations.push(`${OBS.validation}${JSON.stringify(entry.validation)}`);
  for (const id of entry.heuristicIds) observations.push(`${OBS.heuristic}${id}`);
  if (entry.decisionId) observations.push(`${OBS.decision}${entry.decisionId}`);
  if (entry.procedureId) observations.push(`${OBS.procedure}${entry.procedureId}`);
  if (entry.steps) observations.push(`${OBS.steps}${JSON.stringify(entry.steps)}`);
  if (reflectionHash) observations.push(`${OBS.reflectionHash}${reflectionHash}`);
  for (const line of entry.body.split('\n')) observations.push(`${OBS.body}${line}`);
  return observations;
}

function buildTags(entry: KnowledgeEntry): string[] {
  return [
    `kind:${entry.kind}`,
    `project:${entry.project}`,
    `trust:${entry.trust}`,
    `status:${entry.status}`,
  ];
}

/** `learned:<kind>:<project>:<slug>:v<n>`. */
export function entryName(kind: KnowledgeKind, project: string, slug: string, version: number): string {
  return `learned:${kind}:${project}:${slug}:v${version}`;
}

/** `learned:<kind>:<project>:<slug>:v1`, the root of the version chain. */
export function rootName(kind: KnowledgeKind, project: string, slug: string): string {
  return entryName(kind, project, slug, 1);
}

/** `proc:<project>:<slug>`, the id a procedure skill's record carries. */
export function procedureIdFor(project: string, slug: string): string {
  return `proc:${project}:${slug}`;
}

export class KnowledgeStore {
  private readonly ctx: ManagerContext;
  private readonly pii = new PiiRedactor();
  private closed = false;

  /** The concrete storage class memoryjs built. `SQLiteStorage` means sqlite. */
  readonly storageConstructorName: string;
  /** Asserted once, at construction. */
  readonly semanticSearchIsNull: boolean;

  private constructor(ctx: ManagerContext, storageConstructorName: string, semanticSearchIsNull: boolean) {
    this.ctx = ctx;
    this.storageConstructorName = storageConstructorName;
    this.semanticSearchIsNull = semanticSearchIsNull;
  }

  /**
   * Constructing is synchronous (memoryjs loads the graph lazily and the
   * constructor starts no timers), but every method that touches the store is
   * async.
   */
  static create(dbPath: string): KnowledgeStore {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true, mode: 0o700 });

    let storageName = '';
    let semanticIsNull = false;
    let builtStorage: unknown = null;

    const ctx = withScopedMemoryEnv(() => {
      const built = new ManagerContext({
        storagePath: dbPath,
        storageType: 'sqlite',
        defaultProjectId: '*',
      });
      storageName = built.storage.constructor.name.replace(/^_+/, '');
      // Read once, only to assert it is null. Never touch hybridSearchManager.
      semanticIsNull = built.semanticSearch === null;
      builtStorage = built.storage;
      return built;
    });

    // The class is exported from the package root, so `instanceof` is exact; the
    // name check is a cheap independent second signal (the bundler prefixes the
    // runtime class name with an underscore).
    if (!(builtStorage instanceof SQLiteStorage) || storageName !== 'SQLiteStorage') {
      try {
        ctx.close();
      } catch {
        // best effort
      }
      throw new KnowledgeStoreMisconfigured(
        `knowledge store opened ${storageName || 'an unknown storage'} instead of SQLiteStorage`
      );
    }
    if (!semanticIsNull) {
      try {
        ctx.close();
      } catch {
        // best effort
      }
      throw new KnowledgeStoreMisconfigured(
        'knowledge store has a semantic search backend; MEMORY_EMBEDDING_PROVIDER=none was not honoured'
      );
    }

    return new KnowledgeStore(ctx, storageName, semanticIsNull);
  }

  /** Release the underlying storage handle. Idempotent. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    try {
      this.ctx.close();
    } catch {
      // Closing twice, or a backend without a handle, is not an error.
    }
  }

  /** PII redaction, for `knowledge-db` and the gates to reuse. */
  redactPii(text: string): string {
    return this.pii.redact(text);
  }

  /** The raw entity, for tests and for `knowledge-db`'s duplicate check. */
  async getRawEntity(name: string): Promise<RawEntityView | null> {
    const entity = await this.ctx.entityManager.getEntity(name);
    if (!entity) return null;
    return {
      name: entity.name,
      entityType: entity.entityType,
      observations: [...(entity.observations ?? [])],
      tags: [...(entity.tags ?? [])],
      isLatest: entity.isLatest !== false,
      parentEntityName: entity.parentEntityName ?? null,
      supersededBy: entity.supersededBy ?? null,
    };
  }

  /**
   * Write one entity for one version, plus the reference entities and `cites`
   * relations it needs. References are created first: `createRelations`
   * validates that both endpoints exist.
   */
  async putEntry(entry: KnowledgeEntry, reflectionHash?: string): Promise<void> {
    const name = entry.id;
    const isRevision = entry.version > 1;
    const root = rootName(entry.kind, entry.project, entry.slug);
    const parent = isRevision ? entryName(entry.kind, entry.project, entry.slug, entry.version - 1) : undefined;

    await this.ensureExchangeRefs(entry.sources);

    const entity: Entity = {
      name,
      entityType: `${ENTRY_TYPE_PREFIX}${entry.kind}`,
      projectId: entry.project,
      lifecycleStatus: LIFECYCLE_BY_STATUS[entry.status],
      importance: IMPORTANCE_BY_CONFIDENCE[entry.confidence],
      tags: buildTags(entry),
      rootEntityName: root,
      isLatest: true,
      observations: buildObservations(entry, reflectionHash),
      // `source` is a `MemorySource` on memoryjs's `AgentEntity`, not a field of
      // the core `Entity` type, so this is cast. Trust is carried by the
      // `trust:` observation and tag, which is what the gates read; `source` is
      // provenance for memoryjs's own managers. If a future memoryjs drops it on
      // read-back that is not an error.
      source: {
        agentId: 'episodic-learn',
        timestamp: entry.createdAt || new Date().toISOString(),
        method: 'inferred',
        reliability: RELIABILITY_BY_TRUST[entry.trust],
        trustLevel: entry.trust,
      },
    } as Entity & { source: MemorySource };
    if (parent) entity.parentEntityName = parent;

    await this.ctx.entityManager.createEntities([entity]);

    // Creating a new version does not move the chain head on its own; without
    // this the parent stays `isLatest: true` and `getLatestVersion` keeps
    // returning v1. `supersededBy` is intentionally left alone here — that is
    // `supersede`'s job, and only `activate` decides a version has been replaced.
    if (parent) {
      const parentEntity = await this.ctx.entityManager.getEntity(parent);
      if (parentEntity && parentEntity.isLatest !== false) {
        await this.ctx.entityManager.updateEntity(
          parent,
          { isLatest: false },
          { expectedVersion: parentEntity.version ?? 1 }
        );
      }
    }

    await this.ctx.relationManager.createRelations(
      entry.sources.map(source => ({
        from: name,
        to: `exchange:${source.id}`,
        relationType: 'cites',
      }))
    );
  }

  /** Create an `exchange:<id>` reference entity when it is absent. */
  private async ensureExchangeRefs(sources: readonly SourceRef[]): Promise<void> {
    const missing: Entity[] = [];
    for (const source of sources) {
      const refName = `exchange:${source.id}`;
      const existing = await this.ctx.entityManager.getEntity(refName);
      if (existing) continue;
      missing.push({
        name: refName,
        entityType: 'exchange-ref',
        observations: [
          `path: ${source.path}`,
          `lines: ${source.lineStart}-${source.lineEnd}`,
          `session: ${source.sessionId ?? ''}`,
        ],
      });
    }
    if (missing.length > 0) await this.ctx.entityManager.createEntities(missing);
  }

  /** Create an `attempt:<id>` reference entity, citing it from `from`. */
  async citeAttempt(from: string, attemptId: number, taskId: number, runId: string): Promise<void> {
    const refName = `attempt:${attemptId}`;
    const existing = await this.ctx.entityManager.getEntity(refName);
    if (!existing) {
      await this.ctx.entityManager.createEntities([
        {
          name: refName,
          entityType: 'attempt-ref',
          observations: [`task: ${taskId}`, `run: ${runId}`],
        },
      ]);
    }
    await this.ctx.relationManager.createRelations([
      { from, to: refName, relationType: 'cites' },
    ]);
  }

  /**
   * Replace the observation set and the tags of an existing entity. The
   * `expectedVersion` is read immediately before the write: memoryjs's
   * `Entity.version` is unrelated to the logical entry version.
   */
  private async rewriteEntity(
    name: string,
    mutate: (entry: KnowledgeEntry, raw: RawEntityView) => void
  ): Promise<void> {
    const entity = await this.ctx.entityManager.getEntity(name);
    if (!entity) throw new Error(`knowledge entry not found: ${name}`);
    const parsed = parseEntity(entity);
    if (!parsed) throw new Error(`not a learned entry: ${name}`);
    const raw: RawEntityView = {
      name: entity.name,
      entityType: entity.entityType,
      observations: [...(entity.observations ?? [])],
      tags: [...(entity.tags ?? [])],
      isLatest: entity.isLatest !== false,
      parentEntityName: entity.parentEntityName ?? null,
      supersededBy: entity.supersededBy ?? null,
    };
    mutate(parsed, raw);

    // Carry the adapter's dedup marker across a rewrite; dropping it would make
    // a stored reflection look new to `findReflectionByHash`.
    const reflectionHash = observationValue(raw.observations, OBS.reflectionHash) ?? undefined;

    await this.ctx.entityManager.updateEntity(
      name,
      {
        observations: buildObservations(parsed, reflectionHash),
        tags: buildTags(parsed),
        importance: IMPORTANCE_BY_CONFIDENCE[parsed.confidence],
      },
      { expectedVersion: entity.version ?? 1 }
    );
    // `lifecycleStatus` is a separate guarded write so the state machine sees a
    // legal transition and a rejected one cannot leave the observations applied.
    if (entity.lifecycleStatus !== LIFECYCLE_BY_STATUS[parsed.status]) {
      const fresh = await this.ctx.entityManager.getEntity(name);
      await this.ctx.entityManager.updateEntity(
        name,
        { lifecycleStatus: LIFECYCLE_BY_STATUS[parsed.status] },
        { expectedVersion: fresh?.version ?? 1 }
      );
    }
  }

  /** Set `supersededBy` and clear `isLatest` on the older version. */
  async supersede(olderName: string, newerName: string): Promise<void> {
    const entity = await this.ctx.entityManager.getEntity(olderName);
    if (!entity) throw new Error(`knowledge entry not found: ${olderName}`);
    await this.ctx.entityManager.updateEntity(
      olderName,
      { supersededBy: newerName, isLatest: false },
      { expectedVersion: entity.version ?? 1 }
    );
  }

  /** Set the status (and the `status:` observation and tag) of one entry. */
  async setStatus(name: string, status: KnowledgeStatus): Promise<void> {
    await this.rewriteEntity(name, entry => {
      entry.status = status;
    });
  }

  /** Set the trust level (observation and tag) of one entry. */
  async setTrust(name: string, trust: TrustLevel): Promise<void> {
    await this.rewriteEntity(name, entry => {
      entry.trust = trust;
    });
  }

  /**
   * Activate one entry in a single guarded write: status, trust and validation
   * together, so a rejected write cannot leave two of the three applied.
   */
  async promote(
    name: string,
    trust: TrustLevel,
    validation: ValidationRecord | null
  ): Promise<void> {
    await this.rewriteEntity(name, entry => {
      entry.trust = trust;
      entry.validation = validation;
      entry.status = 'active';
    });
  }

  /** Record a validation record on one entry. */
  async setValidation(name: string, validation: ValidationRecord | null): Promise<void> {
    await this.rewriteEntity(name, entry => {
      entry.validation = validation;
    });
  }

  /** Record a decision id on one entry. */
  async setDecision(name: string, decisionId: string | null): Promise<void> {
    await this.rewriteEntity(name, entry => {
      entry.decisionId = decisionId;
    });
  }

  /** Record a procedure id on one entry. */
  async setProcedure(name: string, procedureId: string | null): Promise<void> {
    await this.rewriteEntity(name, entry => {
      entry.procedureId = procedureId;
    });
  }

  /** Record the heuristic ids of one entry. */
  async setHeuristics(name: string, heuristicIds: string[]): Promise<void> {
    await this.rewriteEntity(name, entry => {
      entry.heuristicIds = [...heuristicIds];
    });
  }

  /** Read one entry by entity name. */
  async getEntry(name: string): Promise<KnowledgeEntry | null> {
    const entity = await this.ctx.entityManager.getEntity(name);
    if (!entity) return null;
    return parseEntity(entity);
  }

  /** The latest version of a `(kind, project, slug)` chain. */
  async getBySlug(kind: KnowledgeKind, project: string, slug: string): Promise<KnowledgeEntry | null> {
    const root = rootName(kind, project, slug);
    const latest = await this.ctx.entityManager.getLatestVersion(root);
    if (!latest) return null;
    return parseEntity(latest);
  }

  /** Every learned entity. */
  private async allEntities(): Promise<Entity[]> {
    const graph = await this.ctx.storage.loadGraph();
    return graph.entities.filter((e: Entity) => e.entityType.startsWith(ENTRY_TYPE_PREFIX));
  }

  /** Every learned entry, latest versions only, any status. */
  async listEntries(): Promise<KnowledgeEntry[]> {
    const entities = await this.allEntities();
    return entities
      .filter(e => e.isLatest !== false)
      .map(parseEntity)
      .filter((e): e is KnowledgeEntry => e !== null);
  }

  /**
   * Every learned entry with a given status, including superseded and older
   * versions. Lifecycle bookkeeping (`activate`'s supersede sweep) must see
   * those rows, so this deliberately does not filter on `isLatest`.
   */
  async listByStatus(
    statuses: KnowledgeStatus[],
    kinds?: KnowledgeKind[],
    project?: string
  ): Promise<KnowledgeEntry[]> {
    const entities = await this.allEntities();
    return entities
      .map(parseEntity)
      .filter((entry): entry is KnowledgeEntry => entry !== null)
      .filter(entry => {
        if (!statuses.includes(entry.status)) return false;
        if (kinds && kinds.length > 0 && !kinds.includes(entry.kind)) return false;
        if (project !== undefined && entry.project !== project) return false;
        return true;
      });
  }

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
  async search(query: string, options: SearchOptions = {}): Promise<KnowledgeEntry[]> {
    const { kinds, project, limit = 10 } = options;
    const allowed = (entry: KnowledgeEntry): boolean => {
      if (kinds && kinds.length > 0 && !kinds.includes(entry.kind)) return false;
      if (project !== undefined && entry.project !== project && entry.project !== '*') return false;
      return entry.status === 'active' && entry.supersededBy === null;
    };

    const tags = kinds && kinds.length > 0 ? kinds.map(kind => `kind:${kind}`) : undefined;
    const ranked: SearchResult[] = await this.ctx.rankedSearch.searchNodesRanked(
      query,
      tags,
      undefined,
      undefined,
      Math.max(limit * 3, 1)
    );

    const seen = new Set<string>();
    const results: KnowledgeEntry[] = [];
    for (const hit of ranked) {
      if (results.length >= limit) break;
      if (hit.entity.isLatest === false) continue;
      const parsed = parseEntity(hit.entity);
      if (!parsed || !allowed(parsed) || seen.has(parsed.id)) continue;
      seen.add(parsed.id);
      results.push(parsed);
    }

    if (results.length >= limit) return results;

    const terms = query
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter(term => term.length > 0);
    if (terms.length === 0) return results;

    const candidates = (await this.listEntries()).filter(
      entry => allowed(entry) && !seen.has(entry.id)
    );

    const scored = candidates
      .map(entry => {
        const haystack = `${entry.slug} ${entry.title} ${entry.description} ${entry.body} ${entry.scope}`.toLowerCase();
        const hits = terms.filter(term => haystack.includes(term)).length;
        return { entry, hits };
      })
      .filter(row => row.hits > 0)
      .sort((a, b) => b.hits - a.hits || (a.entry.id < b.entry.id ? -1 : 1));

    for (const row of scored) {
      if (results.length >= limit) break;
      results.push(row.entry);
    }
    return results;
  }

  /**
   * Rebuild the search index.
   *
   * memoryjs constructs `RankedSearch` without a `storageDir`, so its
   * `buildIndex()` throws by design and its on-the-fly scoring path is always
   * current. This is a deliberate no-op that expresses the caller's intent
   * ("writes happened; make search see them") without a throw.
   */
  async buildIndex(): Promise<void> {
    return;
  }

  /** Add an instruction line as a heuristic record. Returns its id. */
  async addHeuristic(input: {
    condition: string;
    action: string;
    priority?: number;
    initialConfidence?: number;
  }): Promise<string> {
    return this.ctx.heuristicManager.add({
      condition: input.condition,
      action: input.action,
      priority: input.priority,
      initialConfidence: input.initialConfidence,
    });
  }

  /** Reinforce an instruction's heuristic after a kept validation. */
  async reinforceHeuristic(id: string): Promise<boolean> {
    const result = await this.ctx.heuristicManager.reinforce(id);
    return result === 'updated';
  }

  /** Record a contradiction against an instruction's heuristic on a drop. */
  async contradictHeuristic(id: string): Promise<boolean> {
    const result = await this.ctx.heuristicManager.recordContradiction(id);
    return result === 'updated';
  }

  /** Every heuristic conflict, for the merge step's conflict resolution. */
  async detectHeuristicConflicts(): Promise<
    Array<{ a: string; b: string; kind: 'overlap' | 'contradiction'; reason: string }>
  > {
    const conflicts = await this.ctx.heuristicManager.detectConflicts();
    return conflicts.map(c => ({ a: c.a.id, b: c.b.id, kind: c.kind, reason: c.reason }));
  }

  /** A heuristic by id, or null. */
  getHeuristic(id: string): HeuristicView | null {
    const found = this.ctx.heuristicManager.get(id);
    if (!found) return null;
    return {
      id: found.id,
      condition: found.condition,
      action: found.action,
      support: found.support,
      contradictions: found.contradictions,
      confidence: found.confidence,
    };
  }

  /** Store a procedure skill's steps. Returns the procedure id. */
  async putProcedure(input: {
    id: string;
    name: string;
    description: string;
    steps: ProcedureStepSpec[];
    triggers: string[];
  }): Promise<void> {
    const existing = await this.ctx.procedureManager.getProcedure(input.id);
    if (existing) return; // additive: never rewrite a stored procedure here
    await this.ctx.procedureManager.addProcedure({
      id: input.id,
      name: input.name,
      description: input.description,
      steps: input.steps.map((step, index) => ({
        order: index + 1,
        action: step.action,
        parameters: step.parameters,
      })),
      triggers: input.triggers,
    });
  }

  /** A stored procedure, or null. */
  async getProcedure(id: string): Promise<{
    id: string;
    name: string;
    description: string;
    steps: Array<{ order: number; action: string; parameters: Record<string, string> }>;
    triggers: string[];
    successRate: number | null;
    executionCount: number | null;
  } | null> {
    const found = await this.ctx.procedureManager.getProcedure(id);
    if (!found) return null;
    return {
      id: found.id,
      name: found.name,
      description: found.description,
      steps: found.steps.map(s => ({ order: s.order, action: s.action, parameters: s.parameters })),
      triggers: [...(found.triggers ?? [])],
      successRate: found.successRate ?? null,
      executionCount: found.executionCount ?? null,
    };
  }

  /** Rank stored procedures against a context description. */
  async matchProcedures(context: string, ids: string[]): Promise<ProcedureMatchLike[]> {
    const procedures = [];
    for (const id of ids) {
      const proc = await this.ctx.procedureManager.getProcedure(id);
      if (proc) procedures.push(proc);
    }
    if (procedures.length === 0) return [];
    const matches = await this.ctx.procedureManager.matchProcedure(context, procedures, 0.01);
    return matches.map(m => ({
      procedure: {
        id: m.procedure.id,
        name: m.procedure.name,
        description: m.procedure.description,
      },
      score: m.score,
    }));
  }

  /** Telemetry only: record whether a procedure skill's attempt succeeded. */
  async refineProcedure(id: string, succeeded: boolean, notes?: string): Promise<void> {
    const existing = await this.ctx.procedureManager.getProcedure(id);
    if (!existing) return;
    await this.ctx.procedureManager.refineProcedure(id, { succeeded, notes });
  }

  /** Upsert a project's structured context (learner prompts only). */
  async upsertProjectContext(
    project: string,
    input: {
      facts?: string[];
      conventions?: string[];
      glossary?: Array<{ term: string; definition: string }>;
    }
  ): Promise<void> {
    await this.ctx.projectContextManager.upsert(project, input);
  }

  /** The project's context rendered as prose, budgeted. */
  async forContext(project: string, budgetChars?: number): Promise<string> {
    return this.ctx.projectContextManager.forContext(project, { budgetChars });
  }

  /** Propose a decision for an edit. Returns the decision id. */
  async proposeDecision(input: {
    context: string;
    decision: string;
    alternatives: string[];
    consequences: string[];
    sourceProjectId?: string;
  }): Promise<string> {
    const record = await this.ctx.decisionManager.propose({
      context: input.context,
      decision: input.decision,
      // 4.5.0 takes arrays here, not strings.
      alternatives: input.alternatives,
      consequences: input.consequences,
      sourceProjectId: input.sourceProjectId,
    });
    return record.id;
  }

  /** Accept a proposed decision (a kept edit). */
  async acceptDecision(id: string): Promise<boolean> {
    return (await this.ctx.decisionManager.accept(id)) === 'accepted';
  }

  /** Reject a proposed decision (a dropped edit). */
  async rejectDecision(id: string, reason: string): Promise<boolean> {
    return (await this.ctx.decisionManager.reject(id, reason)) === 'rejected';
  }

  /** Supersede an accepted decision with a newer one. */
  async supersedeDecision(id: string, by: string): Promise<boolean> {
    // memoryjs brands DecisionId with a phantom symbol it does not export from
    // the package root, so the id is passed through a parameter-derived cast.
    type DecisionIdParam = Parameters<typeof this.ctx.decisionManager.supersede>[1];
    return (
      (await this.ctx.decisionManager.supersede(
        id as unknown as DecisionIdParam,
        by as unknown as DecisionIdParam
      )) === 'superseded'
    );
  }

  /** A decision by id, or null. */
  getDecision(id: string): DecisionView | null {
    const found = this.ctx.decisionManager.get(id);
    if (!found) return null;
    return {
      id: found.id,
      status: found.status,
      context: found.context,
      decision: found.decision,
      alternatives: [...found.alternatives],
      consequences: [...found.consequences],
    };
  }

  /** A decision rendered as ADR markdown. Synchronous in memoryjs. */
  exportDecisionAsAdr(id: string): string {
    return this.ctx.decisionManager.exportAsAdrMarkdown(id);
  }

  /** Record a structured failure for the diagnose step. */
  async recordFailure(input: {
    context: string;
    attempted: string;
    failure_mode: string;
    root_cause: string;
    applicability_hint: string;
    alternative_taken?: string;
  }): Promise<void> {
    await this.ctx.failureManager.record({
      context: input.context,
      attempted: input.attempted,
      failure_mode: input.failure_mode,
      root_cause: input.root_cause,
      applicability_hint: input.applicability_hint,
      ...(input.alternative_taken !== undefined
        ? { alternative_taken: input.alternative_taken }
        : {}),
    });
  }

  /** Failures relevant to a task description, open only. */
  async lookupFailures(
    taskContext: string,
    limit = 5
  ): Promise<Array<{ context: string; attempted: string; failure_mode: string; root_cause: string }>> {
    const records = await this.ctx.failureManager.lookupForTask(taskContext, {
      limit,
      status: 'open',
    });
    return records.map(r => ({
      context: r.context,
      attempted: r.attempted,
      failure_mode: r.failure_mode,
      root_cause: r.root_cause,
    }));
  }

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
  async createReflection(input: CreateReflectionInput): Promise<CreateReflectionResult> {
    const hash = reflectionHash(input);
    const existing = await this.findReflectionByHash(hash);
    if (existing) return { duplicate: true, id: existing };

    const evidence = [...input.evidence];
    if (evidence.length === 0) evidence.push(input.summary);
    for (const attempt of input.attempts ?? []) evidence.push(`attempt:${attempt}`);

    // Version the reflection entry within its own chain so a later run can
    // revise the same conclusion without touching the earlier one.
    const slug = input.slug ?? reflectionSlug(input.summary);
    const previous = await this.getBySlug('reflection', input.project, slug);
    const version = previous ? previous.version + 1 : 1;
    const id = entryName('reflection', input.project, slug, version);

    const entry: KnowledgeEntry = {
      id,
      kind: 'reflection',
      project: input.project,
      slug,
      version,
      title: input.title ?? firstLine(input.summary),
      description: input.description ?? firstLine(input.summary),
      body: input.summary,
      scope: input.scopeText ?? (input.scope === 'global' ? 'all projects' : input.project),
      confidence: input.confidence,
      trust: input.trust ?? 'unverified',
      sources: input.sources ?? [],
      status: input.status ?? 'candidate',
      runId: input.runId ?? '',
      createdAt: new Date().toISOString(),
      supersededBy: null,
      validation: null,
      heuristicIds: [],
      decisionId: null,
      procedureId: null,
    };

    await this.putEntry(entry, hash);

    for (const attempt of input.attempts ?? []) {
      const taskId = input.attemptTasks?.find(a => a.id === attempt)?.taskId ?? 0;
      await this.citeAttempt(id, attempt, taskId, entry.runId);
    }

    // A same-evidence different-summary reflection is stored with the entry name
    // appended to the evidence so memoryjs's content hash does not collapse it.
    const chosenEvidence = (await this.findReflectionByEvidence(input.scope, evidence))
      ? [...evidence, id]
      : evidence;

    await this.ctx.reflectionManager.create({
      scope: input.scope,
      evidence: chosenEvidence,
      summary: input.summary,
      generalization_confidence: RELIABILITY_BY_TRUST[entry.trust],
      sourceProjectId: input.project,
    });

    return { duplicate: false, id };
  }

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
  async recordReflectionRecord(input: {
    scope: 'project' | 'global';
    project: string;
    entryId: string;
    summary: string;
    evidence: string[];
    confidence: Confidence;
  }): Promise<void> {
    const evidence = input.evidence.length > 0 ? [...input.evidence] : [input.entryId];
    const chosenEvidence = (await this.findReflectionByEvidence(input.scope, evidence))
      ? [...evidence, input.entryId]
      : evidence;
    await this.ctx.reflectionManager.create({
      scope: input.scope,
      evidence: chosenEvidence,
      summary: input.summary,
      generalization_confidence: CONFIDENCE_SCORE[input.confidence],
      sourceProjectId: input.project,
    });
  }

  /** Find a learned-reflection entry carrying this adapter hash. */
  private async findReflectionByHash(hash: string): Promise<string | null> {
    const graph = await this.ctx.storage.loadGraph();
    const hit = graph.entities.find(
      (e: Entity) =>
        e.entityType === REFLECTION_TYPE &&
        (e.observations ?? []).includes(`${OBS.reflectionHash}${hash}`)
    );
    return hit?.name ?? null;
  }

  /** Find a memoryjs reflection record over the same scope and evidence set. */
  private async findReflectionByEvidence(
    scope: 'project' | 'global',
    evidence: string[]
  ): Promise<string | null> {
    const sorted = [...evidence].sort();
    const records = await this.ctx.reflectionManager.list({ includeArchived: true });
    const hit = records.find(
      r => r.scope === scope && [...r.evidence].sort().join('\u0000') === sorted.join('\u0000')
    );
    return hit?.id ?? null;
  }

  /** Reflections currently readable, oldest first. */
  async listReflections(): Promise<Array<{ id: string; scope: string; summary: string; evidence: string[] }>> {
    const records = await this.ctx.reflectionManager.list();
    return records.map(r => ({
      id: r.id,
      scope: r.scope,
      summary: r.summary,
      evidence: [...r.evidence],
    }));
  }
}

/** The adapter hash over `(scope, project, sorted evidence, NFKC summary)`. */
function reflectionHash(input: CreateReflectionInput): string {
  const evidence = [...input.evidence].sort().join('|');
  const summary = input.summary.normalize('NFKC');
  return createHash('sha256')
    .update(`${input.scope}|${input.project}|${evidence}|${summary}`)
    .digest('hex');
}

/** A filesystem-safe slug derived from a reflection's summary. */
function reflectionSlug(summary: string): string {
  const slug = summary
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
    .replace(/-+$/g, '');
  return slug || 'reflection';
}

function firstLine(text: string): string {
  const line = text.split('\n')[0]?.trim() ?? '';
  return line.length > 0 ? line : text.trim().slice(0, 80);
}

export interface OpenKnowledgeStoreOptions {
  /** Override the file path (tests). Defaults to `getKnowledgeDbPath()`. */
  dbPath?: string;
}

/**
 * Open the knowledge store. Construction is synchronous; memoryjs loads the
 * graph lazily and the constructor starts no timers.
 */
export function openKnowledgeStore(options: OpenKnowledgeStoreOptions = {}): KnowledgeStore {
  return KnowledgeStore.create(options.dbPath ?? getKnowledgeDbPath());
}
