/**
 * Worker setup: delete every `EPISODIC_MEMORY_*` variable that `TEST_ENV` does not pin.
 *
 * `vitest.config.ts` can set a variable but cannot remove a variable. This file therefore
 * removes the settings of the machine that runs the suite. `TEST_ENV` lists the values that stay.
 */
import { TEST_ENV } from './test-env.js';

for (const key of Object.keys(process.env)) {
  if (key.startsWith('EPISODIC_MEMORY_') && !(key in TEST_ENV)) delete process.env[key];
}
for (const [key, value] of Object.entries(TEST_ENV)) process.env[key] = value;
