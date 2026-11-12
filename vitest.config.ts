import { defineConfig } from 'vitest/config';
import { TEST_ENV } from './test/test-env.js';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    // The tests run with the env of the machine that starts the tests. The machine env can select
    // the ollama backend, name a model server or name a fallback model. A test that does not set
    // its own value can then reach a real model: a shared GPU through the ollama settings, or a
    // live Claude call through EPISODIC_MEMORY_OLLAMA_FALLBACK_MODEL.
    // test/test-env.ts holds the pinned values, and test/setup-env.ts deletes every other
    // EPISODIC_MEMORY_* variable. A test that needs another value sets that value.
    env: { ...TEST_ENV },
    setupFiles: ['test/setup-env.ts'],
    include: ['test/**/*.test.ts'],
    testTimeout: 30000, // 30 seconds for embedding/indexing tests
    // Some beforeEach hooks index multi-exchange fixtures, which is CPU-bound
    // transformer embedding (100+ calls). The 10s default is too tight when
    // several test-file workers embed in parallel and oversubscribe the CPU.
    hookTimeout: 30000,
  },
});
