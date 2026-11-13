import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readdirSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join, dirname } from 'path';
import { ensureDeps, pruneOptionalWeight } from '../cli/ensure-deps.js';

// onnxruntime-node ships one binding directory for each platform and architecture pair. The process
// loads only `bin/napi-v6/<process.platform>/<process.arch>`. The process does not load the other pairs.
const RUNNING = { platform: process.platform, arch: process.arch };
const IDLE = [
  { platform: 'linux', arch: 'arm64' },
  { platform: 'darwin', arch: 'arm64' },
  { platform: 'freebsd', arch: 'x64' },
].filter((p) => p.platform !== RUNNING.platform || p.arch !== RUNNING.arch);

const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function touch(path: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, 'x');
}

/** Make a plugin root whose node_modules holds onnxruntime-node with the given binding pairs. */
function fakePluginRoot(pairs: { platform: string; arch: string }[]): string {
  const root = mkdtempSync(join(tmpdir(), 'em-prune-'));
  roots.push(root);
  for (const p of pairs) {
    touch(join(root, 'node_modules', 'onnxruntime-node', 'bin', 'napi-v6', p.platform, p.arch, 'onnxruntime_binding.node'));
  }
  return root;
}

/** Add the files that `nodeModulesIsHealthy` needs, so `repairPlan` answers 'none'. */
function makeHealthy(root: string): void {
  const nm = join(root, 'node_modules');
  touch(join(nm, 'better-sqlite3', 'lib', 'index.js'));
  touch(join(nm, '@huggingface', 'transformers', 'package.json'));
  touch(join(nm, 'onnxruntime-common', 'package.json'));
  touch(join(nm, 'better-sqlite3', 'prebuilds', `${process.platform}-${process.arch}.node`));
}

function napiDir(root: string): string {
  return join(root, 'node_modules', 'onnxruntime-node', 'bin', 'napi-v6');
}

