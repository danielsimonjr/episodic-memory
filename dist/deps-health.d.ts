/**
 * node_modules health check shared by the MCP wrapper, the SessionStart sync hook and `doctor`.
 * Dependency-free (fs/path only) so callers can import it before npm install.
 */
/**
 * better-sqlite3's COMPILED binding, in the layout v12 and earlier used. The plugin installer skips
 * install scripts, so a tree can hold better-sqlite3's JS with no binding at all; lib/index.js alone
 * passed for 1.5.2-1.5.6 while every sync failed. A compiled binding is the only honest sentinel for
 * "the database can open".
 *
 * KEPT AS THE LEGACY PATH, NOT THE ONLY ONE. See nativeAddonPresent().
 */
export declare const NATIVE_ADDON = "better-sqlite3/build/Release/better_sqlite3.node";
/** True when a compiled binding exists in EITHER the v12 or the v13+ layout. */
export declare function nativeAddonPresent(nodeModulesPath: string): boolean;
/** JS-only sentinels: present whenever the packages are installed at all, binding or not. */
export declare const JS_SENTINELS: string[];
/** Unchanged export: the JS sentinels plus the legacy binding path. */
export declare const DEP_SENTINELS: string[];
export declare function nodeModulesIsHealthy(nodeModulesPath: string): boolean;
/**
 * What a caller must run to make node_modules usable. `npm install` on a tree that already lists
 * better-sqlite3 does not rebuild its binding, so a missing binding alone needs `npm rebuild`.
 */
export declare function repairPlan(nodeModulesPath: string): 'none' | 'install' | 'rebuild';
