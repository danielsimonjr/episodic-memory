import { configDefaults, defineConfig } from 'vitest/config';
import { TEST_ENV } from './test/test-env.js';

/**
 * The end-to-end suite. It runs the shipped CLI and MCP server as child processes, so it runs
 * one file at a time: the children load the embedding model, and parallel files would inflate
 * every timeout. It uses the same pinned env and global setup as the unit suite.
 */
export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    env: { ...TEST_ENV },
    setupFiles: ['test/setup-env.ts'],
    globalSetup: ['test/global-setup.ts'],
    include: ['test/e2e/**/*.test.ts'],
    exclude: [...configDefaults.exclude],
    fileParallelism: false,
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});
