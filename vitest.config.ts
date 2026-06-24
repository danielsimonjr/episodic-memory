import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['test/**/*.test.ts'],
    testTimeout: 30000, // 30 seconds for embedding/indexing tests
    // Some beforeEach hooks index multi-exchange fixtures, which is CPU-bound
    // transformer embedding (100+ calls). The 10s default is too tight when
    // several test-file workers embed in parallel and oversubscribe the CPU.
    hookTimeout: 30000,
  },
});
