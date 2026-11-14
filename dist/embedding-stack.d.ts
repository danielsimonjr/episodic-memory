/**
 * The installed versions of the embedding stack, and the stamp that records them in the index.
 *
 * A different version of the model runtime can produce different vectors for the same text.
 * The index therefore records the stack that embedded its rows. When the installed stack differs,
 * every row becomes stale, and the embedding migration embeds the rows again.
 *
 * The stamp also names the model revision (see embedding-model.ts), so a new model revision re-embeds the index.
 */
import type { Database } from './sqlite.js';
/**
 * The packages whose versions decide the vectors. Each package resolves from the one before it.
 * `onnxruntime-common` resolves from the folder of `onnxruntime-node`. `@huggingface/tokenizers` is a direct
 * dependency and resolves from the plugin root.
 */
export declare const EMBEDDING_STACK_PACKAGES: readonly ["onnxruntime-node", "onnxruntime-common", "@huggingface/tokenizers"];
/**
 * Return the installed embedding stack as one string, for example
 * `onnxruntime-node@1.24.3 onnxruntime-common@1.24.3 @huggingface/tokenizers@0.1.3`.
 *
 * Each package resolves from the folder of the package before it, so a nested copy wins over a hoisted copy.
 * A package that is not installed shows the version `missing`. The function does not throw.
 *
 * @param root the plugin root that holds `node_modules`. The default is the folder above this module.
 */
export declare function readEmbeddingStack(root?: string): string;
/**
 * Return the stamp of this build: the installed stack plus the pinned model revision.
 *
 * The index stores this string. A change of the stack or of the model revision marks every row stale.
 *
 * @param root the plugin root that holds `node_modules`. The default is the folder above this module.
 */
export declare function embeddingStamp(root?: string): string;
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
export declare function reconcileEmbeddingStack(db: Database, stack: string): boolean;
/**
 * Store `stack` as the stamp of an index that has no exchange rows and no stamp.
 *
 * A new or rebuilt index has nothing to embed again, so its rows get the stamp of the stack that embeds them.
 * Without this stamp, the migration phase after the first sync would embed every new row a second time.
 * The function changes nothing in an index that has rows or a stamp. The function does not throw.
 *
 * @param db the open index database. The `exchanges` table must exist.
 * @param stack the installed stack, from readEmbeddingStack
 */
export declare function stampEmptyIndex(db: Database, stack: string): void;
