/**
 * Make node_modules usable before anything opens the database. Shared by the MCP wrapper and the
 * SessionStart sync hook, because the sync hook never goes through the wrapper: a tree with
 * better-sqlite3's JS but no compiled binding made every background sync fail silently.
 *
 * All child output goes to stderr (fd 2). The MCP wrapper's stdout is the JSON-RPC transport.
 */

import { spawnSync } from 'child_process';
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

/** Returns the action taken: 'none' | 'install' | 'rebuild'. Throws if the repair fails. */
export function ensureDeps(pluginRoot) {
  const nodeModules = join(pluginRoot, 'node_modules');
  const plan = repairPlan(nodeModules);
  if (plan === 'none') return plan;

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
  return plan;
}
