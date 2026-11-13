/**
 * node_modules health check shared by the MCP wrapper, the SessionStart sync hook and `doctor`.
 * Dependency-free (fs/path only) so callers can import it before npm install.
 */
/** JS-only sentinels: present whenever the packages are installed at all, binding or not. */
export declare const JS_SENTINELS: string[];
/** The path of the `onnxruntime-node` binding of one pair, relative to `node_modules`. */
export declare function onnxBindingPath(platform: string, arch: string): string;
/** The `onnxruntime-node` binding of the running pair. The first embedding loads this file. */
export declare const ONNX_BINDING: string;
/**
 * The JS sentinels and the `onnxruntime-node` binding of the running pair. Derived so the lists cannot drift.
 */
export declare const DEP_SENTINELS: string[];
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
export declare function onnxBindingState(nodeModulesPath: string, platform?: string, arch?: string): 'present' | 'missing' | 'unshipped';
/**
 * Return true when `node_modules` holds the packages that the plugin needs.
 *
 * The folder must exist. Every path in `JS_SENTINELS` must exist, and the `onnxruntime-node` binding must not be
 * `missing` (see `onnxBindingState`). The function checks file names only and loads no package.
 */
export declare function nodeModulesIsHealthy(nodeModulesPath: string): boolean;
/**
 * What a caller must run next to make node_modules usable.
 *
 * - `install`: the folder or a package is missing.
 * - `reinstall-onnx`: the `onnxruntime-node` binding is `missing`. `npm install` does not restore
 *   one file inside an installed package, so the caller deletes the package directory first.
 *
 * One tree can need more than one step. The function returns the first step in this order. The
 * caller calls the function again after each step.
 */
export declare function repairPlan(nodeModulesPath: string): 'none' | 'install' | 'reinstall-onnx';
