import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync, utimesSync } from 'fs';
import { tmpdir } from 'os';
import { join, dirname } from 'path';
import { depsRepairLogEntry, ensureDeps, NPM_INSTALL_ARGS } from '../cli/ensure-deps.js';
import { DEP_SENTINELS, NATIVE_ADDON, ONNX_BINDING, onnxBindingPath } from '../src/deps-health.js';

// The repair of `ensureDeps` with npm replaced by a fake. A fake install writes only the files of a
// package that is absent from the tree, because `npm install` does not restore one missing file
// inside an installed package.

/** A pair that is not the running pair. */
const SIBLING = process.platform === 'linux' ? { platform: 'win32', arch: 'x64' } : { platform: 'linux', arch: 'x64' };

const LOCK = '.episodic-memory-repair.lock';
const MARKER = '.episodic-memory-onnx-repair-failed';
const BACKUP = '.onnxruntime-node.repair-backup';

const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function touch(path: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, 'x');
}

/**
 * A plugin root whose node_modules holds every sentinel except the ones in `skip`. The
 * `bin/napi-v6` directory of `onnxruntime-node` always exists, as in an installed package.
 */
function pluginRoot(skip: string[] = []): string {
  const root = mkdtempSync(join(tmpdir(), 'em-repair-'));
  roots.push(root);
  for (const rel of DEP_SENTINELS) if (!skip.includes(rel)) touch(join(root, 'node_modules', rel));
  mkdirSync(join(root, 'node_modules', 'onnxruntime-node', 'bin', 'napi-v6'), { recursive: true });
  return root;
}

const onnxDir = (root: string) => join(root, 'node_modules', 'onnxruntime-node');
const stale = (root: string) => join(onnxDir(root), 'stale.txt');

/**
 * A fake npm. `install` writes `onnxruntime-node` (with the running pair and one sibling pair when
 * `restoresBinding` is true) when the package directory is absent, and writes `onnxruntime-common`
 * when it is absent. `rebuild better-sqlite3` writes the compiled binding when `rebuilds` is true.
 * `fails` makes every call throw. Each call is recorded with the state of the package directory.
 */
function fakeNpm(options: { restoresBinding?: boolean; rebuilds?: boolean; fails?: boolean } = {}) {
  const { restoresBinding = true, rebuilds = true, fails = false } = options;
  const calls: { cwd: string; args: string[]; onnxPresent: boolean }[] = [];
  const npm = (cwd: string, args: string[]) => {
    const nm = join(cwd, 'node_modules');
    calls.push({ cwd, args: [...args], onnxPresent: existsSync(join(nm, 'onnxruntime-node')) });
    if (fails) throw new Error('npm install --omit=dev --no-audit --no-fund failed with exit code 1');
    if (args[0] === 'rebuild') {
      if (rebuilds) touch(join(nm, NATIVE_ADDON));
      return;
    }
    if (!existsSync(join(nm, 'onnxruntime-node'))) {
      touch(join(nm, 'onnxruntime-node', 'package.json'));
      mkdirSync(join(nm, 'onnxruntime-node', 'bin', 'napi-v6'), { recursive: true });
      if (restoresBinding) {
        touch(join(nm, ONNX_BINDING));
        touch(join(nm, onnxBindingPath(SIBLING.platform, SIBLING.arch)));
      }
    }
    const common = join(nm, 'onnxruntime-common', 'package.json');
    if (!existsSync(common)) touch(common);
  };
  return { npm, calls };
}

/** Every stderr line that `fn` writes, with `console.error` silenced. */
function stderrOf(fn: () => unknown): { result: unknown; lines: string[] } {
  const err = vi.spyOn(console, 'error').mockImplementation(() => {});
  const result = fn();
  const lines = err.mock.calls.map((args) => args.map(String).join(' '));
  err.mockRestore();
  return { result, lines };
}

