/**
 * node_modules health check shared by the MCP wrapper and `doctor`.
 * Dependency-free (fs/path only) so the wrapper can import it before npm install.
 */
import { existsSync } from 'fs';
import { join } from 'path';
export const DEP_SENTINELS = [
    'better-sqlite3/lib/index.js',
    '@huggingface/transformers/package.json',
    'onnxruntime-common/package.json',
];
export function nodeModulesIsHealthy(nodeModulesPath) {
    if (!existsSync(nodeModulesPath))
        return false;
    return DEP_SENTINELS.every((rel) => existsSync(join(nodeModulesPath, rel)));
}