/** Every `<platform>/<arch>` pair left under napi-v6, sorted. */
function pairsLeft(root: string): string[] {
  const dir = napiDir(root);
  const dirs = (d: string) => readdirSync(d, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
  return dirs(dir)
    .flatMap((platform) => dirs(join(dir, platform)).map((arch) => `${platform}/${arch}`))
    .sort();
}

describe('pruneOptionalWeight', () => {
  it('keeps only the running platform and architecture pair', () => {
    const root = fakePluginRoot([RUNNING, ...IDLE]);
    pruneOptionalWeight(join(root, 'node_modules'));
    expect(pairsLeft(root)).toEqual([`${RUNNING.platform}/${RUNNING.arch}`]);
    // The prune also removes a platform directory that holds no pair.
    expect(readdirSync(napiDir(root))).toEqual([RUNNING.platform]);
  });

  it('removes only the idle architecture under the running platform', () => {
    const otherArch = RUNNING.arch === 'x64' ? 'arm64' : 'x64';
    const root = fakePluginRoot([RUNNING, { platform: RUNNING.platform, arch: otherArch }]);
    pruneOptionalWeight(join(root, 'node_modules'));
    expect(pairsLeft(root)).toEqual([`${RUNNING.platform}/${RUNNING.arch}`]);
  });

  it('changes nothing on a second call', () => {
    const root = fakePluginRoot([RUNNING, ...IDLE]);
    const nm = join(root, 'node_modules');
    pruneOptionalWeight(nm);
    const rm = vi.fn();
    pruneOptionalWeight(nm, { rm });
    expect(rm).not.toHaveBeenCalled();
    expect(pairsLeft(root)).toEqual([`${RUNNING.platform}/${RUNNING.arch}`]);
  });

  // A wrong key would remove the binding that the process loads. When the running pair is not on
  // disk, the key does not match this tree, so the function removes nothing.
  it('removes nothing when the running pair is absent', () => {
    const root = fakePluginRoot(IDLE);
    const rm = vi.fn();
    pruneOptionalWeight(join(root, 'node_modules'), { rm });
    expect(rm).not.toHaveBeenCalled();
    expect(pairsLeft(root)).toHaveLength(IDLE.length);
  });

  it('leaves a file under napi-v6 in place and writes nothing to stderr', () => {
    const root = fakePluginRoot([RUNNING, ...IDLE]);
    touch(join(napiDir(root), 'README.txt'));
    touch(join(napiDir(root), RUNNING.platform, 'notes.txt'));
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    pruneOptionalWeight(join(root, 'node_modules'));
    expect(err).not.toHaveBeenCalled();
    expect(existsSync(join(napiDir(root), 'README.txt'))).toBe(true);
    expect(existsSync(join(napiDir(root), RUNNING.platform, 'notes.txt'))).toBe(true);
    expect(pairsLeft(root)).toEqual([`${RUNNING.platform}/${RUNNING.arch}`]);
  });

  // An install that is still writing the package can leave the running directory without its file.
  it('removes nothing when the running directory holds no binding file', () => {
    const root = fakePluginRoot(IDLE);
    mkdirSync(join(napiDir(root), RUNNING.platform, RUNNING.arch), { recursive: true });
    const rm = vi.fn();
    pruneOptionalWeight(join(root, 'node_modules'), { rm });
    expect(rm).not.toHaveBeenCalled();
  });

  // The MCP wrapper and the sync hook can prune the same tree at the same time.
  it('writes nothing to stderr when a concurrent call removed a directory first', () => {
    // No Node build runs on the platform name `sunos` with these arches, so the pairs are idle everywhere.
    const root = fakePluginRoot([RUNNING, { platform: 'sunos', arch: 'arm64' }, { platform: 'sunos', arch: 'x64' }]);
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    // The other call removes the whole platform directory while this call works inside it.
    const rm = (path: string, opts: Parameters<typeof rmSync>[1]) => rmSync(dirname(path), opts);
    pruneOptionalWeight(join(root, 'node_modules'), { rm });
    expect(err).not.toHaveBeenCalled();
    expect(pairsLeft(root)).toEqual([`${RUNNING.platform}/${RUNNING.arch}`]);
  });

  it('does nothing when onnxruntime-node is not installed', () => {
    const root = mkdtempSync(join(tmpdir(), 'em-prune-'));
    roots.push(root);
    const rm = vi.fn();
    expect(() => pruneOptionalWeight(join(root, 'node_modules'), { rm })).not.toThrow();
    expect(rm).not.toHaveBeenCalled();
  });

  it('removes with retries, so a file that a scanner holds for a moment does not fail the removal', () => {
    const root = fakePluginRoot([RUNNING, IDLE[0]]);
    const calls: unknown[][] = [];
    pruneOptionalWeight(join(root, 'node_modules'), {
      rm: (...args: unknown[]) => {
        calls.push(args);
        rmSync(...(args as Parameters<typeof rmSync>));
      },
    });
    expect(calls[0][0]).toBe(join(napiDir(root), IDLE[0].platform, IDLE[0].arch));
    expect(calls[0][1]).toEqual({ recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  });

  it('writes one stderr line and stops when a removal fails', () => {
    const root = fakePluginRoot([RUNNING, ...IDLE]);
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const rm = vi.fn(() => {
      throw Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' });
    });
    expect(() => pruneOptionalWeight(join(root, 'node_modules'), { rm })).not.toThrow();
    expect(rm).toHaveBeenCalledTimes(1);
    expect(err).toHaveBeenCalledTimes(1);
    expect(String(err.mock.calls[0][0])).toMatch(/EBUSY/);
  });
});

describe('ensureDeps prune', () => {
  it('prunes a healthy tree and returns none', () => {
    const root = fakePluginRoot([RUNNING, ...IDLE]);
    makeHealthy(root);
    expect(ensureDeps(root)).toBe('none');
    expect(pairsLeft(root)).toEqual([`${RUNNING.platform}/${RUNNING.arch}`]);
  });

  it('returns normally with exactly one stderr line when the target is locked', () => {
    const root = fakePluginRoot([RUNNING, ...IDLE]);
    makeHealthy(root);
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const rm = () => {
      throw Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' });
    };
    expect(ensureDeps(root, { prune: { rm } })).toBe('none');
    expect(err).toHaveBeenCalledTimes(1);
    // The healthy tree stays healthy: the binding that the process loads is still on disk.
    expect(existsSync(join(napiDir(root), RUNNING.platform, RUNNING.arch))).toBe(true);
  });
});
