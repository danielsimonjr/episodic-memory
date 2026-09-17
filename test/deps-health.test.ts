import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { DEP_SENTINELS, NATIVE_ADDON, nodeModulesIsHealthy, repairPlan } from '../src/deps-health.js';
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

// 2026-09-17: 1.5.2, 1.5.3, 1.5.4 and 1.5.6 all deployed with better-sqlite3's JS present and its
// compiled better_sqlite3.node ABSENT, because the plugin installer skips install scripts. The old
// sentinel (lib/index.js) passed, so nothing ever built the addon. A present-JS/absent-addon tree
// needs `npm rebuild better-sqlite3`, not `npm install` (install sees the package and does nothing).
describe('repairPlan', () => {
  let testDir: string;
  beforeEach(() => { testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'em-plan-')); });
  afterEach(() => { safeRmSync(testDir); });

  const populate = (nm: string, skip: string[] = []) => {
    for (const rel of DEP_SENTINELS) {
      if (skip.includes(rel)) continue;
      const full = path.join(nm, rel);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, '{}', 'utf-8');
    }
  };

  it('treats the compiled addon as a sentinel', () => {
    expect(DEP_SENTINELS).toContain(NATIVE_ADDON);
  });

  it('is "none" when every sentinel including the addon exists', () => {
    const nm = path.join(testDir, 'node_modules');
    populate(nm);
    expect(repairPlan(nm)).toBe('none');
  });

  it('is "rebuild" when only the compiled addon is missing (the deployed defect)', () => {
    const nm = path.join(testDir, 'node_modules');
    populate(nm, [NATIVE_ADDON]);
    expect(nodeModulesIsHealthy(nm)).toBe(false);
    expect(repairPlan(nm)).toBe('rebuild');
  });

  it('is "install" when node_modules is missing or a JS sentinel is missing', () => {
    expect(repairPlan(path.join(testDir, 'nope'))).toBe('install');
    const nm = path.join(testDir, 'node_modules');
    populate(nm, ['onnxruntime-common/package.json']);
    expect(repairPlan(nm)).toBe('install');
  });
});
