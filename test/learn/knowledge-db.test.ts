import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { getLearnedDir } from '../../src/paths.js';
import { openKnowledgeStore, type KnowledgeStore } from '../../src/learn/knowledge-store.js';
import { openLearningDb, migrateLearningSchema } from '../../src/learn/learning-store.js';
import {
  insertKnowledgeEntry,
  activate,
  retire,
  listActive,
  listCandidates,
  getEntry,
  getBySlug,
  searchKnowledge,
  createSnapshot,
  getSnapshot,
  DuplicateEntry,
} from '../../src/learn/knowledge-db.js';
import type {
  KnowledgeEntry,
  NewKnowledgeEntry,
  ValidationRecord,
} from '../../src/learn/types.js';
import { safeRmSync, suppressConsole } from '../test-utils.js';

suppressConsole();

function makeTempDir(prefix: string): string {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

function nk(over: Partial<NewKnowledgeEntry> = {}): NewKnowledgeEntry {
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
    sources: [],
    status: 'candidate',
    runId: 'run-1',
    ...over,
  };
}

function record(over: Partial<ValidationRecord> = {}): ValidationRecord {
  return {
    targeted: [3],
    sample: [1, 2],
    passedBefore: 1,
    passedAfter: 2,
    regressions: [],
    judgedAt: '2026-11-05T00:00:00.000Z',
    meanTurnsBefore: null,
    meanTurnsAfter: null,
    usdBefore: null,
    usdAfter: null,
    ...over,
  };
}

