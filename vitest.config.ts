import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    // The tests run with the env of the machine that starts them. That env can select the ollama
    // backend and name a model server, so a test that does not set its own backend reached a real
    // model (measured 2026-10-26: 8 requests to a shared GPU from one test run). Pin both, and
    // point the reservation at a file that does not exist. A test that needs another value sets it.
    env: {
      EPISODIC_MEMORY_SUMMARIZER_BACKEND: 'claude',
      EPISODIC_MEMORY_OLLAMA_URL: 'http://127.0.0.1:9', // port 9 is closed: no request can succeed
      FLEET_GPU_RESERVATION: join(tmpdir(), 'episodic-memory-test-no-gpu-reservation.json'),
    },
    include: ['test/**/*.test.ts'],
    testTimeout: 30000, // 30 seconds for embedding/indexing tests
    // Some beforeEach hooks index multi-exchange fixtures, which is CPU-bound
    // transformer embedding (100+ calls). The 10s default is too tight when
    // several test-file workers embed in parallel and oversubscribe the CPU.
    hookTimeout: 30000,
  },
});