describe('ensureDeps repair of the onnxruntime-node binding', () => {
  it('moves onnxruntime-node aside, installs again, removes the backup, then prunes the idle pairs', () => {
    const root = pluginRoot([ONNX_BINDING]);
    touch(stale(root));
    const { npm, calls } = fakeNpm();
    const { result, lines } = stderrOf(() => ensureDeps(root, { npm }));
    expect(result).toBe('reinstall-onnx');
    expect(calls).toEqual([{ cwd: root, args: [...NPM_INSTALL_ARGS], onnxPresent: false }]);
    expect(existsSync(stale(root))).toBe(false);
    expect(existsSync(join(root, 'node_modules', ONNX_BINDING))).toBe(true);
    expect(existsSync(join(root, 'node_modules', onnxBindingPath(SIBLING.platform, SIBLING.arch)))).toBe(false);
    expect(existsSync(join(root, BACKUP))).toBe(false);
    expect(existsSync(join(root, MARKER))).toBe(false);
    expect(existsSync(join(root, LOCK))).toBe(false);
    expect(lines.some((line) => line.includes('onnxruntime-node'))).toBe(true);
  });

  it('repairs nothing on a host that the package ships no binding for', () => {
    const root = pluginRoot([ONNX_BINDING]);
    touch(join(root, 'node_modules', onnxBindingPath(SIBLING.platform, SIBLING.arch)));
    const { npm, calls } = fakeNpm();
    expect(ensureDeps(root, { npm })).toBe('none');
    expect(calls).toEqual([]);
    // The prune removes nothing when the binding of the running pair is absent.
    expect(existsSync(join(root, 'node_modules', onnxBindingPath(SIBLING.platform, SIBLING.arch)))).toBe(true);
  });

  for (const [name, npmOptions] of [
    ['the install gives no binding', { restoresBinding: false }],
    ['npm fails', { fails: true }],
  ] as const) {
    it(`puts the old directory back and returns onnx-missing when ${name}`, () => {
      const root = pluginRoot([ONNX_BINDING]);
      touch(stale(root));
      const { npm, calls } = fakeNpm(npmOptions);
      const { result, lines } = stderrOf(() => ensureDeps(root, { npm }));
      expect(result).toBe('onnx-missing');
      expect(calls).toHaveLength(1);
      expect(existsSync(stale(root))).toBe(true);
      expect(existsSync(join(onnxDir(root), 'package.json'))).toBe(true);
      expect(existsSync(join(root, BACKUP))).toBe(false);
      expect(existsSync(join(root, MARKER))).toBe(true);
      expect(existsSync(join(root, LOCK))).toBe(false);
      expect(lines.some((line) => line.includes(onnxDir(root)))).toBe(true);
    });
  }

  it('skips the reinstall with one stderr line when the package directory cannot be moved aside', () => {
    const root = pluginRoot([ONNX_BINDING]);
    touch(stale(root));
    const { npm, calls } = fakeNpm();
    const rename = () => {
      throw Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' });
    };
    const { result, lines } = stderrOf(() => ensureDeps(root, { npm, rename }));
    expect(result).toBe('onnx-missing');
    expect(calls).toEqual([]);
    expect(existsSync(stale(root))).toBe(true);
    expect(existsSync(join(root, MARKER))).toBe(false);
    expect(lines.filter((line) => line.includes(onnxDir(root)))).toHaveLength(1);
  });

  it('skips the reinstall while the failure marker is newer than onnxRetryMs, and retries after it', () => {
    const root = pluginRoot([ONNX_BINDING]);
    const failing = fakeNpm({ restoresBinding: false });
    stderrOf(() => ensureDeps(root, { npm: failing.npm }));
    expect(existsSync(join(root, MARKER))).toBe(true);

    const good = fakeNpm();
    const skipped = stderrOf(() => ensureDeps(root, { npm: good.npm }));
    expect(skipped.result).toBe('onnx-missing');
    expect(good.calls).toEqual([]);
    expect(skipped.lines.some((line) => line.includes(join(root, MARKER)))).toBe(true);

    const old = (Date.now() - 2 * 60 * 60 * 1000) / 1000;
    utimesSync(join(root, MARKER), old, old);
    const retried = stderrOf(() => ensureDeps(root, { npm: good.npm, onnxRetryMs: 60 * 60 * 1000 }));
    expect(retried.result).toBe('reinstall-onnx');
    expect(good.calls).toHaveLength(1);
    expect(existsSync(join(root, MARKER))).toBe(false);
  });

  it('puts the old directory back and does not throw when the failure marker cannot be written', () => {
    const root = pluginRoot([ONNX_BINDING]);
    touch(stale(root));
    // A directory at the marker path makes the write fail with EISDIR. Its old time lets the attempt run.
    mkdirSync(join(root, MARKER));
    const old = (Date.now() - 2 * 60 * 60 * 1000) / 1000;
    utimesSync(join(root, MARKER), old, old);
    const { npm } = fakeNpm({ restoresBinding: false });
    const { result, lines } = stderrOf(() => ensureDeps(root, { npm, onnxRetryMs: 60 * 60 * 1000 }));
    expect(result).toBe('onnx-missing');
    expect(existsSync(stale(root))).toBe(true);
    expect(existsSync(join(root, BACKUP))).toBe(false);
    expect(lines.some((line) => line.includes(join(root, MARKER)))).toBe(true);
  });

  it('keeps the backup and writes one stderr line when the new directory cannot be removed', () => {
    const root = pluginRoot([ONNX_BINDING]);
    touch(stale(root));
    const { npm } = fakeNpm({ restoresBinding: false });
    const rm = (path: string, opts: object) => {
      if (path === onnxDir(root)) throw Object.assign(new Error('EBUSY: resource busy'), { code: 'EBUSY' });
      rmSync(path, opts);
    };
    const { result, lines } = stderrOf(() => ensureDeps(root, { npm, rm }));
    expect(result).toBe('onnx-missing');
    expect(existsSync(join(root, BACKUP, 'stale.txt'))).toBe(true);
    expect(lines.filter((line) => line.includes(onnxDir(root)) && line.includes('EBUSY'))).toHaveLength(1);
  });

  it('removes a backup that an earlier run left beside an installed package, then reinstalls', () => {
    const root = pluginRoot([ONNX_BINDING]);
    touch(join(root, BACKUP, 'left-over.txt'));
    const { npm, calls } = fakeNpm();
    const { result, lines } = stderrOf(() => ensureDeps(root, { npm }));
    expect(result).toBe('reinstall-onnx');
    expect(lines.filter((line) => line.includes('could not'))).toEqual([]);
    expect(calls).toHaveLength(1);
    expect(existsSync(join(root, BACKUP))).toBe(false);
    expect(existsSync(join(root, 'node_modules', ONNX_BINDING))).toBe(true);
  });

  it('moves the backup of a run that stopped during the install back, before any npm call', () => {
    const root = pluginRoot();
    // A run moved the package aside and was killed before npm finished.
    mkdirSync(join(root, BACKUP), { recursive: true });
    rmSync(onnxDir(root), { recursive: true, force: true });
    for (const rel of DEP_SENTINELS.filter((r) => r.startsWith('onnxruntime-node/'))) {
      touch(join(root, BACKUP, rel.slice('onnxruntime-node/'.length)));
    }
    const { npm, calls } = fakeNpm();
    const { result, lines } = stderrOf(() => ensureDeps(root, { npm }));
    expect(result).toBe('install');
    expect(calls).toEqual([]);
    expect(existsSync(join(root, 'node_modules', ONNX_BINDING))).toBe(true);
    expect(existsSync(join(root, BACKUP))).toBe(false);
    expect(lines.some((line) => line.includes(join(root, BACKUP)))).toBe(true);
  });

  it('installs a missing onnxruntime-node with one npm call and no move line when no backup exists', () => {
    const root = pluginRoot();
    rmSync(onnxDir(root), { recursive: true, force: true });
    const { npm, calls } = fakeNpm();
    const { result, lines } = stderrOf(() => ensureDeps(root, { npm }));
    expect(result).toBe('install');
    expect(calls.map((c) => c.args[0])).toEqual(['install']);
    expect(lines.filter((line) => line.includes('could not') || line.includes(BACKUP))).toEqual([]);
    expect(existsSync(join(root, 'node_modules', ONNX_BINDING))).toBe(true);
  });

  it('installs, then reinstalls onnxruntime-node, then rebuilds better-sqlite3 for a tree that needs all three', () => {
    const root = pluginRoot([ONNX_BINDING, NATIVE_ADDON, 'onnxruntime-common/package.json']);
    const { npm, calls } = fakeNpm();
    expect(stderrOf(() => ensureDeps(root, { npm })).result).toBe('install');
    expect(calls.map((c) => [c.args[0], c.onnxPresent])).toEqual([
      ['install', true],
      ['install', false],
      ['rebuild', true],
    ]);
    expect(calls[2].args).toEqual(['rebuild', 'better-sqlite3']);
  });

  it('still rebuilds better-sqlite3 when the onnx reinstall fails', () => {
    const root = pluginRoot([ONNX_BINDING, NATIVE_ADDON]);
    const { npm, calls } = fakeNpm({ restoresBinding: false });
    expect(stderrOf(() => ensureDeps(root, { npm })).result).toBe('onnx-missing');
    expect(calls.map((c) => c.args[0])).toEqual(['install', 'rebuild']);
    expect(existsSync(join(root, 'node_modules', NATIVE_ADDON))).toBe(true);
  });

  it('throws when the onnx reinstall fails and better-sqlite3 also stays unusable', () => {
    const root = pluginRoot([ONNX_BINDING, NATIVE_ADDON]);
    const { npm } = fakeNpm({ restoresBinding: false, rebuilds: false });
    expect(() => stderrOf(() => ensureDeps(root, { npm }))).toThrow(/plan=reinstall-onnx/);
  });

  it('throws when better-sqlite3 stays unusable after the repair', () => {
    const root = pluginRoot([NATIVE_ADDON]);
    const { npm } = fakeNpm({ rebuilds: false });
    expect(() => stderrOf(() => ensureDeps(root, { npm }))).toThrow(/plan=rebuild/);
    expect(existsSync(join(root, LOCK))).toBe(false);
  });
});

