/**
 * node_modules health check shared by the MCP wrapper, the SessionStart sync hook and `doctor`.
 * Dependency-free (fs/path only) so callers can import it before npm install.
 */

import { existsSync } from 'fs';
import { join } from 'path';

/**
 * better-sqlite3's COMPILED binding, in the layout v12 and earlier used. The plugin installer skips
 * install scripts, so a tree can hold better-sqlite3's JS with no binding at all; lib/index.js alone
 * passed for 1.5.2-1.5.6 while every sync failed. A compiled binding is the only honest sentinel for
 * "the database can open".
 *
 * KEPT AS THE LEGACY PATH, NOT THE ONLY ONE. See nativeAddonPresent().
 */
export const NATIVE_ADDON = 'better-sqlite3/build/Release/better_sqlite3.node';

/**
 * better-sqlite3 **13+** ships platform prebuilds as `prebuilds/<platform>-<arch>.node` and never
 * creates `build/Release/`. Checking only the legacy path therefore reports a perfectly healthy v13
 * tree as "binding missing", and `repairPlan` answers 'rebuild' every single time.
 *
 * MEASURED 2026-09-20, and the symptom was three layers away from the cause: the MCP server shelled
 * out to `npm rebuild better-sqlite3` on EVERY start, printed "Building the better-sqlite3 native
 * binding..." to stderr, and broke `test/mcp-protocol.test.ts`, which asserts on the server's first
 * stderr line. Nothing about the failure pointed at a path constant.
 *
 * The lesson is the same one the sync wrapper learned the same day: a check keyed to a vendor's
 * INTERNAL FILE LAYOUT fails silently the moment the vendor rearranges it, and it fails CLOSED -
 * indistinguishable from a genuinely broken install. This module is deliberately fs/path-only so it
 * can be imported before `npm install`, so it cannot load the package to test it functionally;
 * accepting BOTH layouts is the honest fix available under that constraint.
 */
const PREBUILDS_DIR = 'better-sqlite3/prebuilds';

/** True when a compiled binding exists in EITHER the v12 or the v13+ layout. */
export function nativeAddonPresent(nodeModulesPath: string): boolean {
  if (existsSync(join(nodeModulesPath, NATIVE_ADDON))) return true;
  // v13+: prebuilds/<platform>-<arch>.node, e.g. win32-x64.node, linux-x64.node, darwin-arm64.node.
  const prebuilt = `${process.platform}-${process.arch}.node`;
  return existsSync(join(nodeModulesPath, PREBUILDS_DIR, prebuilt));
}

/** JS-only sentinels: present whenever the packages are installed at all, binding or not. */
export const JS_SENTINELS = [
  'better-sqlite3/lib/index.js',
  '@huggingface/transformers/package.json',
  'onnxruntime-common/package.json',
];

/** Unchanged export: the JS sentinels plus the legacy binding path. */
export const DEP_SENTINELS = [
  'better-sqlite3/lib/index.js',
  NATIVE_ADDON,
  '@huggingface/transformers/package.json',
  'onnxruntime-common/package.json',
];

export function nodeModulesIsHealthy(nodeModulesPath: string): boolean {
  if (!existsSync(nodeModulesPath)) return false;
  if (!JS_SENTINELS.every((rel) => existsSync(join(nodeModulesPath, rel)))) return false;
  return nativeAddonPresent(nodeModulesPath);
}

/**
 * What a caller must run to make node_modules usable. `npm install` on a tree that already lists
 * better-sqlite3 does not rebuild its binding, so a missing binding alone needs `npm rebuild`.
 */
export function repairPlan(nodeModulesPath: string): 'none' | 'install' | 'rebuild' {
  if (nodeModulesIsHealthy(nodeModulesPath)) return 'none';
  if (!existsSync(nodeModulesPath)) return 'install';
  const jsMissing = JS_SENTINELS.some((rel) => !existsSync(join(nodeModulesPath, rel)));
  return jsMissing ? 'install' : 'rebuild';
}
