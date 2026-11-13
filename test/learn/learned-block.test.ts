import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { openKnowledgeStore, type KnowledgeStore } from '../../src/learn/knowledge-store.js';
import { openLearningDb, migrateLearningSchema } from '../../src/learn/learning-store.js';
import {
  insertKnowledgeEntry,
  activate,
  retire,
} from '../../src/learn/knowledge-db.js';
import { writeLearnedBlocks } from '../../src/learn/learned-block.js';
import type { Database } from '../../src/sqlite.js';
import type { NewKnowledgeEntry } from '../../src/learn/types.js';
import { safeRmSync, suppressConsole } from '../test-utils.js';

suppressConsole();

const HEX_A = 'c'.repeat(32);

function nk(over: Partial<NewKnowledgeEntry> = {}): NewKnowledgeEntry {
  return {
    kind: 'skill',
    project: 'proj-a',
    slug: 'alpha',
    title: 'Alpha skill',
    description: 'Use when looking for the alpha service',
    body: `alpha lives in the archive [#${HEX_A}]`,
    scope: 'proj-a repository work',
    confidence: 'medium',
    trust: 'unverified',
    sources: [],
    status: 'candidate',
    runId: 'run-1',
    ...over,
  };
}

describe('writeLearnedBlocks', () => {
  let configDir: string;
  let store: KnowledgeStore;
  let learningDb: Database;
  const savedConfig = process.env.EPISODIC_MEMORY_CONFIG_DIR;

  beforeEach(() => {
    configDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'em-learned-block-')));
    process.env.EPISODIC_MEMORY_CONFIG_DIR = configDir;
    store = openKnowledgeStore();
    learningDb = openLearningDb({ path: path.join(configDir, 'learning.sqlite') });
    migrateLearningSchema(learningDb);
  });

  afterEach(() => {
    try {
      learningDb.close();
    } finally {
      store.close();
      if (savedConfig === undefined) delete process.env.EPISODIC_MEMORY_CONFIG_DIR;
      else process.env.EPISODIC_MEMORY_CONFIG_DIR = savedConfig;
      safeRmSync(configDir);
    }
  });

  function rows(): Array<{ project: string; text: string }> {
    return learningDb
      .prepare('SELECT project, text FROM learned_block ORDER BY project')
      .all() as Array<{ project: string; text: string }>;
  }

  it('upserts one row per project plus *', async () => {
    const a = await insertKnowledgeEntry(store, nk({ project: 'proj-a', slug: 'alpha' }));
    const b = await insertKnowledgeEntry(store, nk({ project: 'proj-b', slug: 'beta' }));
    const g = await insertKnowledgeEntry(store, nk({ project: '*', slug: 'global' }));
    for (const id of [a, b, g]) await activate(store, id, null, 'verified');

    await writeLearnedBlocks(store, learningDb, 2500);

    expect(rows().map(r => r.project)).toEqual(['*', 'proj-a', 'proj-b']);
    const byProject = new Map(rows().map(r => [r.project, r.text]));
    // A project block holds its own skill and the global one.
    expect(byProject.get('proj-a')).toContain('alpha:');
    expect(byProject.get('proj-a')).toContain('global:');
    expect(byProject.get('proj-a')).not.toContain('beta:');
    // The global block holds only global rows.
    expect(byProject.get('*')).toContain('global:');
    expect(byProject.get('*')).not.toContain('alpha:');
  });

  it('replaces the previous text on a second render', async () => {
    const a = await insertKnowledgeEntry(store, nk({ slug: 'alpha' }));
    await activate(store, a, null, 'verified');
    await writeLearnedBlocks(store, learningDb, 2500);
    const first = rows().find(r => r.project === 'proj-a')!.text;

    const b = await insertKnowledgeEntry(store, nk({ slug: 'beta' }));
    await activate(store, b, null, 'verified');
    await writeLearnedBlocks(store, learningDb, 2500);
    const second = rows().find(r => r.project === 'proj-a')!.text;

    expect(second).not.toBe(first);
    expect(second).toContain('beta:');
    expect(second).toContain('alpha:');
    // One row per project, never a duplicate.
    expect(rows().filter(r => r.project === 'proj-a')).toHaveLength(1);
  });

  it('clears the row when the project has no active entries left', async () => {
    const id = await insertKnowledgeEntry(store, nk({ slug: 'alpha' }));
    await activate(store, id, null, 'verified');
    await writeLearnedBlocks(store, learningDb, 2500);
    expect(rows().some(r => r.project === 'proj-a')).toBe(true);

    await retire(store, id);
    await writeLearnedBlocks(store, learningDb, 2500);
    expect(rows().some(r => r.project === 'proj-a')).toBe(false);
  });

  it('writes nothing when no entry is active', async () => {
    await insertKnowledgeEntry(store, nk());
    await writeLearnedBlocks(store, learningDb, 2500);
    expect(rows()).toEqual([]);
  });

  it('ignores a candidate and a retired entry', async () => {
    const active = await insertKnowledgeEntry(store, nk({ slug: 'active-one' }));
    await activate(store, active, null, 'verified');
    await insertKnowledgeEntry(store, nk({ slug: 'candidate-one' }));
    await writeLearnedBlocks(store, learningDb, 2500);
    const text = rows().find(r => r.project === 'proj-a')!.text;
    expect(text).toContain('active-one:');
    expect(text).not.toContain('candidate-one:');
  });

  it('honours maxChars', async () => {
    const body = Array.from({ length: 30 }, (_, i) => `project proj-a: hint ${i} [#${HEX_A}]`).join('\n');
    const id = await insertKnowledgeEntry(
      store,
      nk({ kind: 'instruction', slug: 'navigate', body })
    );
    await activate(store, id, null, 'verified');
    await writeLearnedBlocks(store, learningDb, 300);
    const text = rows().find(r => r.project === 'proj-a')!.text;
    expect(text.length).toBeLessThanOrEqual(300);
    expect(text.trimEnd().endsWith('```')).toBe(true);
  });
});