/**
 * A sleep seam that runs `onFirst` at the first call and throws after 1000 calls. The wait loop is
 * synchronous, so a loop that never ends would block the test runner; the throw ends it with a failure.
 */
function boundedSleep(onFirst: () => void = () => {}) {
  let n = 0;
  return vi.fn(() => {
    n += 1;
    if (n === 1) onFirst();
    if (n > 1000) throw new Error('the wait loop did not end');
  });
}

describe('ensureDeps repair lock', () => {
  it('waits while a live process holds the lock, and repairs nothing when that process repaired the tree', () => {
    const root = pluginRoot([ONNX_BINDING]);
    writeFileSync(join(root, LOCK), String(process.pid));
    const { npm, calls } = fakeNpm();
    const sleep = vi.fn(() => {
      // The holder finishes: the binding is back and the lock is released.
      touch(join(root, 'node_modules', ONNX_BINDING));
      rmSync(join(root, LOCK));
    });
    const { result } = stderrOf(() => ensureDeps(root, { npm, sleep }));
    expect(result).toBe('reinstall-onnx');
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(calls).toEqual([]);
  });

  it('stops waiting as soon as the holder has repaired the tree, while the holder still holds the lock', () => {
    const root = pluginRoot([ONNX_BINDING]);
    writeFileSync(join(root, LOCK), String(process.pid));
    const { npm, calls } = fakeNpm();
    const sleep = boundedSleep(() => touch(join(root, 'node_modules', ONNX_BINDING)));
    const { result, lines } = stderrOf(() => ensureDeps(root, { npm, sleep, waitMs: 1000 }));
    expect(result).toBe('reinstall-onnx');
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(calls).toEqual([]);
    expect(lines.filter((line) => line.includes(join(root, LOCK)))).toEqual([]);
  });

  it('repairs after the holder releases the lock without a repair', () => {
    const root = pluginRoot([ONNX_BINDING]);
    writeFileSync(join(root, LOCK), String(process.pid));
    const { npm, calls } = fakeNpm();
    const sleep = vi.fn(() => rmSync(join(root, LOCK)));
    expect(stderrOf(() => ensureDeps(root, { npm, sleep })).result).toBe('reinstall-onnx');
    expect(calls).toHaveLength(1);
  });

  it('repairs without the lock, with one stderr line, when the lock cannot be created', () => {
    const root = pluginRoot([ONNX_BINDING]);
    const { npm, calls } = fakeNpm();
    const acquire = () => {
      throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
    };
    const { result, lines } = stderrOf(() => ensureDeps(root, { npm, acquire, sleep: boundedSleep() }));
    expect(result).toBe('reinstall-onnx');
    expect(calls).toHaveLength(1);
    expect(lines.filter((line) => line.includes(join(root, LOCK)) && line.includes('EACCES'))).toHaveLength(1);
  });

  it('steals the lock of a dead process and repairs', () => {
    const root = pluginRoot([ONNX_BINDING]);
    writeFileSync(join(root, LOCK), '2147480000');
    const { npm, calls } = fakeNpm();
    expect(stderrOf(() => ensureDeps(root, { npm, sleep: boundedSleep() })).result).toBe('reinstall-onnx');
    expect(calls).toHaveLength(1);
    expect(existsSync(join(root, LOCK))).toBe(false);
  });

  it('stops waiting after waitMs, writes one stderr line that names the lock, and runs no npm', () => {
    const root = pluginRoot([ONNX_BINDING]);
    writeFileSync(join(root, LOCK), String(process.pid));
    const { npm, calls } = fakeNpm();
    const { result, lines } = stderrOf(() => ensureDeps(root, { npm, sleep: boundedSleep(), waitMs: 0 }));
    expect(result).toBe('onnx-missing');
    expect(calls).toEqual([]);
    expect(lines.filter((line) => line.includes(join(root, LOCK)))).toHaveLength(1);
    expect(existsSync(join(root, LOCK))).toBe(true);
  });
});

describe('depsRepairLogEntry', () => {
  it('gives an error entry for onnx-missing, an info entry for a repair, and none for a healthy tree', () => {
    expect(depsRepairLogEntry('onnx-missing')).toEqual([
      'error',
      'SessionStart deps repair left the onnxruntime-node binding missing; vector search is unavailable',
    ]);
    for (const action of ['install', 'reinstall-onnx', 'rebuild']) {
      expect(depsRepairLogEntry(action)).toEqual(['info', `SessionStart deps repaired: ${action}`]);
    }
    expect(depsRepairLogEntry('none')).toBeNull();
  });
});
