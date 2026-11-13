import { describe, it, expect } from 'vitest';
import fs from 'fs';

// The plugin runs on node:sqlite. No native SQLite addon, no install script and no vector extension remain.
const pkg = JSON.parse(fs.readFileSync('package.json', 'utf-8'));
const removed = ['better-sqlite3', 'sqlite-vec', '@types/better-sqlite3'];

describe('the package has no native SQLite dependency', () => {
  it('lists none of the removed packages', () => {
    for (const field of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']) {
      for (const name of removed) expect(pkg[field]?.[name], `${field}.${name}`).toBeUndefined();
    }
  });

  it('has no postinstall script and no install-script grant for better-sqlite3', () => {
    expect(pkg.scripts?.postinstall).toBeUndefined();
    expect(Object.keys(pkg.allowScripts ?? {}).some(k => k.startsWith('better-sqlite3'))).toBe(false);
    expect(pkg.trustedDependencies ?? []).not.toContain('better-sqlite3');
  });

  it('bundles without an external flag for the removed packages', () => {
    expect(pkg.scripts.bundle).not.toMatch(/--external:(better-sqlite3|sqlite-vec)/);
  });

  it('has a lockfile free of the removed packages', () => {
    const lock = fs.readFileSync('bun.lock', 'utf-8');
    for (const name of ['better-sqlite3', 'sqlite-vec']) expect(lock).not.toContain(`"${name}`);
  });

  it('keeps the rebuild script deleted', () => {
    expect(fs.existsSync('scripts/rebuild-native.mjs')).toBe(false);
  });
});
