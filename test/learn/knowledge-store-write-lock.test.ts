import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { openKnowledgeStore, type KnowledgeStore } from '../../src/learn/knowledge-store.js';
import { safeRmSync, suppressConsole } from '../test-utils.js';

suppressConsole();

/**
 * Every public write method of the store runs under the database write lock (`write`),
 * so a second process cannot slip a write in between two statements.
 */
describe('KnowledgeStore write lock', () => {
  let configDir: string;
  let saved: string | undefined;
  let store: KnowledgeStore;
  let writeSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    saved = process.env.EPISODIC_MEMORY_CONFIG_DIR;
    configDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'em-ks-lock-')));
    process.env.EPISODIC_MEMORY_CONFIG_DIR = configDir;
    store = openKnowledgeStore();
    const original = (store as unknown as { write: <T>(fn: () => T) => T }).write.bind(store);
    writeSpy = vi.fn(original);
    (store as unknown as { write: unknown }).write = writeSpy;
  });

  afterEach(() => {
    try {
      store.close();
    } finally {
      if (saved === undefined) delete process.env.EPISODIC_MEMORY_CONFIG_DIR;
      else process.env.EPISODIC_MEMORY_CONFIG_DIR = saved;
      safeRmSync(configDir);
    }
  });

  it('addHeuristic writes under the lock', async () => {
    await store.addHeuristic({ condition: 'c', action: 'a' });
    expect(writeSpy).toHaveBeenCalled();
  });

  it('putProcedure writes under the lock', async () => {
    await store.putProcedure({
      id: 'proc-1',
      name: 'p',
      description: 'd',
      steps: [{ action: 'do' }],
      triggers: ['t'],
    });
    expect(writeSpy).toHaveBeenCalled();
  });

  it('proposeDecision writes under the lock', async () => {
    await store.proposeDecision({ context: 'c', decision: 'd', alternatives: [], consequences: [] });
    expect(writeSpy).toHaveBeenCalled();
  });

  it('recordFailure writes under the lock', async () => {
    await store.recordFailure({
      context: 'c',
      attempted: 'a',
      failure_mode: 'f',
      root_cause: 'r',
      applicability_hint: 'h',
    });
    expect(writeSpy).toHaveBeenCalled();
  });

  it('recordReflectionRecord writes under the lock', async () => {
    await store.recordReflectionRecord({
      scope: 'project',
      project: 'p',
      entryId: 'e',
      summary: 's',
      evidence: [],
      confidence: 'medium',
    });
    expect(writeSpy).toHaveBeenCalled();
  });

  it('supersede writes under the lock', async () => {
    await expect(store.supersede('missing-old', 'missing-new')).rejects.toThrow(/not found/);
    expect(writeSpy).toHaveBeenCalled();
  });
});
