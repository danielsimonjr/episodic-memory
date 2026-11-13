/**
 * The guard that stops a test from reaching the real Claude Agent SDK.
 *
 * `setup-env.ts` replaces `query` of `@anthropic-ai/claude-agent-sdk` with `guardQuery` in every test
 * file. A test that passes no fake judge, agent runner or text model then fails at once. Without the
 * guard, such a test starts a real Claude Code process. On a machine that is logged in, the call spends
 * usage. On a machine that is not logged in, the call stalls to the test timeout.
 *
 * A test file that mocks the SDK itself keeps its own mock, because the mock of the test file has priority.
 */

/** The error message of a call that reached the guard. */
export const REAL_SDK_MESSAGE =
  'a test reached the real query() of @anthropic-ai/claude-agent-sdk; pass a fake judge, agent runner or text model';

/** The prompts of the calls that reached the guard since the last `takeRealSdkCalls`. */
const calls: string[] = [];

/**
 * Record one call. Then throw the guard error. The function replaces `query` of the SDK in tests.
 *
 * @throws Error with `REAL_SDK_MESSAGE`, always.
 */
export function guardQuery(params?: { prompt?: unknown }): never {
  const prompt = params?.prompt;
  calls.push(typeof prompt === 'string' ? prompt : '<a prompt that is not a string>');
  throw new Error(REAL_SDK_MESSAGE);
}

/** Return the prompts of the recorded calls, and clear the record. */
export function takeRealSdkCalls(): string[] {
  return calls.splice(0);
}
