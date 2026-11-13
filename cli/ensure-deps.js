/**
 * Make node_modules usable before anything opens the database. Shared by the MCP wrapper and the
 * SessionStart sync hook, because the sync hook never goes through the wrapper.
 *
 * All child output goes to stderr (fd 2). The MCP wrapper's stdout is the JSON-RPC transport.
 */

import { spawnSync } from 'child_process';
import { existsSync, readdirSync, rmSync, statSync, writeFileSync } from 'fs';
import { join } from 'path';
import { ONNX_BINDING, onnxBindingState, repairPlan } from '../dist/deps-health.js';
import { acquireLock, releaseLock } from '../dist/lockfile.js';
import { renameWithRetry, sleepSync } from '../dist/fs-retry.js';
import { CLAUDE_BIN_ENV, ClaudeBinError, claudeExecutableOption } from '../dist/claude-bin.js';

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
 * The lock file in the plugin root. The MCP wrapper and the sync hook start together, and both call
 * `ensureDeps`. The lock lets one process repair the tree while the other process waits.
 */
const REPAIR_LOCK = '.episodic-memory-repair.lock';

/** The time that a process waits for the repair lock of another live process. */
const REPAIR_WAIT_MS = 5 * 60 * 1000;

/** The wait between two attempts to take the repair lock. */
const REPAIR_POLL_MS = 500;

/**
 * The place of `node_modules/onnxruntime-node` during a reinstall. The place is outside
 * `node_modules`. npm therefore cannot remove the directory as an extraneous package. The place is
 * in the plugin root, on the same volume, so a rename can move the directory.
 */
const ONNX_BACKUP = '.onnxruntime-node.repair-backup';

/** A file in the plugin root. Its modification time records the last failed reinstall of `onnxruntime-node`. */
const ONNX_FAILED_MARKER = '.episodic-memory-onnx-repair-failed';

/**
 * The time after a failed reinstall before the next attempt. Without the wait, a host with no
 * network runs a failed `npm install` on every start.
 */
const ONNX_RETRY_MS = 24 * 60 * 60 * 1000;

/**
 * The name of an Agent SDK platform package: `claude-agent-sdk-<platform>-<arch>`, with an optional `-musl` or
 * `-android` suffix. The platform and arch values are those of Node. Another package with the same prefix stays.
 */
const SDK_PLATFORM_PACKAGE =
  /^claude-agent-sdk-(aix|android|darwin|freebsd|linux|netbsd|openbsd|sunos|win32)-(arm|arm64|ia32|loong64|mips|mipsel|ppc|ppc64|riscv64|s390|s390x|x64)(-musl|-android)?$/;

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
 * Remove the weight that this host never loads: the idle `onnxruntime-node` bindings, and the Agent
 * SDK platform packages on a host that names its own Claude Code binary.
 *
 * Each part is best effort and never throws. A failure in one part does not stop the other part.
 *
 * @param nodeModules - The `node_modules` directory of the plugin root.
 * @param options - Test seams: `platform` and `arch` replace the process values, `rm` replaces
 *   `fs.rmSync`, `env` replaces `process.env`, and `spawn` replaces the `spawnSync` of the probe.
 */
