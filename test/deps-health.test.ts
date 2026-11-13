import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import {
  DEP_SENTINELS,
  JS_SENTINELS,
  NATIVE_ADDON,
  ONNX_BINDING,
  nodeModulesIsHealthy,
  onnxBindingPath,
  onnxBindingState,
  repairPlan,
} from '../src/deps-health.js';
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

  // Every JS sentinel is load-bearing: a package missing from this tree is a package the MCP
  // server or the `learn` path will fail to import, and the repair path is the only thing that
  // fixes a plugin-cache install. Iterate the list rather than naming each entry, so a new
  // sentinel is covered by construction and a removed one fails here.
  it('is false when any single JS sentinel is missing', () => {
    for (const missing of JS_SENTINELS) {
      const nm = path.join(testDir, `nm-${missing.replace(/[^a-z0-9]+/gi, '-')}`);
      for (const rel of DEP_SENTINELS) {
        if (rel === missing) continue;
        const full = path.join(nm, rel);
        fs.mkdirSync(path.dirname(full), { recursive: true });
        fs.writeFileSync(full, '{}', 'utf-8');
      }
      expect(nodeModulesIsHealthy(nm), `missing ${missing}`).toBe(false);
      expect(repairPlan(nm), `missing ${missing}`).toBe('install');
    }
  });

  it('lists only packages this plugin itself depends on', () => {
    for (const rel of JS_SENTINELS) expect(rel.startsWith('@danielsimonjr/')).toBe(false);
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

// onnxruntime-node loads `bin/napi-v6/<platform>/<arch>/onnxruntime_binding.node` and nothing else.
// `npm install` does not restore one missing file inside an installed package, so a lost binding
// needs the package directory deleted first. A pair the package never shipped (darwin/x64 in 1.24.3)
// cannot be repaired, and a repair there would reinstall on every start and then stop the server.
describe('onnxBindingState', () => {
  let testDir: string;
  beforeEach(() => { testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'em-onnx-')); });
  afterEach(() => { safeRmSync(testDir); });

  const write = (nm: string, rel: string) => {
    const full = path.join(nm, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, '{}', 'utf-8');
  };
  const populate = (nm: string, skip: string[] = []) => {
    for (const rel of DEP_SENTINELS) if (!skip.includes(rel)) write(nm, rel);
  };
  /** A pair that is not the running pair. */
  const SIBLING = process.platform === 'linux' ? { platform: 'win32', arch: 'x64' } : { platform: 'linux', arch: 'x64' };

  it('names the binding file of the running pair as a sentinel', () => {
    expect(ONNX_BINDING).toBe(`onnxruntime-node/bin/napi-v6/${process.platform}/${process.arch}/onnxruntime_binding.node`);
    expect(onnxBindingPath('darwin', 'x64')).toBe('onnxruntime-node/bin/napi-v6/darwin/x64/onnxruntime_binding.node');
    expect(DEP_SENTINELS).toContain(ONNX_BINDING);
    expect(JS_SENTINELS).toContain('onnxruntime-node/package.json');
  });

  it('is "present" and the plan is "none" when the binding of the running pair exists', () => {
    const nm = path.join(testDir, 'node_modules');
    populate(nm);
    expect(onnxBindingState(nm)).toBe('present');
    expect(repairPlan(nm)).toBe('none');
  });

  it('is "unshipped" when the package has no bin/napi-v6 directory (a layout that the check does not know)', () => {
    const nm = path.join(testDir, 'node_modules');
    populate(nm, [ONNX_BINDING]);
    expect(onnxBindingState(nm)).toBe('unshipped');
    expect(repairPlan(nm)).toBe('none');
  });

  it('is "missing" and the plan is "reinstall-onnx" when no binding pair is on disk', () => {
    const nm = path.join(testDir, 'node_modules');
    populate(nm, [ONNX_BINDING]);
    fs.mkdirSync(path.join(nm, 'onnxruntime-node', 'bin', 'napi-v6'), { recursive: true });
    expect(onnxBindingState(nm)).toBe('missing');
    expect(nodeModulesIsHealthy(nm)).toBe(false);
    expect(repairPlan(nm)).toBe('reinstall-onnx');
  });

  it('is "missing" when the directory of the running pair exists without its binding file', () => {
    const nm = path.join(testDir, 'node_modules');
    populate(nm, [ONNX_BINDING]);
    fs.mkdirSync(path.dirname(path.join(nm, ONNX_BINDING)), { recursive: true });
    write(nm, onnxBindingPath(SIBLING.platform, SIBLING.arch));
    expect(onnxBindingState(nm)).toBe('missing');
    expect(repairPlan(nm)).toBe('reinstall-onnx');
  });

  it('is "unshipped" and the plan is "none" when only the pairs of other hosts are on disk', () => {
    const nm = path.join(testDir, 'node_modules');
    populate(nm, [ONNX_BINDING]);
    write(nm, onnxBindingPath(SIBLING.platform, SIBLING.arch));
    expect(onnxBindingState(nm)).toBe('unshipped');
    expect(nodeModulesIsHealthy(nm)).toBe(true);
    expect(repairPlan(nm)).toBe('none');
  });

  it('is "missing" when the directories of other pairs hold no binding file', () => {
    const nm = path.join(testDir, 'node_modules');
    populate(nm, [ONNX_BINDING]);
    fs.mkdirSync(path.dirname(path.join(nm, onnxBindingPath(SIBLING.platform, SIBLING.arch))), { recursive: true });
    expect(onnxBindingState(nm)).toBe('missing');
  });

  it('reads the pair from its arguments', () => {
    const nm = path.join(testDir, 'node_modules');
    populate(nm);
    expect(onnxBindingState(nm, 'darwin', 'x64')).toBe(process.platform === 'darwin' && process.arch === 'x64' ? 'present' : 'unshipped');
  });

  it('installs before it reinstalls onnxruntime-node, and reinstalls before it rebuilds better-sqlite3', () => {
    const a = path.join(testDir, 'a');
    populate(a, [ONNX_BINDING, 'onnxruntime-common/package.json']);
    expect(repairPlan(a)).toBe('install');
    const b = path.join(testDir, 'b');
    populate(b, [ONNX_BINDING, NATIVE_ADDON]);
    fs.mkdirSync(path.join(b, 'onnxruntime-node', 'bin', 'napi-v6'), { recursive: true });
    expect(repairPlan(b)).toBe('reinstall-onnx');
  });
});
