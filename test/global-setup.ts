/**
 * Vitest global setup: fetch the embedding model once, before any test worker starts.
 *
 * The workers check the model and never download it. This file fetches the pinned files into the
 * model folder of `TEST_ENV` once, so the workers read the same files. The setup runs in the main
 * vitest process, where `test.env` does not apply, so the file copies `TEST_ENV` into `process.env` first.
 */
import { TEST_ENV } from './test-env.js';

/** Fetch the model into the shared test folder. A failed fetch fails the run before any test starts. */
export default async function setup(): Promise<void> {
  Object.assign(process.env, TEST_ENV);
  const { ensureModel } = await import('../src/embedding-model.js');
  await ensureModel({ download: true });
}