export function pruneOptionalWeight(nodeModules, options = {}) {
  pruneOnnxBindings(nodeModules, options);
  pruneSdkPlatformPackages(nodeModules, options);
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
 */
function pruneOnnxBindings(nodeModules, options) {
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
 * Remove every `@anthropic-ai/claude-agent-sdk-<platform>-<arch>` platform package when `EPISODIC_MEMORY_CLAUDE_BIN`
 * names a Claude Code binary that passes the probe of `dist/claude-bin.js`.
 *
 * The SDK package itself stays: it holds the code and the `manifest.json` with the version floor.
 * The function removes every platform package, because npm can install more than one candidate on
 * linux (`-linux-x64` and `-linux-x64-musl`). The function removes nothing when the variable is
 * unset, or when the probe fails: a failed probe leaves the bundled binary as the working path. The
 * probe writes its own stderr line. A removal failure writes one stderr line and stops the part.
 */
function pruneSdkPlatformPackages(nodeModules, options) {
  const { env = process.env, rm = rmSync, spawn } = options;
  if (!(env[CLAUDE_BIN_ENV] ?? '').trim()) return;
  const scopeDir = join(nodeModules, '@anthropic-ai');
  try {
    claudeExecutableOption({ env, sdkDir: join(scopeDir, 'claude-agent-sdk'), ...(spawn ? { spawn } : {}) });
  } catch (e) {
    if (e instanceof ClaudeBinError) return;
    console.error(`episodic-memory: could not check ${CLAUDE_BIN_ENV} (${e?.message ?? e}); continuing`);
    return;
  }
  try {
    for (const name of subdirs(scopeDir)) {
      if (!SDK_PLATFORM_PACKAGE.test(name)) continue;
      if (!removeBestEffort(join(scopeDir, name), rm)) return;
    }
  } catch (e) {
    if (e?.code === 'ENOENT') return;
    console.error(`episodic-memory: could not prune ${scopeDir} (${e?.message ?? e}); continuing`);
  }
}

/**
 * Make the plugin dependencies usable. Then prune the idle binding directories.
 *
 * The repair runs under a lock in the plugin root. A process that finds a lock that another live
 * process holds waits up to `waitMs`. The process stops waiting when the tree needs no repair.
 * When the process cannot create the lock file, the process writes one stderr line. The process then
 * repairs without the lock.
 *
 * @param pluginRoot - The plugin root that holds `node_modules`.
 * @param options - `waitMs` (default `REPAIR_WAIT_MS`) and `onnxRetryMs` (default
 *   `ONNX_RETRY_MS`) set the two waits. Test seams: `prune` passes seams to `pruneOptionalWeight`,
 *   `npm` replaces the npm runner (called with the plugin root and the arguments), `rm` replaces
 *   `fs.rmSync`, `rename` replaces the rename, `sleep` replaces the wait between lock attempts, and
 *   `acquire` replaces `acquireLock`.
 * @returns The first repair action: 'none', 'install' or 'reinstall-onnx'.
 *   'onnx-missing' means that the `onnxruntime-node` binding is still missing after the repair: the
 *   server starts, text search works and the first embedding fails. The prune never changes the
 *   return value.
 * @throws When npm fails for a missing package, or when the package is still missing after the
 *   repair. A failed `onnxruntime-node` reinstall never throws.
 */
export function ensureDeps(pluginRoot, options = {}) {
  const nodeModules = join(pluginRoot, 'node_modules');
  const plan = repairPlan(nodeModules);
  const result = plan === 'none' ? plan : lockedRepair(pluginRoot, nodeModules, plan, options);
  pruneOptionalWeight(nodeModules, options.prune);
  return result;
}

/** The value of `takeLock` when the process cannot create the lock file. The repair then runs without the lock. */
const NO_LOCK = Symbol('no repair lock');

/**
 * Try to take the repair lock.
 *
 * Return the handle, or null when another live process holds the lock. Return `NO_LOCK` when the
 * process cannot create the lock file, because a lock error must not stop the server.
 */
function takeLock(acquire, lockPath) {
  try {
    return acquire(lockPath);
  } catch (e) {
    console.error(`episodic-memory: could not take ${lockPath} (${e?.message ?? e}); repairing without the lock`);
    return NO_LOCK;
  }
}

/**
 * The log entry of the SessionStart hook for one result of `ensureDeps`.
 *
 * @param action - The return value of `ensureDeps`.
 * @returns A `[level, message]` pair, or null for 'none'. 'onnx-missing' gives an error entry,
 *   because vector search is unavailable until the binding is back.
 */
export function depsRepairLogEntry(action) {
  if (action === 'none') return null;
  if (action === 'onnx-missing') {
    return ['error', 'SessionStart deps repair left the onnxruntime-node binding missing; vector search is unavailable'];
  }
  return ['info', `SessionStart deps repaired: ${action}`];
}

/** Take the repair lock, then repair. Return the result of `ensureDeps`. */
function lockedRepair(pluginRoot, nodeModules, plan, options) {
  const { waitMs = REPAIR_WAIT_MS, sleep = sleepSync, acquire = acquireLock } = options;
  const lockPath = join(pluginRoot, REPAIR_LOCK);
  const deadline = Date.now() + waitMs;
  let lock = takeLock(acquire, lockPath);
  while (lock === null) {
    // The holder of the lock has repaired the tree.
    if (repairPlan(nodeModules) === 'none') return plan;
    if (Date.now() >= deadline) {
      console.error(`episodic-memory: another process holds ${lockPath}; no repair in this process`);
      return checkUsable(pluginRoot, nodeModules) ?? plan;
    }
    sleep(REPAIR_POLL_MS);
    lock = takeLock(acquire, lockPath);
  }
  try {
    repair(pluginRoot, nodeModules, options);
    return checkUsable(pluginRoot, nodeModules) ?? plan;
  } finally {
    if (lock !== NO_LOCK) releaseLock(lock);
  }
}

/**
 * Run each repair step that the tree needs, in the order of `repairPlan`. Each step runs only
 * when a new check still asks for it, because an exit code does not prove that npm restored a file.
 * The first step moves back a package directory that a stopped reinstall leaves aside.
 */
function repair(pluginRoot, nodeModules, options) {
  const { npm = runNpm } = options;
  recoverOnnxBackup(pluginRoot, nodeModules, options);
  if (repairPlan(nodeModules) === 'install') {
    console.error('Installing episodic-memory dependencies (first run only, 30-60 s)...');
    npm(pluginRoot, [...NPM_INSTALL_ARGS]);
  }
  if (repairPlan(nodeModules) === 'reinstall-onnx') reinstallOnnx(pluginRoot, nodeModules, options);
}

/**
 * Throw when the tree is still unusable. Return 'onnx-missing' when only the `onnxruntime-node`
 * binding is missing, and nothing when the tree is healthy.
 */
function checkUsable(pluginRoot, nodeModules) {
  const after = repairPlan(nodeModules);
  if (after === 'none') return undefined;
  if (after === 'reinstall-onnx') return 'onnx-missing';
  throw new Error(`dependencies still unusable after repair (plan=${after}) in ${pluginRoot}`);
}

/**
 * Move the `onnxruntime-node` backup back into `node_modules` when the package directory is missing.
 * A reinstall that a process stop interrupts leaves this state. Without the move, the next install
 * downloads the package. The old directory then stays in the plugin root. The function writes one
 * stderr line and never throws.
 */
function recoverOnnxBackup(pluginRoot, nodeModules, options) {
  const { rename = renameWithRetry } = options;
  const dir = join(nodeModules, 'onnxruntime-node');
  const backup = join(pluginRoot, ONNX_BACKUP);
  if (!existsSync(backup) || existsSync(dir)) return;
  try {
    rename(backup, dir);
    console.error(`episodic-memory: moved ${backup} back to ${dir}; an earlier reinstall stopped before its end`);
  } catch (e) {
    console.error(`episodic-memory: could not move ${backup} back to ${dir} (${e?.message ?? e}); continuing`);
  }
}

/**
 * Install `onnxruntime-node` again, because `npm install` does not restore one missing file inside an
 * installed package. The function moves the package directory aside, runs the install and checks the
 * binding. When the binding is still missing, the function puts the old directory back. The function
 * then writes the failure marker. The next attempt then waits `onnxRetryMs`. The function writes each
 * failure to stderr and never throws, because the server can start without the binding.
 */
function reinstallOnnx(pluginRoot, nodeModules, options) {
  const { npm = runNpm, rm = rmSync, rename = renameWithRetry, onnxRetryMs = ONNX_RETRY_MS } = options;
  const dir = join(nodeModules, 'onnxruntime-node');
  const backup = join(pluginRoot, ONNX_BACKUP);
  const marker = join(pluginRoot, ONNX_FAILED_MARKER);
  const failedAt = mtimeMs(marker);
  if (failedAt !== null && Date.now() - failedAt < onnxRetryMs) {
    console.error(`episodic-memory: ${ONNX_BINDING} is missing; the last reinstall failed (${marker}); delete that file to retry now`);
    return;
  }
  console.error(`Reinstalling onnxruntime-node: ${ONNX_BINDING} is missing...`);
  if (existsSync(backup) && !removeBestEffort(backup, rm)) return;
  try {
    rename(dir, backup);
  } catch (e) {
    // On Windows, another process can hold a file of the package open.
    console.error(`episodic-memory: could not move ${dir} aside (${e?.message ?? e}); continuing without the binding`);
    return;
  }
  try {
    npm(pluginRoot, [...NPM_INSTALL_ARGS]);
  } catch (e) {
    console.error(`episodic-memory: ${e?.message ?? e}`);
  }
  if (onnxBindingState(nodeModules) === 'present') {
    removeBestEffort(backup, rm);
    if (failedAt !== null) removeBestEffort(marker, rm);
    return;
  }
  putOldDirBack(dir, backup, rm, rename);
  try {
    writeFileSync(marker, `${new Date().toISOString()}\n`);
  } catch (e) {
    console.error(`episodic-memory: could not write ${marker} (${e?.message ?? e}); the next start tries the reinstall again`);
  }
}

/** Replace the directory of a failed reinstall with the backup. Write each failure to stderr. */
function putOldDirBack(dir, backup, rm, rename) {
  if (existsSync(dir) && !removeBestEffort(dir, rm)) return;
  try {
    rename(backup, dir);
    console.error(`episodic-memory: the reinstall did not restore ${ONNX_BINDING}; put the old ${dir} back; continuing without the binding`);
  } catch (e) {
    console.error(`episodic-memory: could not move ${backup} back to ${dir} (${e?.message ?? e}); the next start installs the package`);
  }
}

/** The modification time of `path` in milliseconds, or null when the file does not exist. */
function mtimeMs(path) {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return null;
  }
}
