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
import fs from 'fs';
import path from 'path';
import { createHash, randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import { getKnowledgeDbPath } from '../paths.js';
import { redactPii } from './pii-redactor.js';
/** The exact observation key prefix for each field the store parses back. */
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
};
const IMPORTANCE_BY_CONFIDENCE = { low: 3, medium: 5, high: 8 };
const LIFECYCLE_BY_STATUS = {
    candidate: 'draft',
    active: 'published',
    retired: 'archived',
};
const STATUS_BY_LIFECYCLE = {
    draft: 'candidate',
    published: 'active',
    archived: 'retired',
};
const RELIABILITY_BY_TRUST = {
    unverified: 0.2,
    verified: 0.6,
    'ground-truth': 0.9,
};
/** Reflection records carry a numeric confidence in [0, 1]. */
const CONFIDENCE_SCORE = { low: 0.3, medium: 0.6, high: 0.9 };
/** The entity-type prefix every learned entry shares. */
const ENTRY_TYPE_PREFIX = 'learned-';
const REFLECTION_TYPE = 'learned-reflection';
const HEURISTIC_TYPE = 'heuristic';
const DECISION_TYPE = 'decision';
const FAILURE_TYPE = 'failure';
const REFLECTION_RECORD_TYPE = 'reflection';
const PROJECT_CONTEXT_TYPE = 'project_context';
const PROCEDURE_TYPE = 'procedure';
const PROCEDURE_STEP_TYPE = 'procedure-step';
const PROCEDURE_SUCCESS_RATE = '[success-rate]: ';
const PROCEDURE_EXECUTION_COUNT = '[execution-count]: ';
const PROCEDURE_STEPS = '[procedure-steps]: ';
const PROCEDURE_META = '[procedure-meta]:';
const STEP_ORDER = '[order]: ';
const STEP_ACTION = '[action]: ';
const STEP_PARAM = '[param]: ';
/** EWMA weight for a procedure's success rate on each `refineProcedure`. */
const PROCEDURE_SUCCESS_ALPHA = 0.2;
const ENGLISH_STOPWORDS = new Set([
    'a', 'an', 'the', 'is', 'be', 'are', 'was', 'were', 'to', 'of', 'in', 'on', 'at', 'by', 'for',
    'with', 'and', 'or', 'but', 'if', 'as', 'it', 'its', 'this', 'that', 'these', 'those',
]);
function observationValue(observations, prefix) {
    const hit = observations.find(o => o.startsWith(prefix));
    return hit === undefined ? null : hit.slice(prefix.length);
}
function observationValues(observations, prefix) {
    return observations.filter(o => o.startsWith(prefix)).map(o => o.slice(prefix.length));
}
function parseJson(raw, fallback) {
    if (raw === null)
        return fallback;
    try {
        return JSON.parse(raw);
    }
    catch {
        return fallback;
    }
}
function tagValue(tags, prefix) {
    const hit = tags.find(t => t.startsWith(prefix));
    return hit === undefined ? null : hit.slice(prefix.length);
}
function nowIso() {
    return new Date().toISOString();
}
function clamp01(n) {
    if (!Number.isFinite(n))
        return 0;
    return Math.max(0, Math.min(1, n));
}
/** Lower-cased alphanumeric tokens of at least `minLength` characters. */
function tokenize(text, minLength) {
    return new Set(text
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, '')
        .split(/\s+/)
        .filter(t => t.length >= minLength));
}
/** Tokens split on every non-alphanumeric character, stopwords removed. */
function conditionTokens(text) {
    return new Set(text
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter(t => t.length >= 2 && !ENGLISH_STOPWORDS.has(t)));
}
function jaccard(a, b) {
    if (a.size === 0 && b.size === 0)
        return 0;
    let inter = 0;
    for (const t of a)
        if (b.has(t))
            inter += 1;
    return inter / (a.size + b.size - inter);
}
/** `don't X` / `do not X` / `never X` / `avoid X` against `X`. */
function isContradiction(a, b) {
    const an = a.toLowerCase().replace(/\s+/g, ' ').trim();
    const bn = b.toLowerCase().replace(/\s+/g, ' ').trim();
    for (const p of ["don't ", 'do not ', 'never ', 'avoid ']) {
        if (an.startsWith(p) && bn === an.slice(p.length))
            return true;
        if (bn.startsWith(p) && an === bn.slice(p.length))
            return true;
    }
    return false;
}
function rowToEntity(row) {
    return {
        name: row.name,
        entityType: row.entityType,
        observations: parseJson(row.observations, []),
        tags: parseJson(row.tags, []),
        importance: row.importance,
        createdAt: row.createdAt,
        lastModified: row.lastModified,
        projectId: row.projectId,
        version: row.version ?? 1,
        parentEntityName: row.parentEntityName,
        rootEntityName: row.rootEntityName,
        isLatest: row.isLatest !== 0,
        supersededBy: row.supersededBy,
        metadata: parseJson(row.agentMetadata, {}),
    };
}
function toRawView(entity) {
    return {
        name: entity.name,
        entityType: entity.entityType,
        observations: [...entity.observations],
        tags: [...entity.tags],
        isLatest: entity.isLatest,
        parentEntityName: entity.parentEntityName,
        supersededBy: entity.supersededBy,
    };
}
/**
 * Parse an entity back into the `KnowledgeEntry` shape.
 *
 * The logical `version` comes from the `version:` observation. When that observation is
 * missing or not a positive, finite number, the `:v<n>` suffix of the name supplies the
 * version. The row's write counter never supplies the version.
 */
