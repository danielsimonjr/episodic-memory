/**
 * node_modules health check shared by the MCP wrapper, the SessionStart sync hook and `doctor`.
 * Dependency-free (fs/path only) so callers can import it before npm install.
 */
/**
 * better-sqlite3's COMPILED binding. The plugin installer skips install scripts, so a tree can hold
 * better-sqlite3's JS with no binding at all; lib/index.js alone passed for 1.5.2-1.5.6 while every
 * sync failed. The binding itself is the only honest sentinel for "the database can open".
 */
export declare const NATIVE_ADDON = "better-sqlite3/build/Release/better_sqlite3.node";
export declare const DEP_SENTINELS: string[];
export declare function nodeModulesIsHealthy(nodeModulesPath: string): boolean;
/**
 * What a caller must run to make node_modules usable. `npm install` on a tree that already lists
 * better-sqlite3 does not rebuild its binding, so a missing binding alone needs `npm rebuild`.
 */
export declare function repairPlan(nodeModulesPath: string): 'none' | 'install' | 'rebuild';
