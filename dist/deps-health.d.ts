/**
 * node_modules health check shared by the MCP wrapper and `doctor`.
 * Dependency-free (fs/path only) so the wrapper can import it before npm install.
 */
export declare const DEP_SENTINELS: string[];
export declare function nodeModulesIsHealthy(nodeModulesPath: string): boolean;
