/**
 * Worker setup: delete every `EPISODIC_MEMORY_*` variable that `TEST_ENV` does not pin.
 *
 * `vitest.config.ts` can set a variable but cannot remove a variable. This file therefore
 * removes the settings of the machine that runs the suite. `TEST_ENV` lists the values that stay.
 *
 * The file also replaces `query` of the Claude Agent SDK with the guard of `real-sdk-guard.ts`.
 * A test that reaches the guard fails in the `afterEach` below, also when its code catches the error.
 */
import { afterEach, vi } from 'vitest';
import { TEST_ENV } from './test-env.js';
import { REAL_SDK_MESSAGE, takeRealSdkCalls } from './real-sdk-guard.js';

for (const key of Object.keys(process.env)) {
  if (key.startsWith('EPISODIC_MEMORY_') && !(key in TEST_ENV)) delete process.env[key];
}
for (const [key, value] of Object.entries(TEST_ENV)) process.env[key] = value;

vi.mock('@anthropic-ai/claude-agent-sdk', async (importOriginal) => {
  const { guardQuery } = await import('./real-sdk-guard.js');
  return { ...(await importOriginal<typeof import('@anthropic-ai/claude-agent-sdk')>()), query: guardQuery };
});

afterEach(() => {
  const reached = takeRealSdkCalls();
  if (reached.length > 0) throw new Error(`${REAL_SDK_MESSAGE} (${reached.length} call(s))`);
});
