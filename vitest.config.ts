import { configDefaults, defineConfig } from 'vitest/config';
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
    // test/global-setup.ts loads the embedding model once before the workers start. Therefore, the
    // workers of a fresh checkout do not download the model at the same time.
    globalSetup: ['test/global-setup.ts'],
    include: ['test/**/*.test.ts'],
    // test/e2e runs the shipped CLI and MCP server in child processes. It has its own config.
    exclude: ['test/e2e/**', ...configDefaults.exclude],
    testTimeout: 30000, // 30 seconds for embedding/indexing tests
    // Some beforeEach hooks index multi-exchange fixtures, which is CPU-bound
    // transformer embedding (100+ calls). The 10s default is too tight when
    // several test-file workers embed in parallel and oversubscribe the CPU.
    hookTimeout: 30000,
  },
});
