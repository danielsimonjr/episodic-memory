/**
 * The trust state that Codex reports for the episodic-memory hooks.
 *
 * `not_found` means that Codex lists no such hook. `unknown` also means that the lookup failed.
 */
export type CodexHookTrustState = 'trusted' | 'untrusted' | 'modified' | 'not_found' | 'unknown';
/**
 * Reads the trust state of the episodic-memory hooks from a `hooks/list` response.
 *
 * A hook belongs to this plugin when its `pluginId` or its `key` starts with `episodic-memory@`.
 * A trusted or managed hook takes precedence over a modified hook. A modified hook takes precedence over an untrusted one.
 * Returns `unknown` when the response has no `data` array, or when the function cannot read a trust state.
 */
export declare function trustStateFromHooksList(result: unknown): CodexHookTrustState;
/**
 * Asks the Codex CLI for the trust state of the episodic-memory hooks in one working directory.
 *
 * The function starts `codex app-server` with `CODEX_HOME` set to `codexHome`. The function sends `hooks/list` and reads the answer.
 * The function returns `unknown` when the server fails, replies with an error, or does not reply within `timeoutMs`.
 * The function sends SIGTERM to the child process before the function returns.
 *
 * @param codexHome The Codex home directory to inspect.
 * @param cwd The working directory whose hooks the server lists.
 * @param timeoutMs The longest wait for the whole exchange, in milliseconds. Defaults to 10 seconds.
 */
export declare function detectCodexHookTrustState(codexHome: string, cwd: string, timeoutMs?: number): Promise<CodexHookTrustState>;
