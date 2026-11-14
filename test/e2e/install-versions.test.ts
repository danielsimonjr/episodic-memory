// The embedding stack of the plugin under test must be the stack that bun.lock records, because CI tests that stack.
// Run with E2E_PLUGIN_ROOT set to an installed copy to check what `npm install --omit=dev` really installed there.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { PLUGIN_ROOT, REPO_ROOT } from './harness.js';
import { EMBEDDING_STACK_PACKAGES, readEmbeddingStack } from '../../src/embedding-stack.js';

/** The version that bun.lock resolves for a top-level package entry. */
function lockedVersion(lock: string, name: string): string {
  const escaped = name.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
  const m = lock.match(new RegExp(`^\\s*"${escaped}": \\["${escaped}@([^"]+)"`, 'm'));
  if (!m) throw new Error(`bun.lock has no top-level entry for ${name}`);
  return m[1];
}

describe('installed embedding stack', () => {
  it('equals the versions in bun.lock', () => {
    const lock = readFileSync(path.join(REPO_ROOT, 'bun.lock'), 'utf-8');
    const expected = EMBEDDING_STACK_PACKAGES.map(name => `${name}@${lockedVersion(lock, name)}`).join(' ');
    expect(readEmbeddingStack(PLUGIN_ROOT)).toBe(expected);
  });
});