describe('knowledge-db', () => {
  let configDir: string;
  let store: KnowledgeStore;
  const savedConfig = process.env.EPISODIC_MEMORY_CONFIG_DIR;

  beforeEach(() => {
    configDir = makeTempDir('em-learn-kdb-');
    process.env.EPISODIC_MEMORY_CONFIG_DIR = configDir;
    store = openKnowledgeStore();
  });

  afterEach(() => {
    try {
      store.close();
    } finally {
      if (savedConfig === undefined) delete process.env.EPISODIC_MEMORY_CONFIG_DIR;
      else process.env.EPISODIC_MEMORY_CONFIG_DIR = savedConfig;
      safeRmSync(configDir);
    }
  });

  it('insert rejects an invalid slug and a reserved name', async () => {
    await expect(insertKnowledgeEntry(store, nk({ slug: 'Not A Slug' }))).rejects.toThrow();
    await expect(insertKnowledgeEntry(store, nk({ slug: '' }))).rejects.toThrow();
    await expect(insertKnowledgeEntry(store, nk({ slug: 'com1' }))).rejects.toThrow(/reserved/i);
    await expect(insertKnowledgeEntry(store, nk({ slug: 'lpt9' }))).rejects.toThrow(/reserved/i);
    await expect(insertKnowledgeEntry(store, nk({ slug: 'con' }))).rejects.toThrow(/reserved/i);
  });

  it('insert of an identical body is rejected as duplicate', async () => {
    const id = await insertKnowledgeEntry(store, nk());
    expect(id).toBe('learned:skill:proj-a:alpha:v1');
    await expect(insertKnowledgeEntry(store, nk())).rejects.toBeInstanceOf(DuplicateEntry);
  });

  it('second insert of a changed body gets version 2 with parentEntityName set', async () => {
    await insertKnowledgeEntry(store, nk());
    const id = await insertKnowledgeEntry(store, nk({ body: 'alpha actually lives in the digest' }));
    expect(id).toBe('learned:skill:proj-a:alpha:v2');

    const raw = await store.getRawEntity(id);
    expect(raw?.parentEntityName).toBe('learned:skill:proj-a:alpha:v1');
    expect((await getEntry(store, id))?.version).toBe(2);
  });

  it('activate supersedes the older active version and keeps it', async () => {
    await insertKnowledgeEntry(store, nk());
    await activate(store, 'learned:skill:proj-a:alpha:v1', record(), 'verified');

    const active = await getEntry(store, 'learned:skill:proj-a:alpha:v1');
    expect(active?.status).toBe('active');
    expect(active?.trust).toBe('verified');
    expect(active?.validation?.passedAfter).toBe(2);

    const v2 = await insertKnowledgeEntry(store, nk({ body: 'a better alpha body' }));
    await activate(store, v2, record({ targeted: [9] }), 'ground-truth');

    const older = await getEntry(store, 'learned:skill:proj-a:alpha:v1');
    expect(older?.supersededBy).toBe(v2);
    // Kept, not deleted.
    expect(older).not.toBeNull();
    const stillThere = await store.getRawEntity('learned:skill:proj-a:alpha:v1');
    expect(stillThere?.name).toBe('learned:skill:proj-a:alpha:v1');

    const current = await listActive(store, ['skill'], 'proj-a');
    expect(current.map(e => e.id)).toEqual([v2]);
  });

  it('retire hides from listActive and keeps the entity', async () => {
    await insertKnowledgeEntry(store, nk());
    await activate(store, 'learned:skill:proj-a:alpha:v1', record(), 'verified');
    await retire(store, 'learned:skill:proj-a:alpha:v1');

    expect(await listActive(store, ['skill'], 'proj-a')).toEqual([]);
    const retired = await getEntry(store, 'learned:skill:proj-a:alpha:v1');
    expect(retired?.status).toBe('retired');
    expect(retired).not.toBeNull();
  });

  it('listActive order', async () => {
    // reflection, then skill, then instruction; project rows before '*'; then slug.
    await insertKnowledgeEntry(store, nk({ kind: 'skill', slug: 'zeta' }));
    await insertKnowledgeEntry(store, nk({ kind: 'instruction', slug: 'beta' }));
    await insertKnowledgeEntry(store, nk({ kind: 'skill', slug: 'gamma' }));
    await insertKnowledgeEntry(store, nk({ kind: 'skill', slug: 'global-one', project: '*' }));
    await insertKnowledgeEntry(store, nk({ kind: 'reflection', slug: 'refl' }));

    for (const id of [
      'learned:skill:proj-a:zeta:v1',
      'learned:instruction:proj-a:beta:v1',
      'learned:skill:proj-a:gamma:v1',
      'learned:skill:*:global-one:v1',
      'learned:reflection:proj-a:refl:v1',
    ]) {
      await activate(store, id, null, 'verified');
    }

    const ordered = await listActive(store, ['instruction', 'skill', 'reflection'], 'proj-a');
    expect(ordered.map(e => e.id)).toEqual([
      'learned:instruction:proj-a:beta:v1',
      'learned:skill:proj-a:gamma:v1',
      'learned:skill:proj-a:zeta:v1',
      'learned:reflection:proj-a:refl:v1',
      'learned:skill:*:global-one:v1',
    ]);
  });

  it('listCandidates lists only candidates', async () => {
    await insertKnowledgeEntry(store, nk({ slug: 'one' }));
    await insertKnowledgeEntry(store, nk({ slug: 'two' }));
    await activate(store, 'learned:skill:proj-a:two:v1', record(), 'verified');

    const candidates = await listCandidates(store, 'skill');
    expect(candidates.map(e => e.slug)).toEqual(['one']);
  });

  it('getBySlug returns the latest version', async () => {
    await insertKnowledgeEntry(store, nk());
    await insertKnowledgeEntry(store, nk({ body: 'a revised body' }));
    const latest = await getBySlug(store, 'skill', 'proj-a', 'alpha');
    expect(latest?.version).toBe(2);
    expect(latest?.body).toBe('a revised body');
  });

  it('searchKnowledge finds a word in body', async () => {
    await insertKnowledgeEntry(store, nk({ slug: 'aardvark', body: 'the aardvark burrows at night' }));
    await insertKnowledgeEntry(store, nk({ slug: 'zebra', body: 'zebra stripes confuse flies' }));
    await activate(store, 'learned:skill:proj-a:aardvark:v1', record(), 'verified');
    await activate(store, 'learned:skill:proj-a:zebra:v1', record(), 'verified');

    const results = await searchKnowledge(store, 'aardvark', 'proj-a');
    expect(results.map(e => e.slug)).toEqual(['aardvark']);
  });

  it('snapshot records active names at creation and not later ones', async () => {
    await insertKnowledgeEntry(store, nk({ slug: 'one' }));
    await activate(store, 'learned:skill:proj-a:one:v1', record(), 'verified');

    const learning = openLearningDb();
    try {
      const first = await createSnapshot(learning, 'run-1', undefined, store);
      expect(getSnapshot(learning, first)).toEqual(['learned:skill:proj-a:one:v1']);

      await insertKnowledgeEntry(store, nk({ slug: 'two' }));
      await activate(store, 'learned:skill:proj-a:two:v1', record(), 'verified');

      // The old snapshot is unchanged; a new one sees the new entry.
      expect(getSnapshot(learning, first)).toEqual(['learned:skill:proj-a:one:v1']);
      const second = await createSnapshot(learning, 'run-1', undefined, store);
      expect(getSnapshot(learning, second)).toEqual([
        'learned:skill:proj-a:one:v1',
        'learned:skill:proj-a:two:v1',
      ]);
    } finally {
      learning.close();
    }
  });

  it('snapshot with explicit names records exactly those', async () => {
    await insertKnowledgeEntry(store, nk({ slug: 'one' }));
    await activate(store, 'learned:skill:proj-a:one:v1', record(), 'verified');
    await insertKnowledgeEntry(store, nk({ slug: 'two' }));

    const learning = openLearningDb();
    try {
      const id = await createSnapshot(learning, 'run-2', ['learned:skill:proj-a:two:v1']);
      expect(getSnapshot(learning, id)).toEqual(['learned:skill:proj-a:two:v1']);
    } finally {
      learning.close();
    }
  });

  it('an instruction entry gets a heuristic record per line and activate reinforces it', async () => {
    const body = [
      'project proj-a: check the archive index first [#a1b2c3d4e5f60718293a4b5c6d7e8f90]',
      'mode vector for deployment steps [#a1b2c3d4e5f60718293a4b5c6d7e8f90]',
    ].join('\n');
    await insertKnowledgeEntry(store, nk({ kind: 'instruction', slug: 'instr', body }));
    const entry = await getEntry(store, 'learned:instruction:proj-a:instr:v1');
    expect(entry?.heuristicIds).toHaveLength(2);
    expect(entry?.decisionId).toBeTruthy();

    const before = store.getHeuristic(entry!.heuristicIds[0]);
    await activate(store, entry!.id, record(), 'verified');
    const after = store.getHeuristic(entry!.heuristicIds[0]);
    expect(after!.support).toBeGreaterThan(before!.support);
  });

  it('a skill entry gets a decision proposal that activate accepts', async () => {
    await insertKnowledgeEntry(store, nk());
    const entry = await getEntry(store, 'learned:skill:proj-a:alpha:v1');
    expect(entry?.decisionId).toBeTruthy();
    expect(store.getDecision(entry!.decisionId!)?.status).toBe('proposed');
    await activate(store, entry!.id, record(), 'verified');
    expect(store.getDecision(entry!.decisionId!)?.status).toBe('accepted');
  });

  it('activate rejects a trust level outside the two verified levels', async () => {
    await insertKnowledgeEntry(store, nk());
    // @ts-expect-error deliberately widening beyond the permitted union
    await expect(activate(store, 'learned:skill:proj-a:alpha:v1', record(), 'unverified')).rejects.toThrow();
  });

  it('migrateLearningSchema is exported for a caller that already owns a handle', () => {
    const learning = openLearningDb();
    try {
      migrateLearningSchema(learning);
      const row = learning
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='knowledge_snapshot'")
        .get() as { name: string } | undefined;
      expect(row?.name).toBe('knowledge_snapshot');
    } finally {
      learning.close();
    }
  });

  it('getEntry returns null for an unknown name and a bare project entry', async () => {
    expect(await getEntry(store, 'learned:skill:nope:none:v1')).toBeNull();
    const id = await insertKnowledgeEntry(store, nk({ project: '*' }));
    const entry: KnowledgeEntry | null = await getEntry(store, id);
    expect(entry?.project).toBe('*');
    expect(path.normalize(getLearnedDir())).toBe(path.normalize(path.join(configDir, 'learned')));
  });
});
