/**
 * The environment of every test worker, in one place.
 *
 * `vitest.config.ts` applies these values, and `setup-env.ts` deletes every other
 * `EPISODIC_MEMORY_*` variable. A local run therefore starts from the same settings as CI.
 * The machine env can select a backend, name a model server or name a fallback model. A test
 * that inherits one of these settings can reach a real model. A test that needs another value
 * sets that value.
 */
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** The pinned variables. Every other `EPISODIC_MEMORY_*` variable is absent in a test. */
export const TEST_ENV: Readonly<Record<string, string>> = {
  EPISODIC_MEMORY_SUMMARIZER_BACKEND: 'claude',
  EPISODIC_MEMORY_OLLAMA_URL: 'http://127.0.0.1:9', // port 9 is closed: no request can succeed
  EPISODIC_MEMORY_OLLAMA_MODEL: '', // blank counts as unset; a test that needs a model sets a model
  // A test that does not set its own config directory writes to this folder, never to the live data.
  EPISODIC_MEMORY_CONFIG_DIR: join(tmpdir(), 'episodic-memory-test-config'),
  FLEET_GPU_RESERVATION: join(tmpdir(), 'episodic-memory-test-no-gpu-reservation.json'),
  // A path that does not exist. A Codex summary in a test fails at once. The summary never starts a real Codex.
  EPISODIC_MEMORY_CODEX_BIN: join(tmpdir(), 'episodic-memory-test-no-codex', 'codex'),
};
