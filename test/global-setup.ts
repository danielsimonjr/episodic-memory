/**
 * Vitest global setup: load the embedding model once, before any test worker starts.
 *
 * A fresh checkout has an empty model cache. Without this file, every worker downloads the model
 * at the same time. On Windows, the rename of the temporary model file then fails with EPERM, and
 * every test that embeds text fails. One load in the global setup fills the cache, so each worker reads
 * the cached file.
 */
import { initEmbeddings } from '../src/embeddings.js';

/** Load the model into the shared cache. A failed download fails the run before any test starts. */
export default async function setup(): Promise<void> {
  await initEmbeddings();
}
