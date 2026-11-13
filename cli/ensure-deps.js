/**
 * Make node_modules usable before anything opens the database. Shared by the MCP wrapper and the
 * SessionStart sync hook, because the sync hook never goes through the wrapper: a tree with
 * better-sqlite3's JS but no compiled binding made every background sync fail silently.
 *
 * All child output goes to stderr (fd 2). The MCP wrapper's stdout is the JSON-RPC transport.
 */

import { spawnSync } from 'child_process';
import { existsSync, readdirSync, rmSync } from 'fs';
import { join } from 'path';
import { repairPlan } from '../dist/deps-health.js';

/**
 * A first-run install on a plugin host uses these npm arguments. `--omit=dev` keeps the build and
 * test tools (vitest, typescript, esbuild, type packages) out of the plugin cache, because no runtime
 * file imports these tools. `test/runtime-imports.test.ts` checks that no runtime file imports a tool.
 * The optional platform packages stay, because the native modules need these packages.
 */
export const NPM_INSTALL_ARGS = Object.freeze(['install', '--omit=dev', '--no-audit', '--no-fund']);

function runNpm(pluginRoot, args) {
  const isWindows = process.platform === 'win32';
  const opts = { cwd: pluginRoot, stdio: ['ignore', 2, 2] };
  // npm.cmd needs a shell on Windows. Pass ONE command string there: args with shell:true are
  // concatenated unescaped (DEP0190). Every arg here is a constant, so the string is safe.
  const r = isWindows
    ? spawnSync(['npm.cmd', ...args].join(' '), { ...opts, shell: true })
    : spawnSync('npm', args, opts);
  if (r.error) throw r.error;
  if (r.status !== 0) {
    throw new Error(`npm ${args.join(' ')} failed with exit code ${r.status} in ${pluginRoot}`);
  }
}

/**
 * The options of each best-effort removal. The retries cover a file that Defender or a running
 * process holds for a short time.
 */
const RM_OPTIONS = Object.freeze({ recursive: true, force: true, maxRetries: 5, retryDelay: 200 });

/** The file that `onnxruntime-node` loads from the directory of the running pair. */
const BINDING_FILE = 'onnxruntime_binding.node';

/**
 * Remove one path, best effort. On a failure, the function writes one stderr line and returns false.
 * The function never throws, because an optional cleanup must not stop the plugin from starting.
 */
function removeBestEffort(path, rm) {
  try {
    rm(path, { ...RM_OPTIONS });
    return true;
  } catch (e) {
    console.error(`episodic-memory: could not remove ${path} (${e?.message ?? e}); continuing`);
    return false;
  }
}

/** The names of the directories directly under `dir`. A file is not a binding pair, so the prune keeps the file. */
function subdirs(dir) {
  return readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
}

/**
 * Remove the `onnxruntime-node` binding directories that this process never loads.
 *
 * `onnxruntime-node` ships `bin/napi-v6/<platform>/<arch>` for each supported pair. The process loads
 * only the binding file of the pair of `process.platform` and `process.arch`. The function removes
 * each pair except the running pair, then each `<platform>` directory that is empty.
 *
 * The function removes nothing when the binding file of the running pair is not on disk. A key that
 * does not match the tree, or a package that an install is still writing, would otherwise lose the
 * binding that the process loads. The removal is best effort. On the first failure, the function
 * writes one stderr line and returns. The function never throws. A concurrent call can remove a
 * directory first; the resulting ENOENT ends the call without a line.
 *
 * `npm install` and `bun install` do not restore the pruned directories while the installed
 * version satisfies the manifest. To restore the directories, delete `node_modules/onnxruntime-node`
 * and install again. The next call then prunes the directories again.
 *
 * @param nodeModules - The `node_modules` directory of the plugin root.
 * @param options - Test seams: `platform` and `arch` replace the process values, `rm` replaces `fs.rmSync`.
 */
export function pruneOptionalWeight(nodeModules, options = {}) {
  const { platform = process.platform, arch = process.arch, rm = rmSync } = options;
  const napiDir = join(nodeModules, 'onnxruntime-node', 'bin', 'napi-v6');
  try {
    if (!existsSync(join(napiDir, platform, arch, BINDING_FILE))) return;
    for (const p of subdirs(napiDir)) {
      const platformDir = join(napiDir, p);
      for (const a of subdirs(platformDir)) {
        if (p === platform && a === arch) continue;
        if (!removeBestEffort(join(platformDir, a), rm)) return;
      }
      if (p !== platform && readdirSync(platformDir).length === 0) {
        if (!removeBestEffort(platformDir, rm)) return;
      }
    }
  } catch (e) {
    // A concurrent call (the MCP wrapper and the sync hook start together) removed a directory first.
    if (e?.code === 'ENOENT') return;
    console.error(`episodic-memory: could not prune ${napiDir} (${e?.message ?? e}); continuing`);
  }
}

/**
 * Make the plugin dependencies usable. Then prune the idle binding directories.
 *
 * @param pluginRoot - The plugin root that holds `node_modules`.
 * @param options - `prune` passes test seams to `pruneOptionalWeight`.
 * @returns The repair action that the function takes: 'none', 'install' or 'rebuild'. The prune
 *   never changes the return value.
 * @throws When npm fails, or the tree is still unusable after the repair.
 */
export function ensureDeps(pluginRoot, options = {}) {
  const nodeModules = join(pluginRoot, 'node_modules');
  const plan = repairPlan(nodeModules);
  if (plan !== 'none') repair(pluginRoot, nodeModules, plan);
  pruneOptionalWeight(nodeModules, options.prune);
  return plan;
}

function repair(pluginRoot, nodeModules, plan) {
  if (plan === 'install') {
    console.error('Installing episodic-memory dependencies (first run only, 30-60 s)...');
    runNpm(pluginRoot, [...NPM_INSTALL_ARGS]);
  }
  // `npm install` does not rebuild a binding that its install scripts were skipped for, so check
  // again after an install rather than trusting its exit code.
  if (repairPlan(nodeModules) === 'rebuild') {
    console.error('Building the better-sqlite3 native binding...');
    runNpm(pluginRoot, ['rebuild', 'better-sqlite3']);
  }
  const after = repairPlan(nodeModules);
  if (after !== 'none') {
    throw new Error(`dependencies still unusable after repair (plan=${after}) in ${pluginRoot}`);
  }
}
