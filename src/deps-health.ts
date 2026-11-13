/**
 * node_modules health check shared by the MCP wrapper, the SessionStart sync hook and `doctor`.
 * Dependency-free (fs/path only) so callers can import it before npm install.
 */

import { existsSync, readdirSync } from 'fs';
import { dirname, join } from 'path';

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
 * A wrong path here shows up far from its cause. The MCP server would run `npm rebuild
 * better-sqlite3` on every start and print "Building the better-sqlite3 native binding..." to
 * stderr. `test/mcp-protocol.test.ts` checks only that stderr contains the ready line. The test does
 * not catch the extra rebuild.
 *
 * A check keyed to the INTERNAL FILE LAYOUT of a vendor fails silently when the vendor rearranges
 * it, and it fails CLOSED - indistinguishable from a genuinely broken install. This module is deliberately fs/path-only so it
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
  'onnxruntime-node/package.json',
];

/** The directory that holds one `<platform>/<arch>` binding directory for each pair that `onnxruntime-node` ships. */
const ONNX_NAPI_DIR = 'onnxruntime-node/bin/napi-v6';

/** The file that `onnxruntime-node` loads from the directory of the running pair. */
const ONNX_BINDING_FILE = 'onnxruntime_binding.node';

/** The path of the `onnxruntime-node` binding of one pair, relative to `node_modules`. */
export function onnxBindingPath(platform: string, arch: string): string {
  return `${ONNX_NAPI_DIR}/${platform}/${arch}/${ONNX_BINDING_FILE}`;
}

/** The `onnxruntime-node` binding of the running pair. The first embedding loads this file. */
export const ONNX_BINDING = onnxBindingPath(process.platform, process.arch);

/**
 * The JS sentinels, the legacy better-sqlite3 binding path and the `onnxruntime-node` binding of the running pair.
 * Derived so the lists cannot drift.
 */
export const DEP_SENTINELS = [NATIVE_ADDON, ONNX_BINDING, ...JS_SENTINELS];

/**
 * The state of the `onnxruntime-node` binding of one pair.
 *
 * - `present`: the binding file of the pair exists.
 * - `missing`: the directory of the pair exists without the file, or no pair holds a binding file.
 *   The tree lost the file. `npm install` does not restore one file inside an installed package,
 *   so the repair deletes the package directory and installs again.
 * - `unshipped`: other pairs hold a binding file and the pair has no directory, or the package has
 *   no `bin/napi-v6` directory. The installed version ships no binding for this host (1.24.3 ships
 *   none for darwin/x64), or the version uses a layout that this check does not know. A reinstall
 *   cannot help, so the state needs no repair. Text search still works; the first embedding fails.
 *
 * The prune in `cli/ensure-deps.js` keeps the damaged states apart from `unshipped`. The prune runs
 * only when the binding of the running pair exists, and the prune removes every other pair. A pruned
 * tree that loses the file keeps the directory of the running pair: `missing`. A tree where the
 * running pair never existed keeps every other pair, because the prune never ran: `unshipped`.
 * A tree that lost the whole `bin/napi-v6` directory also reads as `unshipped`, so that state gets no repair.
 * The function reads file names only and loads no package.
 */
export function onnxBindingState(
  nodeModulesPath: string,
  platform: string = process.platform,
  arch: string = process.arch,
): 'present' | 'missing' | 'unshipped' {
  const binding = join(nodeModulesPath, onnxBindingPath(platform, arch));
  if (existsSync(binding)) return 'present';
  if (existsSync(dirname(binding))) return 'missing';
  const napiDir = join(nodeModulesPath, ONNX_NAPI_DIR);
  if (!existsSync(napiDir)) return 'unshipped';
  return anyOnnxBinding(napiDir) ? 'unshipped' : 'missing';
}

/** True when a `<platform>/<arch>` directory under `napiDir` holds a binding file. A missing directory gives false. */
function anyOnnxBinding(napiDir: string): boolean {
  const subdirs = (dir: string): string[] => {
    try {
      return readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
    } catch {
      return [];
    }
  };
  return subdirs(napiDir).some((p) =>
    subdirs(join(napiDir, p)).some((a) => existsSync(join(napiDir, p, a, ONNX_BINDING_FILE))),
  );
}

/**
 * Return true when `node_modules` holds the packages and the native binding that the plugin needs.
 *
 * The folder must exist. Every path in `JS_SENTINELS` must exist. A compiled better-sqlite3 binding must exist in a layout that `nativeAddonPresent` accepts.
 * The `onnxruntime-node` binding must not be `missing` (see `onnxBindingState`). The function checks file names only and loads no package.
 */
export function nodeModulesIsHealthy(nodeModulesPath: string): boolean {
  if (!existsSync(nodeModulesPath)) return false;
  if (!JS_SENTINELS.every((rel) => existsSync(join(nodeModulesPath, rel)))) return false;
  if (onnxBindingState(nodeModulesPath) === 'missing') return false;
  return nativeAddonPresent(nodeModulesPath);
}

/**
 * What a caller must run next to make node_modules usable.
 *
 * - `install`: the folder or a package is missing.
 * - `reinstall-onnx`: the `onnxruntime-node` binding is `missing`. `npm install` does not restore
 *   one file inside an installed package, so the caller deletes the package directory first.
 * - `rebuild`: only the better-sqlite3 binding is missing. `npm install` on a tree that already
 *   lists better-sqlite3 does not build its binding, so the caller runs `npm rebuild`.
 *
 * One tree can need more than one step. The function returns the first step in this order. The
 * caller calls the function again after each step.
 */
export function repairPlan(nodeModulesPath: string): 'none' | 'install' | 'reinstall-onnx' | 'rebuild' {
  if (!existsSync(nodeModulesPath)) return 'install';
  if (nodeModulesIsHealthy(nodeModulesPath)) return 'none';
  if (JS_SENTINELS.some((rel) => !existsSync(join(nodeModulesPath, rel)))) return 'install';
  if (onnxBindingState(nodeModulesPath) === 'missing') return 'reinstall-onnx';
  return 'rebuild';
}
