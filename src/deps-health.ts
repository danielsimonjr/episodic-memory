/**
 * node_modules health check shared by the MCP wrapper, the SessionStart sync hook and `doctor`.
 * Dependency-free (fs/path only) so callers can import it before npm install.
 */

import { existsSync } from 'fs';
import { join } from 'path';

/**
 * better-sqlite3's COMPILED binding. The plugin installer skips install scripts, so a tree can hold
 * better-sqlite3's JS with no binding at all; lib/index.js alone passed for 1.5.2-1.5.6 while every
 * sync failed. The binding itself is the only honest sentinel for "the database can open".
 */
export const NATIVE_ADDON = 'better-sqlite3/build/Release/better_sqlite3.node';

export const DEP_SENTINELS = [
  'better-sqlite3/lib/index.js',
  NATIVE_ADDON,
  '@huggingface/transformers/package.json',
  'onnxruntime-common/package.json',
];

export function nodeModulesIsHealthy(nodeModulesPath: string): boolean {
  if (!existsSync(nodeModulesPath)) return false;
  return DEP_SENTINELS.every((rel) => existsSync(join(nodeModulesPath, rel)));
}

/**
 * What a caller must run to make node_modules usable. `npm install` on a tree that already lists
 * better-sqlite3 does not rebuild its binding, so a missing binding alone needs `npm rebuild`.
 */
export function repairPlan(nodeModulesPath: string): 'none' | 'install' | 'rebuild' {
  if (nodeModulesIsHealthy(nodeModulesPath)) return 'none';
  if (!existsSync(nodeModulesPath)) return 'install';
  const jsMissing = DEP_SENTINELS.some(
    (rel) => rel !== NATIVE_ADDON && !existsSync(join(nodeModulesPath, rel))
  );
  return jsMissing ? 'install' : 'rebuild';
}
