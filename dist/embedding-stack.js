/**
 * The installed versions of the embedding stack, and the stamp that records them in the index.
 *
 * A different version of the model runtime can produce different vectors for the same text.
 * The index therefore records the stack that embedded its rows. When the installed stack differs,
 * every row becomes stale, and the embedding migration embeds the rows again.
 */
import { existsSync, readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
/** The packages whose versions decide the vectors. Each package resolves from the one before it. */
export const EMBEDDING_STACK_PACKAGES = ['@huggingface/transformers', 'onnxruntime-node', 'onnxruntime-common'];
/** The key of the stamp in the `index_meta` table. */
const STACK_KEY = 'embedding_stack';
/** The plugin root: the folder above `dist/` or `src/`. */
function defaultRoot() {
    return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
}
/**
 * Find the folder of `name` as Node resolution finds it from `fromDir`.
 * The search looks in `node_modules` of `fromDir` and of each parent folder up to `root`.
 */
function resolvePackageDir(name, fromDir, root) {
    let dir = fromDir;
    for (;;) {
        const candidate = path.join(dir, 'node_modules', name);
        if (existsSync(path.join(candidate, 'package.json')))
            return candidate;
        if (path.resolve(dir) === path.resolve(root))
            return null;
        const parent = path.dirname(dir);
        if (parent === dir)
            return null;
        dir = parent;
    }
}
/**
 * Return the installed embedding stack as one string, for example
 * `@huggingface/transformers@4.2.0 onnxruntime-node@1.24.3 onnxruntime-common@1.24.3`.
 *
 * Each package resolves from the folder of the package before it, so a nested copy wins over a hoisted copy.
 * A package that is not installed shows the version `missing`. The function does not throw.
 *
 * @param root the plugin root that holds `node_modules`. The default is the folder above this module.
 */
export function readEmbeddingStack(root = defaultRoot()) {
    const parts = [];
    let from = root;
    for (const name of EMBEDDING_STACK_PACKAGES) {
        const dir = resolvePackageDir(name, from, root);
        let version = 'missing';
        if (dir) {
            try {
                version = String(JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf-8')).version ?? 'missing');
            }
            catch {
                version = 'missing';
            }
            from = dir;
        }
        parts.push(`${name}@${version}`);
    }
    return parts.join(' ');
}
/**
 * Compare the stack stamp of the index with `stack`, and mark every row stale when the two differ.
 *
 * An index without a stamp counts as different, because nothing records which stack embedded its rows.
 * The function sets `embedding_version` to 0 on every exchange and then stores `stack` as the new stamp.
 * The function creates the `index_meta` table when the table is missing.
 *
 * @param db the open index database
 * @param stack the installed stack, from readEmbeddingStack
 * @returns true when the function marked the rows stale
 */
export function reconcileEmbeddingStack(db, stack) {
    db.exec('CREATE TABLE IF NOT EXISTS index_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
    const row = db.prepare('SELECT value FROM index_meta WHERE key = ?').get(STACK_KEY);
    if (row?.value === stack)
        return false;
    db.transaction(() => {
        db.exec('UPDATE exchanges SET embedding_version = 0');
        db.prepare('INSERT OR REPLACE INTO index_meta (key, value) VALUES (?, ?)').run(STACK_KEY, stack);
    })();
    return true;
}
