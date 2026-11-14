import { spawn } from 'child_process';
import readline from 'readline';
import { commandInvocation } from './win-command.js';
function isRecord(value) {
    return typeof value === 'object' && value !== null;
}
function hookBelongsToEpisodicMemory(hook) {
    const pluginId = typeof hook.pluginId === 'string' ? hook.pluginId : '';
    const key = typeof hook.key === 'string' ? hook.key : '';
    return pluginId.startsWith('episodic-memory@') || key.startsWith('episodic-memory@');
}
/**
 * Reads the trust state of the episodic-memory hooks from a `hooks/list` response.
 *
 * A hook belongs to this plugin when its `pluginId` or its `key` starts with `episodic-memory@`.
 * A trusted or managed hook takes precedence over a modified hook. A modified hook takes precedence over an untrusted one.
 * Returns `unknown` when the response has no `data` array, or when the function cannot read a trust state.
 */
export function trustStateFromHooksList(result) {
    if (!isRecord(result) || !Array.isArray(result.data)) {
        return 'unknown';
    }
    const matchingHooks = [];
    for (const entry of result.data) {
        if (!isRecord(entry) || !Array.isArray(entry.hooks))
            continue;
        for (const hook of entry.hooks) {
            if (isRecord(hook) && hookBelongsToEpisodicMemory(hook)) {
                matchingHooks.push(hook);
            }
        }
    }
    if (matchingHooks.length === 0) {
        return 'not_found';
    }
    const trustStates = matchingHooks
        .map(hook => hook.trustStatus ?? hook.trust ?? hook.trust_status)
        .filter((trust) => typeof trust === 'string');
    if (trustStates.includes('trusted') || trustStates.includes('managed')) {
        return 'trusted';
    }
    if (trustStates.includes('modified')) {
        return 'modified';
    }
    if (trustStates.includes('untrusted')) {
        return 'untrusted';
    }
    return 'unknown';
}
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
export async function detectCodexHookTrustState(codexHome, cwd, timeoutMs = 10000) {
    const env = { ...process.env, CODEX_HOME: codexHome };
    const run = commandInvocation('codex', ['app-server'], env);
    const child = spawn(run.file, run.args, {
        env,
        stdio: ['pipe', 'pipe', 'ignore'],
        windowsVerbatimArguments: run.windowsVerbatimArguments,
    });
    const rl = readline.createInterface({ input: child.stdout });
    const pending = new Map();
    let nextId = 1;
    // A child that fails or exits ends every pending request at once, so the check does not wait for the timeout.
    const stop = (error) => {
        for (const entry of pending.values()) {
            entry.reject(error);
        }
        pending.clear();
    };
    child.on('error', stop);
    // A write to a child that has exited fails later, as an 'error' event on stdin (EPIPE).
    // Without this listener, that event is an uncaught exception, and it stops `doctor`.
    child.stdin.on('error', stop);
    child.on('exit', () => stop(new Error('the Codex app-server exited')));
    rl.on('line', line => {
        if (!line.trim())
            return;
        let message;
        try {
            message = JSON.parse(line);
        }
        catch {
            return;
        }
        if (typeof message.id !== 'number')
            return;
        const entry = pending.get(message.id);
        if (!entry)
            return;
        pending.delete(message.id);
        if (message.error) {
            entry.reject(new Error(JSON.stringify(message.error)));
        }
        else {
            entry.resolve(message.result);
        }
    });
    const send = (method, params) => {
        const id = nextId++;
        child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
        return new Promise((resolve, reject) => {
            pending.set(id, { resolve, reject });
        });
    };
    const notify = (method) => {
        child.stdin.write(`${JSON.stringify({ method })}\n`);
    };
    const timeout = setTimeout(() => {
        child.kill('SIGTERM');
        for (const entry of pending.values()) {
            entry.reject(new Error('timed out inspecting Codex hooks'));
        }
        pending.clear();
    }, timeoutMs);
    try {
        await send('initialize', {
            clientInfo: { name: 'episodic-memory-doctor', version: '0.0.0' },
            capabilities: { experimentalApi: true },
        });
        notify('initialized');
        const hooksList = await send('hooks/list', { cwds: [cwd] });
        return trustStateFromHooksList(hooksList);
    }
    catch {
        return 'unknown';
    }
    finally {
        clearTimeout(timeout);
        rl.close();
        child.kill('SIGTERM');
    }
}
