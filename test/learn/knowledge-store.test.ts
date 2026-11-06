import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  getLearnedDir,
  getKnowledgeDbPath,
  getLearningDbPath,
} from '../../src/paths.js';
import type { KnowledgeEntry, NewKnowledgeEntry, ProcedureStepSpec, SourceRef } from '../../src/learn/types.js';
import { openKnowledgeStore, type KnowledgeStore } from '../../src/learn/knowledge-store.js';
import { insertKnowledgeEntry } from '../../src/learn/knowledge-db.js';
import { safeRmSync, suppressConsole } from '../test-utils.js';

suppressConsole();

/** A temp directory whose real path contains no `..` segment (memoryjs rejects those). */
function makeTempDir(prefix: string): string {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

function source(over: Partial<SourceRef> = {}): SourceRef {
  return {
    id: 'ex1',
    path: '/archive/a.jsonl',
    lineStart: 3,
    lineEnd: 9,
    sessionId: 'sess-1',
    ...over,
  };
}

function newEntry(over: Partial<NewKnowledgeEntry> = {}): NewKnowledgeEntry {
  return {
    kind: 'skill',
    project: 'proj-a',
    slug: 'alpha',
    title: 'Alpha skill',
    description: 'Use when the user asks about alpha',
    body: 'alpha lives in the archive',
    scope: 'proj-a repository work',
    confidence: 'medium',
    trust: 'unverified',
    sources: [source()],
    status: 'candidate',
    runId: 'run-1',
    ...over,
  };
}

/** A full KnowledgeEntry for direct `putEntry` writes (bypassing slug rules). */
function fullEntry(over: Partial<KnowledgeEntry> = {}): KnowledgeEntry {
  const base = newEntry();
  return {
    id: `learned:${base.kind}:${base.project}:${base.slug}:v1`,
    version: 1,
    createdAt: '2026-11-05T00:00:00.000Z',
    supersededBy: null,
    validation: null,
    heuristicIds: [],
    decisionId: null,
    procedureId: null,
    ...base,
    ...over,
  } as KnowledgeEntry;
}

describe('knowledge store (memoryjs adapter)', () => {
  let configDir: string;
  let store: KnowledgeStore | null = null;
  const savedConfigDir = process.env.EPISODIC_MEMORY_CONFIG_DIR;

  beforeEach(() => {
    configDir = makeTempDir('em-learn-store-');
    process.env.EPISODIC_MEMORY_CONFIG_DIR = configDir;
  });

  afterEach(() => {
    try {
      store?.close();
    } finally {
      store = null;
      if (savedConfigDir === undefined) delete process.env.EPISODIC_MEMORY_CONFIG_DIR;
      else process.env.EPISODIC_MEMORY_CONFIG_DIR = savedConfigDir;
      safeRmSync(configDir);
    }
  });

  it('openKnowledgeStore creates learned/ and knowledge.db and reopens the same data', async () => {
    store = openKnowledgeStore();
    await store.putEntry(fullEntry());
    store.close();

    expect(fs.existsSync(getLearnedDir())).toBe(true);
    expect(path.normalize(getLearnedDir())).toBe(path.normalize(path.join(configDir, 'learned')));
    expect(fs.existsSync(getKnowledgeDbPath())).toBe(true);

    store = openKnowledgeStore();
    const got = await store.getEntry('learned:skill:proj-a:alpha:v1');
    expect(got?.title).toBe('Alpha skill');
    expect(got?.slug).toBe('alpha');
    expect(got?.project).toBe('proj-a');
    expect(got?.version).toBe(1);
  });

  it('MEMORY_STORAGE_TYPE=jsonl and MEMORY_OBSERVATION_DEDUP=true in the env still yield a SQLite store, two near-identical body lines both persist, semanticSearch is null, and the env is restored', async () => {
    const saved: Record<string, string | undefined> = {};
    const set = (key: string, value: string) => {
      saved[key] = process.env[key];
      process.env[key] = value;
    };
    set('MEMORY_STORAGE_TYPE', 'jsonl');
    set('MEMORY_OBSERVATION_DEDUP', 'true');
    set('MEMORY_EMBEDDING_PROVIDER', 'local');

    try {
      store = openKnowledgeStore();
      expect(store.storageConstructorName).toBe('SQLiteStorage');
      expect(store.semanticSearchIsNull).toBe(true);

      const body = [
        'alpha burrows at night and returns before dawn',
        'alpha burrows at night and returns before dawn!',
      ].join('\n');
      await store.putEntry(fullEntry({ body }));
      store.close();
      store = openKnowledgeStore();
      const got = await store.getEntry('learned:skill:proj-a:alpha:v1');
      expect(got?.body.split('\n')).toHaveLength(2);
      expect(got?.body.split('\n')[0]).toBe('alpha burrows at night and returns before dawn');
      expect(got?.body.split('\n')[1]).toBe('alpha burrows at night and returns before dawn!');

      // The adapter scopes and restores every MEMORY_* key it touches.
      expect(process.env.MEMORY_STORAGE_TYPE).toBe('jsonl');
      expect(process.env.MEMORY_OBSERVATION_DEDUP).toBe('true');
      expect(process.env.MEMORY_EMBEDDING_PROVIDER).toBe('local');
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  it('a write through one context is not visible to a context opened earlier and is visible to one opened afterwards', async () => {
    store = openKnowledgeStore();
    await store.putEntry(fullEntry());

    const earlier = openKnowledgeStore();
    try {
      // Load `earlier`'s cache before the other context writes. memoryjs serves
      // every read from a per-context snapshot loaded once, on first use.
      expect(await earlier.getEntry('learned:skill:proj-a:alpha:v1')).not.toBeNull();

      const later = openKnowledgeStore();
      try {
        await later.putEntry(
          fullEntry({
            id: 'learned:skill:proj-a:beta:v1',
            slug: 'beta',
            title: 'Beta skill',
          })
        );
        expect(await earlier.getEntry('learned:skill:proj-a:beta:v1')).toBeNull();

        const after = openKnowledgeStore();
        try {
          expect((await after.getEntry('learned:skill:proj-a:beta:v1'))?.title).toBe('Beta skill');
        } finally {
          after.close();
        }
      } finally {
        later.close();
      }
    } finally {
      earlier.close();
    }
  });

  it("an entry's KnowledgeEntry.trust and trust: observation/tag survive a reopen", async () => {
    store = openKnowledgeStore();
    await store.putEntry(fullEntry({ trust: 'verified' }));
    store.close();

    store = openKnowledgeStore();
    const got = await store.getEntry('learned:skill:proj-a:alpha:v1');
    expect(got?.trust).toBe('verified');

    // Read the raw entity back through the store's parse path.
    const raw = await store.getRawEntity('learned:skill:proj-a:alpha:v1');
    expect(raw?.observations).toContain('trust: verified');
    expect(raw?.tags).toContain('trust:verified');
  });

  it('putEntry writes one entity per version with the fixed observation keys, tags, lifecycleStatus and cites relations to exchange refs', async () => {
    store = openKnowledgeStore();
    await store.putEntry(
      fullEntry({
        kind: 'instruction',
        id: 'learned:instruction:proj-a:gamma:v1',
        slug: 'gamma',
        status: 'active',
        confidence: 'high',
        trust: 'ground-truth',
        validation: {
          targeted: [4],
          sample: [1, 2],
          passedBefore: 1,
          passedAfter: 3,
          regressions: [],
          judgedAt: '2026-11-05T01:00:00.000Z',
          meanTurnsBefore: null,
          meanTurnsAfter: null,
          usdBefore: null,
          usdAfter: null,
        },
        heuristicIds: ['h_1', 'h_2'],
        decisionId: 'decision-1',
      })
    );
    store.close();
    store = null;

    const dbPath = getKnowledgeDbPath();
    const ro = new Database(dbPath, { readonly: true });
    try {
      const row = ro
        .prepare('SELECT * FROM entities WHERE name = ?')
        .get('learned:instruction:proj-a:gamma:v1') as {
        entityType: string;
        observations: string;
        tags: string;
        importance: number;
        projectId: string;
        rootEntityName: string | null;
        isLatest: number;
        agentMetadata: string | null;
      };
      expect(row).toBeTruthy();
      expect(row.entityType).toBe('learned-instruction');
      expect(row.projectId).toBe('proj-a');
      expect(row.importance).toBe(8);
      expect(JSON.parse(row.tags)).toEqual([
        'kind:instruction',
        'project:proj-a',
        'trust:ground-truth',
        'status:active',
      ]);
      const observations = JSON.parse(row.observations) as string[];
      expect(observations).toContain('title: Alpha skill');
      expect(observations).toContain('description: Use when the user asks about alpha');
      expect(observations).toContain('scope: proj-a repository work');
      expect(observations).toContain('confidence: high');
      expect(observations).toContain('trust: ground-truth');
      expect(observations).toContain('status: active');
      expect(observations).toContain('version: 1');
      expect(observations).toContain('run: run-1');
      expect(observations.some(o => o.startsWith('validation: {'))).toBe(true);
      expect(observations).toContain('heuristic: h_1');
      expect(observations).toContain('heuristic: h_2');
      expect(observations).toContain('decision: decision-1');
      expect(observations).toContain('body: alpha lives in the archive');
      expect(JSON.parse(row.agentMetadata ?? '{}').lifecycleStatus).toBe('published');
      expect(row.rootEntityName).toBe('learned:instruction:proj-a:gamma:v1');
      expect(row.isLatest).toBe(1);

      const ref = ro
        .prepare('SELECT * FROM entities WHERE name = ?')
        .get('exchange:ex1') as { entityType: string; observations: string };
      expect(ref.entityType).toBe('exchange-ref');
      expect(JSON.parse(ref.observations)).toEqual([
        'path: /archive/a.jsonl',
        'lines: 3-9',
        'session: sess-1',
      ]);

      const rel = ro
        .prepare('SELECT * FROM relations WHERE fromEntity = ? AND toEntity = ?')
        .get('learned:instruction:proj-a:gamma:v1', 'exchange:ex1') as {
        relationType: string;
      };
      expect(rel.relationType).toBe('cites');
    } finally {
      ro.close();
    }
  });

  it('supersede sets supersededBy and isLatest on the older entity', async () => {
    store = openKnowledgeStore();
    await store.putEntry(fullEntry({ status: 'active' }));
    await store.putEntry(
      fullEntry({
        id: 'learned:skill:proj-a:alpha:v2',
        version: 2,
        title: 'Alpha skill v2',
        status: 'candidate',
      })
    );
    await store.supersede('learned:skill:proj-a:alpha:v1', 'learned:skill:proj-a:alpha:v2');

    const older = await store.getEntry('learned:skill:proj-a:alpha:v1');
    expect(older?.supersededBy).toBe('learned:skill:proj-a:alpha:v2');
    // `supersede` is a chain write; it does not change the entry's own status.
    expect(older?.status).toBe('active');

    const raw = await store.getRawEntity('learned:skill:proj-a:alpha:v1');
    expect(raw?.isLatest).toBe(false);

    const latest = await store.getBySlug('skill', 'proj-a', 'alpha');
    expect(latest?.id).toBe('learned:skill:proj-a:alpha:v2');
  });

  it('search by kind tag post-filters project and * and never returns a draft or archived entity', async () => {
    store = openKnowledgeStore();
    await store.putEntry(
      fullEntry({ status: 'active', body: 'aardvark burrow habits in project a' })
    );
    await store.putEntry(
      fullEntry({
        id: 'learned:skill:*:beta:v1',
        slug: 'beta',
        project: '*',
        status: 'active',
        body: 'aardvark facts shared across projects',
      })
    );
    await store.putEntry(
      fullEntry({
        id: 'learned:skill:proj-a:delta:v1',
        slug: 'delta',
        status: 'candidate',
        body: 'aardvark draft notes',
      })
    );
    await store.putEntry(
      fullEntry({
        id: 'learned:skill:proj-b:epsilon:v1',
        slug: 'epsilon',
        project: 'proj-b',
        status: 'active',
        body: 'aardvark habits in another project',
      })
    );

    const results = await store.search('aardvark', { kinds: ['skill'], project: 'proj-a', limit: 10 });
    const names = results.map(r => r.id);
    expect(names).toContain('learned:skill:proj-a:alpha:v1');
    expect(names).toContain('learned:skill:*:beta:v1');
    expect(names).not.toContain('learned:skill:proj-a:delta:v1');
    expect(names).not.toContain('learned:skill:proj-b:epsilon:v1');
    for (const entry of results) {
      expect(entry.status).toBe('active');
      expect(entry.project === 'proj-a' || entry.project === '*').toBe(true);
    }

    // A kind filter excludes other kinds entirely.
    const other = await store.search('aardvark', { kinds: ['instruction'], project: 'proj-a', limit: 10 });
    expect(other).toEqual([]);
  });

  it('createReflection reports duplicate on the same evidence and summary, and stores a distinct record for the same evidence with a different summary', async () => {
    store = openKnowledgeStore();

    const first = await store.createReflection({
      scope: 'project',
      project: 'proj-a',
      evidence: ['exchange:ex1', 'exchange:ex2'],
      summary: 'Searches in this project go faster with the archive path',
      confidence: 'medium',
      attempts: [7],
    });
    expect(first.duplicate).toBe(false);
    expect(first.id).toBeTruthy();

    const again = await store.createReflection({
      scope: 'project',
      project: 'proj-a',
      evidence: ['exchange:ex2', 'exchange:ex1'],
      summary: 'Searches in this project go faster with the archive path',
      confidence: 'medium',
      attempts: [7],
    });
    expect(again.duplicate).toBe(true);
    expect(again.id).toBe(first.id);

    const different = await store.createReflection({
      scope: 'project',
      project: 'proj-a',
      evidence: ['exchange:ex1', 'exchange:ex2'],
      summary: 'Digest first, then search, saves a turn',
      confidence: 'low',
      attempts: [8],
    });
    expect(different.duplicate).toBe(false);
    expect(different.id).toBeTruthy();
    expect(different.id).not.toBe(first.id);
  });

  it('a procedure skill with steps gets a proc: record and matchProcedures ranks it for a matching context', async () => {
    store = openKnowledgeStore();
    const steps: ProcedureStepSpec[] = [
      { action: 'search', parameters: { query: 'alpha deployment pipeline' } },
      { action: 'read', parameters: { lines: '1-20' } },
    ];
    await insertKnowledgeEntry(store, newEntry({ steps, body: 'alpha deployment pipeline steps' }));

    const entry = await store.getEntry('learned:skill:proj-a:alpha:v1');
    expect(entry?.procedureId).toBe('proc:proj-a:alpha');
    expect(entry?.steps).toEqual(steps);

    const proc = await store.getProcedure('proc:proj-a:alpha');
    expect(proc?.name).toBe('proc:proj-a:alpha');
    expect(proc?.steps.map(s => s.action)).toEqual(['search', 'read']);
    expect(proc?.steps.map(s => s.order)).toEqual([1, 2]);
    // memoryjs stores procedure triggers lower-cased.
    expect(proc?.triggers).toContain('use when the user asks about alpha');
    expect(proc?.description).toBe('Use when the user asks about alpha');

    const ranked = await store.matchProcedures('alpha deployment pipeline', ['proc:proj-a:alpha']);
    expect(ranked.length).toBeGreaterThan(0);
    expect(ranked[0].procedure.id).toBe('proc:proj-a:alpha');
    expect(ranked[0].score).toBeGreaterThan(0);

    const unrelated = await store.matchProcedures('zebra migration rollback', ['proc:proj-a:alpha']);
    expect(unrelated).toEqual([]);
  });

  it('a stored reflection keeps its dedup marker across a status change and is still reported as duplicate', async () => {
    store = openKnowledgeStore();
    const first = await store.createReflection({
      scope: 'project',
      project: 'proj-a',
      evidence: ['exchange:ex1'],
      summary: 'This project prefers digest first',
      confidence: 'medium',
      attempts: [11],
    });
    expect(first.duplicate).toBe(false);

    await store.setStatus(first.id!, 'active');
    await store.setTrust(first.id!, 'verified');

    const again = await store.createReflection({
      scope: 'project',
      project: 'proj-a',
      evidence: ['exchange:ex1'],
      summary: 'This project prefers digest first',
      confidence: 'medium',
      attempts: [11],
    });
    expect(again.duplicate).toBe(true);
    expect(again.id).toBe(first.id);
  });

  it('redactPii strips an email and a phone number and leaves a [#<32hex>] mark and a path: line untouched', () => {
    store = openKnowledgeStore();
    const text = 'ask dana@example.com or call 555-123-4567 about it';
    const redacted = store.redactPii(text);
    expect(redacted).not.toContain('dana@example.com');
    expect(redacted).not.toContain('555-123-4567');
    expect(redacted).toContain('<EMAIL>');
    expect(redacted).toContain('<PHONE>');

    const mark = '[#a1b2c3d4e5f60718293a4b5c6d7e8f90]';
    expect(store.redactPii(`alpha lives here ${mark}`)).toBe(`alpha lives here ${mark}`);
    expect(store.redactPii('path: /archive/a.jsonl')).toBe('path: /archive/a.jsonl');
  });

  it('types.ts has no import from @danielsimonjr/memoryjs', () => {
    const sourceText = fs.readFileSync(path.resolve(__dirname, '../../src/learn/types.ts'), 'utf-8');
    expect(sourceText).not.toContain('@danielsimonjr/memoryjs');
    const importLines = sourceText
      .split('\n')
      .map(line => line.trim())
      .filter(line => /^import\b/.test(line));
    // Only type imports, so the compiled module has no runtime dependencies.
    for (const line of importLines) expect(line.startsWith('import type ')).toBe(true);
  });

  it('the learning trace path lives beside knowledge.db under learned/', () => {
    expect(path.normalize(getLearningDbPath())).toBe(
      path.normalize(path.join(configDir, 'learned', 'learning.sqlite'))
    );
    expect(path.normalize(path.dirname(getLearningDbPath()))).toBe(path.normalize(getLearnedDir()));
  });
});