export function parseEntity(entity) {
    if (!entity.entityType.startsWith(ENTRY_TYPE_PREFIX))
        return null;
    const name = entity.name;
    const nameMatch = /^learned:([^:]+):(.*):([^:]+):v(\d+)$/.exec(name);
    const typeKind = entity.entityType.slice(ENTRY_TYPE_PREFIX.length);
    const kind = (nameMatch?.[1] ?? typeKind);
    const { observations, tags } = entity;
    const project = entity.projectId ?? nameMatch?.[2] ?? '*';
    const slug = nameMatch?.[3] ?? '';
    const versionFromName = nameMatch ? Number(nameMatch[4]) : 1;
    const versionFromObs = Number(observationValue(observations, OBS.version));
    const version = Number.isFinite(versionFromObs) && versionFromObs > 0 ? versionFromObs : versionFromName;
    const statusFromObs = observationValue(observations, OBS.status);
    const lifecycle = entity.metadata.lifecycleStatus ?? 'published';
    const statusFromTag = tagValue(tags, 'status:');
    const status = statusFromObs ?? statusFromTag ?? STATUS_BY_LIFECYCLE[lifecycle] ?? 'active';
    const trustFromObs = observationValue(observations, OBS.trust);
    const trustFromTag = tagValue(tags, 'trust:');
    const trust = trustFromObs ?? trustFromTag ?? 'unverified';
    const validation = parseJson(observationValue(observations, OBS.validation), null);
    const steps = parseJson(observationValue(observations, OBS.steps), null);
    const entry = {
        id: name,
        kind,
        project,
        slug,
        version,
        title: observationValue(observations, OBS.title) ?? '',
        description: observationValue(observations, OBS.description) ?? '',
        body: observationValues(observations, OBS.body).join('\n'),
        scope: observationValue(observations, OBS.scope) ?? '',
        confidence: observationValue(observations, OBS.confidence) ?? 'low',
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
    if (steps)
        entry.steps = steps;
    return entry;
}
/**
 * Build the observation lines for an entry.
 *
 * The caller passes `reflectionHash` separately, because `reflectionHash` is not a
 * `KnowledgeEntry` field. The store uses `reflectionHash` as its own dedup marker, and the
 * marker must survive an update. Callers that rewrite an entity re-read `reflectionHash` from
 * the existing observations and pass the same value back here.
 */
function buildObservations(entry, reflectionHash) {
    const observations = [
        `${OBS.title}${entry.title}`,
        `${OBS.description}${entry.description}`,
        `${OBS.scope}${entry.scope}`,
        `${OBS.confidence}${entry.confidence}`,
        `${OBS.trust}${entry.trust}`,
        `${OBS.status}${entry.status}`,
        `${OBS.version}${entry.version}`,
        `${OBS.run}${entry.runId}`,
    ];
    if (entry.validation)
        observations.push(`${OBS.validation}${JSON.stringify(entry.validation)}`);
    for (const id of entry.heuristicIds)
        observations.push(`${OBS.heuristic}${id}`);
    if (entry.decisionId)
        observations.push(`${OBS.decision}${entry.decisionId}`);
    if (entry.procedureId)
        observations.push(`${OBS.procedure}${entry.procedureId}`);
    if (entry.steps)
        observations.push(`${OBS.steps}${JSON.stringify(entry.steps)}`);
    if (reflectionHash)
        observations.push(`${OBS.reflectionHash}${reflectionHash}`);
    for (const line of entry.body.split('\n'))
        observations.push(`${OBS.body}${line}`);
    return observations;
}
function buildTags(entry) {
    return [
        `kind:${entry.kind}`,
        `project:${entry.project}`,
        `trust:${entry.trust}`,
        `status:${entry.status}`,
    ];
}
/** `learned:<kind>:<project>:<slug>:v<n>`. */
export function entryName(kind, project, slug, version) {
    return `learned:${kind}:${project}:${slug}:v${version}`;
}
/** `learned:<kind>:<project>:<slug>:v1`, the root of the version chain. */
export function rootName(kind, project, slug) {
    return entryName(kind, project, slug, 1);
}
/** `proc:<project>:<slug>`, the id a procedure skill's record carries. */
export function procedureIdFor(project, slug) {
    return `proc:${project}:${slug}`;
}
const SCHEMA = `
  CREATE TABLE IF NOT EXISTS entities (
    name TEXT PRIMARY KEY,
    id TEXT,
    entityType TEXT NOT NULL,
    observations TEXT NOT NULL,
    tags TEXT,
    importance INTEGER,
    parentId TEXT REFERENCES entities(name) ON DELETE SET NULL,
    createdAt TEXT NOT NULL,
    lastModified TEXT NOT NULL,
    projectId TEXT,
    version INTEGER DEFAULT 1,
    parentEntityName TEXT,
    rootEntityName TEXT,
    isLatest INTEGER DEFAULT 1,
    supersededBy TEXT,
    contentHash TEXT,
    agentMetadata TEXT
  );
  CREATE TABLE IF NOT EXISTS relations (
    fromEntity TEXT NOT NULL REFERENCES entities(name) ON DELETE CASCADE,
    toEntity TEXT NOT NULL REFERENCES entities(name) ON DELETE CASCADE,
    relationType TEXT NOT NULL,
    createdAt TEXT NOT NULL,
    lastModified TEXT NOT NULL,
    weight REAL,
    confidence REAL,
    properties TEXT,
    metadata TEXT,
    PRIMARY KEY (fromEntity, toEntity, relationType)
  );
`;
/** Created after the column back-fill: two of them index back-filled columns. */
const INDEXES = `
  CREATE INDEX IF NOT EXISTS idx_entity_type ON entities(entityType);
  CREATE INDEX IF NOT EXISTS idx_entities_projectId ON entities(projectId);
  CREATE INDEX IF NOT EXISTS idx_entities_isLatest ON entities(isLatest);
  CREATE INDEX IF NOT EXISTS idx_relation_from ON relations(fromEntity);
  CREATE INDEX IF NOT EXISTS idx_relation_to ON relations(toEntity);
`;
/** Entity columns a `knowledge.db` written by an older store may lack. */
const ENTITY_COLUMNS = [
    ['id', 'TEXT'],
    ['tags', 'TEXT'],
    ['importance', 'INTEGER'],
    ['parentId', 'TEXT'],
    ['projectId', 'TEXT'],
    ['version', 'INTEGER DEFAULT 1'],
    ['parentEntityName', 'TEXT'],
    ['rootEntityName', 'TEXT'],
    ['isLatest', 'INTEGER DEFAULT 1'],
    ['supersededBy', 'TEXT'],
    ['contentHash', 'TEXT'],
    ['agentMetadata', 'TEXT'],
];
/**
 * The learned-knowledge store, kept in one SQLite file.
 *
 * The file holds the entities and relations that store the learned entries, heuristics, procedures, decisions and failures. `KnowledgeStore.create` opens a store. A store that is not read-only creates the file and its tables when they are absent. The private `write` helper runs a change in one `BEGIN IMMEDIATE` transaction.
 *
 * The class takes no file lock. The learn CLI uses `withLearnLock` to serialize its runs. A read-only store rejects every write. Call `close` to release the database handle. A second call does nothing.
 */
export class KnowledgeStore {
    db;
    closed = false;
    constructor(db) {
        this.db = db;
    }
    /**
     * Open the store at `dbPath`, creating the file and its tables when absent.
     *
     * `readonly` opens an existing file without any DDL.
     * Callers such as the `skills` tool use `readonly`, because they must never create or migrate
     * the store. A write through a `readonly` handle throws.
     */
    static create(dbPath, options = {}) {
        if (options.readonly) {
            const ro = new Database(dbPath, { readonly: true, fileMustExist: true });
            ro.pragma('busy_timeout = 5000');
            return new KnowledgeStore(ro);
        }
        fs.mkdirSync(path.dirname(dbPath), { recursive: true, mode: 0o700 });
        const db = new Database(dbPath);
        try {
            // The timeout first: every statement after it, the journal switch
            // included, then waits for a concurrent writer instead of failing at once.
            db.pragma('busy_timeout = 5000');
            db.pragma('journal_mode = WAL');
            db.pragma('foreign_keys = ON');
            db.exec(SCHEMA);
            const present = new Set(db.prepare('PRAGMA table_info(entities)').all().map(c => c.name));
            for (const [column, type] of ENTITY_COLUMNS) {
                if (!present.has(column))
                    db.exec(`ALTER TABLE entities ADD COLUMN ${column} ${type}`);
            }
            db.exec(INDEXES);
            // The previous adapter kept an FTS5 shadow of `entities` with triggers on
            // every write. Nothing reads it any more, and a stale shadow can fail a
            // write, so a file that still carries it is relieved of it here.
            db.exec(`
        DROP TRIGGER IF EXISTS entities_ai;
        DROP TRIGGER IF EXISTS entities_au;
        DROP TRIGGER IF EXISTS entities_ad;
        DROP TABLE IF EXISTS entities_fts;
      `);
        }
        catch (err) {
            db.close();
            throw err;
        }
        return new KnowledgeStore(db);
    }
    /** Release the database handle. Idempotent. */
    close() {
        if (this.closed)
            return;
        this.closed = true;
        try {
            this.db.close();
        }
        catch {
            // Closing twice is not an error.
        }
    }
    /** PII redaction, for `knowledge-db` and the gates to reuse. */
    redactPii(text) {
        return redactPii(text);
    }
    /**
     * Run a read-modify-write under the database write lock.
     * The lock stops a concurrent process from writing between the read and the update.
     * Nested calls become savepoints.
     */
    write(fn) {
        return this.db.transaction(fn).immediate();
    }
    // ==================== Row access ====================
    readEntity(name) {
        const row = this.db.prepare('SELECT * FROM entities WHERE name = ?').get(name);
        return row ? rowToEntity(row) : null;
    }
    entitiesOfType(entityType) {
        const rows = this.db
            .prepare('SELECT * FROM entities WHERE entityType = ? ORDER BY rowid')
            .all(entityType);
        return rows.map(rowToEntity);
    }
    /** Every learned entity, in insertion order. */
    learnedEntities() {
        const rows = this.db
            .prepare('SELECT * FROM entities WHERE entityType LIKE ? ORDER BY rowid')
            .all(`${ENTRY_TYPE_PREFIX}%`);
        return rows.map(rowToEntity);
    }
    /** Insert the rows that do not exist yet. An existing name is left as it is. */
    insertEntities(entities) {
        const stmt = this.db.prepare(`
      INSERT OR IGNORE INTO entities
        (name, id, entityType, observations, tags, importance, parentId, createdAt, lastModified,
         projectId, version, parentEntityName, rootEntityName, isLatest, supersededBy, contentHash, agentMetadata)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, 1, NULL, NULL, ?)
    `);
        const now = nowIso();
        for (const e of entities) {
            stmt.run(e.name, randomUUID(), e.entityType, JSON.stringify(e.observations), e.tags ? JSON.stringify(e.tags) : null, e.importance ?? null, e.parentId ?? null, e.createdAt ?? now, now, e.projectId ?? null, e.parentEntityName ?? null, e.rootEntityName ?? null, e.metadata && Object.keys(e.metadata).length > 0 ? JSON.stringify(e.metadata) : null);
        }
    }
    /** Overwrite the mutable columns of one row and bump its write counter. */
    updateEntity(name, patch) {
        const sets = ['lastModified = ?', 'version = COALESCE(version, 1) + 1'];
        const values = [nowIso()];
        if (patch.observations !== undefined) {
            sets.push('observations = ?');
            values.push(JSON.stringify(patch.observations));
        }
        if (patch.tags !== undefined) {
            sets.push('tags = ?');
            values.push(JSON.stringify(patch.tags));
        }
        if (patch.importance !== undefined) {
            sets.push('importance = ?');
            values.push(patch.importance);
        }
        if (patch.isLatest !== undefined) {
            sets.push('isLatest = ?');
            values.push(patch.isLatest ? 1 : 0);
        }
        if (patch.supersededBy !== undefined) {
            sets.push('supersededBy = ?');
            values.push(patch.supersededBy);
        }
        if (patch.metadata !== undefined) {
            sets.push('agentMetadata = ?');
            values.push(Object.keys(patch.metadata).length > 0 ? JSON.stringify(patch.metadata) : null);
        }
        values.push(name);
        const info = this.db.prepare(`UPDATE entities SET ${sets.join(', ')} WHERE name = ?`).run(...values);
        if (info.changes === 0)
            throw new Error(`knowledge entry not found: ${name}`);
    }
    /** Insert the relations that do not exist yet. Both endpoints must exist. */
    insertRelations(relations) {
        if (relations.length === 0)
            return;
        const exists = this.db.prepare('SELECT 1 FROM entities WHERE name = ?');
        const stmt = this.db.prepare(`
      INSERT OR IGNORE INTO relations (fromEntity, toEntity, relationType, createdAt, lastModified)
      VALUES (?, ?, ?, ?, ?)
    `);
        const now = nowIso();
        for (const r of relations) {
            for (const endpoint of [r.from, r.to]) {
                if (!exists.get(endpoint))
                    throw new Error(`relation endpoint not found: ${endpoint}`);
            }
            stmt.run(r.from, r.to, r.relationType, now, now);
        }
    }
    relationsFrom(name) {
        return this.db
            .prepare('SELECT fromEntity, toEntity, relationType FROM relations WHERE fromEntity = ? ORDER BY rowid')
            .all(name);
    }
    // ==================== Learned entries ====================
    /** The raw entity, for tests and for `knowledge-db`'s duplicate check. */
    async getRawEntity(name) {
        const entity = this.readEntity(name);
        return entity ? toRawView(entity) : null;
    }
    /**
     * Write one entity for one version, with the reference entities and `cites` relations that entity needs.
     * The write runs in one transaction. An existing learned entry under this name stays untouched.
     * Any other row under this name is an error.
     */
    async putEntry(entry, reflectionHash) {
        this.putEntrySync(entry, reflectionHash);
    }
    putEntrySync(entry, reflectionHash) {
        const name = entry.id;
        const root = rootName(entry.kind, entry.project, entry.slug);
        const parent = entry.version > 1 ? entryName(entry.kind, entry.project, entry.slug, entry.version - 1) : undefined;
        const createdAt = entry.createdAt || nowIso();
        this.write(() => {
            const clash = this.readEntity(name);
            if (clash && !clash.entityType.startsWith(ENTRY_TYPE_PREFIX)) {
                throw new Error(`knowledge entry name is taken by a ${clash.entityType} row: ${name}`);
            }
            this.insertEntities(entry.sources.map(source => ({
                name: `exchange:${source.id}`,
                entityType: 'exchange-ref',
                observations: [
                    `path: ${source.path}`,
                    `lines: ${source.lineStart}-${source.lineEnd}`,
                    `session: ${source.sessionId ?? ''}`,
                ],
            })));
            this.insertEntities([
                {
                    name,
                    entityType: `${ENTRY_TYPE_PREFIX}${entry.kind}`,
                    projectId: entry.project,
                    importance: IMPORTANCE_BY_CONFIDENCE[entry.confidence],
                    tags: buildTags(entry),
                    rootEntityName: root,
                    parentEntityName: parent,
                    observations: buildObservations(entry, reflectionHash),
                    createdAt,
                    metadata: {
                        lifecycleStatus: LIFECYCLE_BY_STATUS[entry.status],
                        source: {
                            agentId: 'episodic-learn',
                            timestamp: createdAt,
                            method: 'inferred',
                            reliability: RELIABILITY_BY_TRUST[entry.trust],
                            trustLevel: entry.trust,
                        },
                    },
                },
            ]);
            // A new revision does not clear the parent's `isLatest` or set
            // `supersededBy`; only `supersede` (via `activate`) does.
            this.insertRelations(entry.sources.map(source => ({ from: name, to: `exchange:${source.id}`, relationType: 'cites' })));
        });
    }
    /** Create an `attempt:<id>` reference entity, citing it from `from`. */
    async citeAttempt(from, attemptId, taskId, runId) {
        this.citeAttemptSync(from, attemptId, taskId, runId);
    }
    citeAttemptSync(from, attemptId, taskId, runId) {
        const refName = `attempt:${attemptId}`;
        this.write(() => {
            this.insertEntities([
                { name: refName, entityType: 'attempt-ref', observations: [`task: ${taskId}`, `run: ${runId}`] },
            ]);
            this.insertRelations([{ from, to: refName, relationType: 'cites' }]);
        });
    }
    /** Re-render the observations, tags and lifecycle of one entry after `mutate`. */
    rewriteEntity(name, mutate) {
        this.write(() => {
            const entity = this.readEntity(name);
            if (!entity)
                throw new Error(`knowledge entry not found: ${name}`);
            const parsed = parseEntity(entity);
            if (!parsed)
                throw new Error(`not a learned entry: ${name}`);
            mutate(parsed);
            // Carry the dedup marker across a rewrite; dropping it would make a stored
            // reflection look new to `findReflectionByHash`.
            const reflectionHash = observationValue(entity.observations, OBS.reflectionHash) ?? undefined;
            const source = entity.metadata.source ?? {};
            this.updateEntity(name, {
                observations: buildObservations(parsed, reflectionHash),
                tags: buildTags(parsed),
                importance: IMPORTANCE_BY_CONFIDENCE[parsed.confidence],
                metadata: {
                    ...entity.metadata,
                    lifecycleStatus: LIFECYCLE_BY_STATUS[parsed.status],
                    // Provenance follows the trust the observation and tag now carry.
                    source: { ...source, reliability: RELIABILITY_BY_TRUST[parsed.trust], trustLevel: parsed.trust },
                },
            });
        });
    }
    /** Set `supersededBy` and clear `isLatest` on the older version. */
    async supersede(olderName, newerName) {
        this.write(() => this.updateEntity(olderName, { supersededBy: newerName, isLatest: false }));
    }
    /** Set the status (and the `status:` observation and tag) of one entry. */
    async setStatus(name, status) {
        this.rewriteEntity(name, entry => {
            entry.status = status;
        });
    }
    /** Set the trust level (observation and tag) of one entry. */
    async setTrust(name, trust) {
        this.rewriteEntity(name, entry => {
            entry.trust = trust;
        });
    }
    /**
     * Activate one entry in a single write.
     * The write sets the status, trust and validation together.
     * A failed write cannot leave two of the three changes applied.
     */
    async promote(name, trust, validation) {
        this.rewriteEntity(name, entry => {
            entry.trust = trust;
            entry.validation = validation;
            entry.status = 'active';
        });
    }
    /** Record a validation record on one entry. */
    async setValidation(name, validation) {
        this.rewriteEntity(name, entry => {
            entry.validation = validation;
        });
    }
    /** Record a decision id on one entry. */
    async setDecision(name, decisionId) {
        this.rewriteEntity(name, entry => {
            entry.decisionId = decisionId;
        });
    }
    /** Record a procedure id on one entry. */
    async setProcedure(name, procedureId) {
        this.rewriteEntity(name, entry => {
            entry.procedureId = procedureId;
        });
    }
    /** Record the heuristic ids of one entry. */
    async setHeuristics(name, heuristicIds) {
        this.rewriteEntity(name, entry => {
            entry.heuristicIds = [...heuristicIds];
        });
    }
    /** Read one entry by entity name. */
    async getEntry(name) {
        const entity = this.readEntity(name);
        return entity ? parseEntity(entity) : null;
    }
    /** The latest version of a `(kind, project, slug)` chain, by logical version. */
    async getBySlug(kind, project, slug) {
        return this.latestBySlug(kind, project, slug);
    }
    latestBySlug(kind, project, slug) {
        const root = rootName(kind, project, slug);
        const rows = this.db
            .prepare('SELECT * FROM entities WHERE entityType LIKE ? AND COALESCE(rootEntityName, name) = ?')
            .all(`${ENTRY_TYPE_PREFIX}%`, root);
        let best = null;
        for (const row of rows) {
            const parsed = parseEntity(rowToEntity(row));
            if (parsed && (!best || parsed.version > best.version))
                best = parsed;
        }
        return best;
    }
    /**
     * Learned entries that are still chain-visible (`isLatest`), any status.
     * A candidate revision does not clear the parent's `isLatest`, so both rows
     * are returned until `supersede`. Callers that want one row per chain use
     * `getBySlug`; callers that want lifecycle use `listByStatus`.
     */
    async listEntries() {
        return this.learnedEntities()
            .filter(e => e.isLatest)
            .map(parseEntity)
            .filter((e) => e !== null);
    }
    /**
     * Every learned entry with a given status, including superseded and older versions.
     * Lifecycle bookkeeping (`activate`'s supersede sweep) must see
     * those rows, so this deliberately does not filter on `isLatest`.
     */
    async listByStatus(statuses, kinds, project) {
        return this.learnedEntities()
            .map(parseEntity)
            .filter((entry) => entry !== null)
            .filter(entry => {
            if (!statuses.includes(entry.status))
                return false;
            if (kinds && kinds.length > 0 && !kinds.includes(entry.kind))
                return false;
            if (project !== undefined && entry.project !== project)
                return false;
            return true;
        });
    }
    /**
     * Text search over active, unsuperseded, chain-visible entries.
     *
     * The search uses deterministic term overlap. Each entry scores one point per distinct query
     * term found in its slug, title, description, body or scope. Total occurrences break a tie,
     * and the id breaks any tie that remains. The store has no document frequency weighting.
     * So a store with one or two entries still answers.
     */
    async search(query, options = {}) {
        const { kinds, project, limit = 10 } = options;
        const terms = [...new Set(query.toLowerCase().split(/[^a-z0-9]+/).filter(t => t.length > 0))];
        if (terms.length === 0 || limit <= 0)
            return [];
        const candidates = (await this.listEntries()).filter(entry => {
            if (kinds && kinds.length > 0 && !kinds.includes(entry.kind))
                return false;
            if (project !== undefined && entry.project !== project && entry.project !== '*')
                return false;
            return entry.status === 'active' && entry.supersededBy === null;
        });
        return candidates
            .map(entry => {
            const haystack = `${entry.slug} ${entry.title} ${entry.description} ${entry.body} ${entry.scope}`.toLowerCase();
            let distinct = 0;
            let occurrences = 0;
            for (const term of terms) {
                let at = haystack.indexOf(term);
                if (at === -1)
                    continue;
                distinct += 1;
                while (at !== -1) {
                    occurrences += 1;
                    at = haystack.indexOf(term, at + term.length);
                }
            }
            return { entry, distinct, occurrences };
        })
            .filter(row => row.distinct > 0)
            .sort((a, b) => b.distinct - a.distinct ||
            b.occurrences - a.occurrences ||
            (a.entry.id < b.entry.id ? -1 : a.entry.id > b.entry.id ? 1 : 0))
            .slice(0, limit)
            .map(row => row.entry);
    }
    /** Search reads the tables directly, so there is no index to rebuild. */
    async buildIndex() {
        return;
    }
    // ==================== Heuristics ====================
    heuristicRecord(id) {
        const entity = this.readEntity(id);
        if (!entity || entity.entityType !== HEURISTIC_TYPE)
            return null;
        const record = entity.metadata.heuristicRecord;
        return record ? { entity, record } : null;
    }
    allHeuristics() {
        return this.entitiesOfType(HEURISTIC_TYPE)
            .map(e => e.metadata.heuristicRecord)
            .filter((r) => r !== undefined);
    }
    /** Add an instruction line as a heuristic record. Returns its id. */
    async addHeuristic(input) {
        const id = `h_${randomUUID()}`;
        const now = nowIso();
        const record = {
            id,
            condition: input.condition,
            action: input.action,
            ...(input.priority !== undefined ? { priority: input.priority } : {}),
            support: 0,
            contradictions: 0,
            confidence: clamp01(input.initialConfidence ?? 0.5),
            createdAt: now,
            lastUpdatedAt: now,
        };
        this.write(() => this.insertEntities([
            {
                name: id,
                entityType: HEURISTIC_TYPE,
                observations: [`[heuristic] ${input.condition} → ${input.action}`],
                importance: 5,
                createdAt: now,
                metadata: { memoryType: HEURISTIC_TYPE, confidence: record.confidence, heuristicRecord: record },
            },
        ]));
        return id;
    }
    updateHeuristic(id, mutate) {
        return this.write(() => {
            const found = this.heuristicRecord(id);
            if (!found)
                return false;
            const updated = { ...mutate(found.record), lastUpdatedAt: nowIso() };
            this.updateEntity(id, {
                metadata: { ...found.entity.metadata, confidence: updated.confidence, heuristicRecord: updated },
            });
            return true;
        });
    }
    /** Reinforce a heuristic after a kept validation: support up, confidence toward 1. */
    async reinforceHeuristic(id) {
        return this.updateHeuristic(id, h => ({
            ...h,
            support: h.support + 1,
            confidence: clamp01(h.confidence + (1 - h.confidence) * 0.1),
        }));
    }
    /** Record a contradiction against a heuristic on a drop: confidence down by a fifth. */
    async contradictHeuristic(id) {
        return this.updateHeuristic(id, h => ({
            ...h,
            contradictions: h.contradictions + 1,
            confidence: clamp01(h.confidence - h.confidence * 0.2),
        }));
    }
    /**
     * Detect every pair of heuristics whose conditions overlap by at least half of the larger token set.
     * The pair conflicts when the two actions differ.
     * The kind is `contradiction` when one action negates the other. Otherwise, the kind is `overlap`.
     */
    async detectHeuristicConflicts() {
        const all = this.allHeuristics();
        const conflicts = [];
        for (let i = 0; i < all.length; i++) {
            for (let j = i + 1; j < all.length; j++) {
                const a = all[i];
                const b = all[j];
                const aTokens = conditionTokens(a.condition);
                const bTokens = conditionTokens(b.condition);
                let intersect = 0;
                for (const t of aTokens)
                    if (bTokens.has(t))
                        intersect++;
                const overlap = intersect / Math.max(aTokens.size, bTokens.size, 1);
                if (overlap < 0.5 || a.action === b.action)
                    continue;
                const kind = isContradiction(a.action, b.action) ? 'contradiction' : 'overlap';
                conflicts.push({
                    a: a.id,
                    b: b.id,
                    kind,
                    reason: kind === 'contradiction'
                        ? `Heuristics "${a.id}" and "${b.id}" prescribe opposing actions on overlapping conditions`
                        : `Heuristics "${a.id}" and "${b.id}" overlap on conditions but recommend different actions`,
                });
            }
        }
        return conflicts;
    }
    /** A heuristic by id, or null. */
    getHeuristic(id) {
        const found = this.heuristicRecord(id);
        if (!found)
            return null;
        const { record } = found;
        return {
            id: record.id,
            condition: record.condition,
            action: record.action,
            support: record.support,
            contradictions: record.contradictions,
            confidence: record.confidence,
        };
    }
    // ==================== Procedures ====================
    /** Store a procedure skill's steps. Additive: an existing id is never rewritten. */
    async putProcedure(input) {
        if (this.readEntity(input.id))
            return;
        const steps = input.steps.map((step, index) => ({
            order: index + 1,
            action: step.action,
            parameters: step.parameters,
        }));
        this.write(() => this.insertEntities([
            {
                name: input.id,
                entityType: PROCEDURE_TYPE,
                observations: encodeProcedure(input.description, steps, 0, 0),
                tags: [PROCEDURE_TYPE, ...input.triggers.map(t => t.toLowerCase())],
            },
        ]));
    }
    /** A stored procedure, or null. */
    async getProcedure(id) {
        return this.readProcedure(id);
    }
    readProcedure(id) {
        const entity = this.readEntity(id);
        if (!entity || entity.entityType !== PROCEDURE_TYPE)
            return null;
        const descriptionLines = [];
        let successRate = 0;
        let executionCount = 0;
        let steps = null;
        for (const obs of entity.observations) {
            if (obs.startsWith(PROCEDURE_SUCCESS_RATE)) {
                const n = Number(obs.slice(PROCEDURE_SUCCESS_RATE.length));
                if (Number.isFinite(n))
                    successRate = n;
            }
            else if (obs.startsWith(PROCEDURE_EXECUTION_COUNT)) {
                const n = Number(obs.slice(PROCEDURE_EXECUTION_COUNT.length));
                if (Number.isFinite(n))
                    executionCount = n;
            }
            else if (obs.startsWith(PROCEDURE_STEPS)) {
                steps = parseJson(obs.slice(PROCEDURE_STEPS.length), null);
            }
            else if (obs.startsWith(PROCEDURE_META)) {
                // The oldest encoding kept the counters in one JSON blob.
                const meta = parseJson(obs.slice(PROCEDURE_META.length).trim(), {});
                if (typeof meta.successRate === 'number')
                    successRate = meta.successRate;
                if (typeof meta.executionCount === 'number')
                    executionCount = meta.executionCount;
            }
            else {
                descriptionLines.push(obs);
            }
        }
        return {
            id,
            // A procedure is named by its id; `putProcedure`'s `name` is accepted for the
            // caller's convenience and not stored.
            name: id,
            description: descriptionLines.join('\n'),
            steps: steps ?? this.loadStepEntities(id),
            triggers: entity.tags.filter(t => t !== PROCEDURE_TYPE),
            successRate,
            executionCount,
        };
    }
    /**
     * Load the steps of a procedure, which the previous adapter wrote as one `procedure-step` row per step.
     * The `has_step` relations link the procedure to its steps.
     * The `[order]` observation of each step sets its place in the sequence.
     */
    loadStepEntities(procedureId) {
        const steps = [];
        for (const rel of this.relationsFrom(procedureId)) {
            if (rel.relationType !== 'has_step')
                continue;
            const entity = this.readEntity(rel.toEntity);
            if (!entity || entity.entityType !== PROCEDURE_STEP_TYPE)
                continue;
            const step = { order: 0, action: '', parameters: {} };
            for (const obs of entity.observations) {
                if (obs.startsWith(STEP_ORDER)) {
                    const n = Number(obs.slice(STEP_ORDER.length));
                    if (Number.isFinite(n))
                        step.order = n;
                }
                else if (obs.startsWith(STEP_ACTION)) {
                    step.action = obs.slice(STEP_ACTION.length);
                }
                else if (obs.startsWith(STEP_PARAM)) {
                    const kv = decodeKeyValue(obs.slice(STEP_PARAM.length));
                    if (kv && typeof kv[1] === 'string')
                        step.parameters[kv[0]] = kv[1];
                }
            }
            steps.push(step);
        }
        return steps.sort((a, b) => a.order - b.order);
    }
    /**
     * Rank stored procedures against a context description.
     * Each procedure scores by token overlap between the context and the procedure's name and triggers.
     */
    async matchProcedures(context, ids) {
        const contextTokens = tokenize(context, 2);
        if (contextTokens.size === 0)
            return [];
        const matches = [];
        for (const id of ids) {
            const proc = this.readProcedure(id);
            if (!proc)
                continue;
            const procTokens = tokenize(proc.name, 2);
            for (const trigger of proc.triggers)
                for (const t of tokenize(trigger, 2))
                    procTokens.add(t);
            if (procTokens.size === 0)
                continue;
            const score = jaccard(contextTokens, procTokens);
            if (score >= 0.01) {
                matches.push({ procedure: { id: proc.id, name: proc.name, description: proc.description }, score });
            }
        }
        return matches.sort((a, b) => b.score - a.score);
    }
    /** Telemetry only: fold whether a procedure skill's attempt succeeded into its success rate. */
    async refineProcedure(id, succeeded, _notes) {
        this.write(() => {
            const proc = this.readProcedure(id);
            if (!proc)
                return;
            const count = proc.executionCount ?? 0;
            const baseline = count === 0 ? 0.5 : (proc.successRate ?? 0);
            const rate = clamp01(baseline + PROCEDURE_SUCCESS_ALPHA * ((succeeded ? 1 : 0) - baseline));
            this.updateEntity(id, { observations: encodeProcedure(proc.description, proc.steps, rate, count + 1) });
        });
    }
    // ==================== Project context ====================
    projectContext(project) {
        const entity = this.readEntity(`project-context-${project}`);
        if (!entity || entity.entityType !== PROJECT_CONTEXT_TYPE)
            return null;
        const record = entity.metadata.projectContextRecord;
        return record ? { entity, record } : null;
    }
    /** Upsert a project's structured context (learner prompts only). Arrays append and dedup. */
    async upsertProjectContext(project, input) {
        if (!project)
            throw new Error('upsertProjectContext: project is required');
        this.write(() => this.upsertProjectContextSync(project, input));
    }
    upsertProjectContextSync(project, input) {
        const now = nowIso();
        const existing = this.projectContext(project);
        const base = existing?.record ?? {
            id: project,
            timestamp: now,
            projectId: project,
            facts: [],
            conventions: [],
            commands: [],
            glossary: [],
            lastUpdated: now,
        };
        const glossary = new Map();
        for (const g of [...(base.glossary ?? []), ...(input.glossary ?? [])])
            glossary.set(g.term, g);
        const merged = {
            ...base,
            facts: [...new Set([...(base.facts ?? []), ...(input.facts ?? [])])],
            conventions: [...new Set([...(base.conventions ?? []), ...(input.conventions ?? [])])],
            commands: base.commands ?? [],
            glossary: [...glossary.values()],
            lastUpdated: now,
        };
        const name = `project-context-${project}`;
        // A row written by the previous adapter may exist without its record (that
        // backend never persisted `projectContextRecord`); it is updated, not skipped.
        const row = existing?.entity ?? this.readEntity(name);
        if (row) {
            this.updateEntity(name, { metadata: { ...row.metadata, projectContextRecord: merged } });
        }
        else {
            this.insertEntities([
                {
                    name,
                    entityType: PROJECT_CONTEXT_TYPE,
                    observations: [`[project_context] ${project}`],
                    importance: 6,
                    projectId: project,
                    createdAt: now,
                    metadata: { memoryType: PROJECT_CONTEXT_TYPE, confidence: 0.9, projectContextRecord: merged },
                },
            ]);
        }
    }
    /** The project's context rendered as prose, cut to `budgetChars`. */
    async forContext(project, budgetChars = 1500) {
        const found = this.projectContext(project);
        if (!found)
            return '';
        const rec = found.record;
        const sections = [];
        if (rec.facts.length > 0)
            sections.push(`Facts:\n${rec.facts.map(f => `- ${f}`).join('\n')}`);
        if (rec.conventions.length > 0) {
            sections.push(`Conventions:\n${rec.conventions.map(c => `- ${c}`).join('\n')}`);
        }
        if (rec.commands.length > 0) {
            sections.push(`Commands:\n${rec.commands.map(c => `- ${c.name}: ${c.command} — ${c.purpose}`).join('\n')}`);
        }
        if (rec.glossary.length > 0) {
            sections.push(`Glossary:\n${rec.glossary.map(g => `- ${g.term}: ${g.definition}`).join('\n')}`);
        }
        const full = sections.join('\n\n');
        if (full.length <= budgetChars)
            return full;
        return `${full.slice(0, Math.max(budgetChars - 1, 0))}…`;
    }
    // ==================== Decisions ====================
    decisionRecord(id) {
        const entity = this.readEntity(id);
        if (!entity || entity.entityType !== DECISION_TYPE)
            return null;
        const record = entity.metadata.decisionRecord;
        return record ? { entity, record } : null;
    }
    /** Propose a decision for an edit. Returns the decision id. */
    async proposeDecision(input) {
        if (!input.context.trim())
            throw new Error('proposeDecision: context is required');
        if (!input.decision.trim())
            throw new Error('proposeDecision: decision is required');
        const id = `decision-${randomUUID()}`;
        const now = nowIso();
        const record = {
            id,
            timestamp: now,
            status: 'proposed',
            lifecycle: { status: 'proposed' },
            context: input.context,
            decision: input.decision,
            alternatives: [...input.alternatives],
            consequences: [...input.consequences],
            ...(input.sourceProjectId !== undefined ? { sourceProjectId: input.sourceProjectId } : {}),
        };
        this.write(() => this.insertEntities([
            {
                name: id,
                entityType: DECISION_TYPE,
                observations: [`[decision:proposed] ${input.context} → ${input.decision}`],
                importance: 8,
                createdAt: now,
                metadata: { memoryType: DECISION_TYPE, confidence: 0.7, decisionRecord: record },
            },
        ]));
        return id;
    }
    transitionDecision(id, from, to, extra) {
        return this.write(() => {
            const found = this.decisionRecord(id);
            if (!found || found.record.status !== from)
                return false;
            const updated = {
                ...found.record,
                status: to,
                lifecycle: { status: to, ...extra },
            };
            this.updateEntity(id, {
                observations: [`[decision:${to}] ${updated.context} → ${updated.decision}`],
                metadata: { ...found.entity.metadata, decisionRecord: updated },
            });
            return true;
        });
    }
    /** Accept a proposed decision (a kept edit). */
    async acceptDecision(id) {
        return this.transitionDecision(id, 'proposed', 'accepted', { acceptedAt: nowIso() });
    }
    /** Reject a proposed decision (a dropped edit). */
    async rejectDecision(id, reason) {
        if (!reason.trim())
            throw new Error('rejectDecision: reason is required');
        return this.transitionDecision(id, 'proposed', 'rejected', {
            rejectedAt: nowIso(),
            rejectedReason: reason,
        });
    }
    /** Supersede an accepted decision with a newer one. */
    async supersedeDecision(id, by) {
        if (!this.decisionRecord(by))
            return false;
        return this.transitionDecision(id, 'accepted', 'superseded', {
            supersededAt: nowIso(),
            supersededBy: by,
        });
    }
    /** A decision by id, or null. */
    getDecision(id) {
        const found = this.decisionRecord(id);
        if (!found)
            return null;
        const { record } = found;
        return {
            id: record.id,
            status: record.status,
            context: record.context,
            decision: record.decision,
            alternatives: [...record.alternatives],
            consequences: [...record.consequences],
        };
    }
    /** A decision rendered as ADR markdown. Throws when the id is unknown. */
    exportDecisionAsAdr(id) {
        const found = this.decisionRecord(id);
        if (!found)
            throw new Error(`exportDecisionAsAdr: decision '${id}' not found`);
        const rec = found.record;
        const status = rec.status.charAt(0).toUpperCase() + rec.status.slice(1);
        const lines = [`# ${rec.id}: ${firstLine(rec.decision)}`, '', `Date: ${rec.timestamp}`, '', '## Status', '', status];
        if (rec.supersedes)
            lines.push('', `Supersedes: ${rec.supersedes}`);
        lines.push('', '## Context', '', rec.context, '', '## Decision', '', rec.decision);
        if (rec.consequences.length > 0) {
            lines.push('', '## Consequences', '');
            for (const c of rec.consequences)
                lines.push(`- ${c}`);
        }
        if (rec.alternatives.length > 0) {
            lines.push('', '## Alternatives', '');
            for (const a of rec.alternatives)
                lines.push(`- ${a}`);
        }
        lines.push('');
        return lines.join('\n');
    }
    // ==================== Failures ====================
    /** Record a structured failure for the diagnose step. */
    async recordFailure(input) {
        for (const field of ['context', 'attempted', 'failure_mode', 'root_cause', 'applicability_hint']) {
            if (!input[field].trim())
                throw new Error(`recordFailure: ${field} is required`);
        }
        const id = `failure-${randomUUID()}`;
        const now = nowIso();
        const record = {
            id,
            timestamp: now,
            context: input.context,
            attempted: input.attempted,
            failure_mode: input.failure_mode,
            root_cause: input.root_cause,
            ...(input.alternative_taken !== undefined ? { alternative_taken: input.alternative_taken } : {}),
            applicability_hint: input.applicability_hint,
            lifecycle: { status: 'open' },
        };
        this.write(() => this.insertEntities([
            {
                name: id,
                entityType: FAILURE_TYPE,
                observations: [
                    `[failure] ${input.context}: ${input.failure_mode}`,
                    `[root_cause] ${input.root_cause}`,
                    `[applicability] ${input.applicability_hint}`,
                ],
                importance: 7,
                createdAt: now,
                metadata: { memoryType: FAILURE_TYPE, confidence: 0.9, failureRecord: record },
            },
        ]));
    }
    /**
     * Open failures relevant to a task description, best first.
     * Each whitespace-separated token of the task scores 3 in the applicability hint.
     * The same token scores 2 in the context and 1 in the attempted action.
     */
    async lookupFailures(taskContext, limit = 5) {
        const tokens = taskContext.toLowerCase().split(/\s+/).filter(t => t.length > 1);
        if (tokens.length === 0)
            return [];
        return this.entitiesOfType(FAILURE_TYPE)
            .map(e => e.metadata.failureRecord)
            .filter((r) => r !== undefined && r.lifecycle?.status !== 'resolved')
            .map(rec => {
            const hint = rec.applicability_hint.toLowerCase();
            const ctx = rec.context.toLowerCase();
            const att = rec.attempted.toLowerCase();
            let score = 0;
            for (const t of tokens) {
                if (hint.includes(t))
                    score += 3;
                if (ctx.includes(t))
                    score += 2;
                if (att.includes(t))
                    score += 1;
            }
            return { rec, score };
        })
            .filter(s => s.score > 0)
            .sort((a, b) => b.score - a.score)
            .slice(0, limit)
            .map(({ rec }) => ({
            context: rec.context,
            attempted: rec.attempted,
            failure_mode: rec.failure_mode,
            root_cause: rec.root_cause,
        }));
    }
    // ==================== Reflections ====================
    /**
     * Store a reflection: a `learned-reflection` entry plus a reflection record.
     *
     * The dedup hash covers `(scope, project, sorted evidence, NFKC summary)`.
     * The store reports an exact match as `duplicate` and writes nothing.
     * The store saves a same-evidence reflection with a different summary as its own entry and record.
     * Additive only.
     */
    async createReflection(input) {
        // One transaction: a failure part-way (a cited endpoint missing, say) must
        // not leave an entry carrying the dedup hash with no citations or record,
        // which a retry would then report as a duplicate and never complete.
        return this.write(() => this.createReflectionSync(input));
    }
    createReflectionSync(input) {
        const hash = reflectionHash(input);
        const existing = this.findReflectionByHash(hash);
        if (existing)
            return { duplicate: true, id: existing };
        const evidence = [...input.evidence];
        if (evidence.length === 0)
            evidence.push(input.summary);
        for (const attempt of input.attempts ?? [])
            evidence.push(`attempt:${attempt}`);
        // Version the reflection entry within its own chain so a later run can
        // revise the same conclusion without touching the earlier one.
        const slug = input.slug ?? reflectionSlug(input.summary);
        const previous = this.latestBySlug('reflection', input.project, slug);
        const version = previous ? previous.version + 1 : 1;
        const id = entryName('reflection', input.project, slug, version);
        const entry = {
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
            createdAt: nowIso(),
            supersededBy: null,
            validation: null,
            heuristicIds: [],
            decisionId: null,
            procedureId: null,
        };
        this.putEntrySync(entry, hash);
        for (const attempt of input.attempts ?? []) {
            const taskId = input.attemptTasks?.find(a => a.id === attempt)?.taskId ?? 0;
            this.citeAttemptSync(id, attempt, taskId, entry.runId);
        }
        this.insertReflectionRecord(input.scope, input.project, evidence, input.summary, input.confidence);
        return { duplicate: false, id };
    }
    /**
     * Write the reflection record that accompanies a `learned-reflection` entry written by someone else.
     * One such writer is `knowledge-db.insertKnowledgeEntry`.
     */
    async recordReflectionRecord(input) {
        const evidence = input.evidence.length > 0 ? [...input.evidence] : [input.entryId];
        this.insertReflectionRecord(input.scope, input.project, evidence, input.summary, input.confidence);
    }
    insertReflectionRecord(scope, project, evidence, summary, confidence) {
        const id = `reflection-${randomUUID()}`;
        const now = nowIso();
        const record = {
            id,
            timestamp: now,
            scope,
            summary,
            evidence: [...evidence],
            generalization_confidence: CONFIDENCE_SCORE[confidence],
            sourceProjectId: project,
        };
        this.write(() => this.insertEntities([
            {
                name: id,
                entityType: REFLECTION_RECORD_TYPE,
                observations: [`[reflection:${scope}] ${summary}`],
                importance: 5,
                createdAt: now,
                metadata: {
                    memoryType: REFLECTION_RECORD_TYPE,
                    confidence: record.generalization_confidence,
                    reflectionRecord: record,
                },
            },
        ]));
    }
    /** Find a learned-reflection entry carrying this dedup hash. */
    findReflectionByHash(hash) {
        const marker = `${OBS.reflectionHash}${hash}`;
        const hit = this.entitiesOfType(REFLECTION_TYPE).find(e => e.observations.includes(marker));
        return hit?.name ?? null;
    }
    /** Reflection records, oldest first. */
    async listReflections() {
        return this.entitiesOfType(REFLECTION_RECORD_TYPE)
            .map(e => e.metadata.reflectionRecord)
            .filter((r) => r !== undefined)
            .map(r => ({ id: r.id, scope: r.scope, summary: r.summary, evidence: [...r.evidence] }));
    }
}
function encodeProcedure(description, steps, successRate, executionCount) {
    const observations = [];
    if (description.trim() !== '')
        observations.push(description);
    observations.push(`${PROCEDURE_SUCCESS_RATE}${successRate}`);
    observations.push(`${PROCEDURE_EXECUTION_COUNT}${executionCount}`);
    observations.push(`${PROCEDURE_STEPS}${JSON.stringify(steps)}`);
    return observations;
}
/** `"key"=<json>` as the previous adapter wrote step parameters. */
function decodeKeyValue(body) {
    if (!body.startsWith('"'))
        return null;
    let i = 1;
    while (i < body.length && body[i] !== '"')
        i += body[i] === '\\' ? 2 : 1;
    if (i >= body.length || body[i + 1] !== '=')
        return null;
    try {
        const key = JSON.parse(body.slice(0, i + 1));
        const value = JSON.parse(body.slice(i + 2));
        return typeof key === 'string' ? [key, value] : null;
    }
    catch {
        return null;
    }
}
/** The dedup hash over `(scope, project, sorted evidence, NFKC summary)`. */
function reflectionHash(input) {
    const evidence = [...input.evidence].sort().join('|');
    const summary = input.summary.normalize('NFKC');
    return createHash('sha256')
        .update(`${input.scope}|${input.project}|${evidence}|${summary}`)
        .digest('hex');
}
/** A filesystem-safe slug derived from a reflection's summary. */
function reflectionSlug(summary) {
    const slug = summary
        .normalize('NFKC')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 48)
        .replace(/-+$/g, '');
    return slug || 'reflection';
}
function firstLine(text) {
    const line = text.split('\n')[0]?.trim() ?? '';
    return line.length > 0 ? line : text.trim().slice(0, 80);
}
/** Open the knowledge store. Synchronous; starts no timers. */
export function openKnowledgeStore(options = {}) {
    return KnowledgeStore.create(options.dbPath ?? getKnowledgeDbPath(), { readonly: options.readonly });
}
