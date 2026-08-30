import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { DEP_SENTINELS, nodeModulesIsHealthy } from '../src/deps-health.js';
import { safeRmSync } from './test-utils.js';

describe('nodeModulesIsHealthy', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'em-deps-'));
  });

  afterEach(() => {
    safeRmSync(testDir);
  });

  it('is false when node_modules is missing or only partially populated', () => {
    expect(nodeModulesIsHealthy(path.join(testDir, 'missing'))).toBe(false);

    const nm = path.join(testDir, 'node_modules');
    fs.mkdirSync(nm, { recursive: true });
    expect(nodeModulesIsHealthy(nm)).toBe(false);

    fs.mkdirSync(path.join(nm, 'better-sqlite3', 'lib'), { recursive: true });
    fs.writeFileSync(path.join(nm, 'better-sqlite3', 'lib', 'index.js'), '', 'utf-8');
    expect(nodeModulesIsHealthy(nm)).toBe(false);
  });

  it('is true only when every sentinel exists', () => {
    const nm = path.join(testDir, 'node_modules');
    for (const rel of DEP_SENTINELS) {
      const full = path.join(nm, rel);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, '{}', 'utf-8');
    }
    expect(nodeModulesIsHealthy(nm)).toBe(true);
  });
});
