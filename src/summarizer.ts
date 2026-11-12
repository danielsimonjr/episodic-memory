import { ConversationExchange } from './types.js';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { SUMMARIZER_CONTEXT_MARKER } from './constants.js';
import { VERSION } from './version.js';
import { SUMMARIZER_GUARD_ENV, shouldSkipReentrantSync } from './reentrancy.js';
import { spawn } from 'child_process';
import { createInterface } from 'readline';
import {
  codexVersionRequirementMessage,
  parseCodexCliVersion,
  versionMeetsMinimum,
} from './codex-support.js';
import { validateApiBaseUrl } from './api-endpoint.js';
import { summarizerBackend, callOllama, GpuReservedError, type OllamaCallOptions } from './ollama-backend.js';

/** The command that runs one Codex summarization. buildCodexSummarizerCommand creates it. */
export interface CodexSummarizerCommand {
  /** The executable to start. */
  command: string;
  /** The arguments for the executable. */
  args: string[];
  /** The summarization prompt. */
  prompt: string;
  /** The Codex session to fork. */
  sessionId: string;
  /** The model for the fork. When the caller omits `model`, the fork sends no model. */
  model?: string;
  /** The arguments for the version check, run with `command`. The default is `--version`. */
  versionArgs?: string[];
  /** When true, runCodexCommand skips the version check. */
  skipVersionCheck?: boolean;
}

/**
 * Build the environment for a summarization subprocess.
 *
 * The result contains all of process.env, so the subprocess gets PATH, HOME and the other variables.
 * The result always sets EPISODIC_MEMORY_SUMMARIZER_GUARD to `1`. The guard stops the subprocess from starting another sync.
 *
 * The function reads these variables:
 * - EPISODIC_MEMORY_API_BASE_URL: when the variable has a non-empty value, the function validates it. A valid endpoint sets ANTHROPIC_BASE_URL to the validated URL. For an unsafe endpoint, the function ignores the value and writes a message to stderr.
 * - EPISODIC_MEMORY_API_TOKEN: when the variable has a non-empty value, the function sets ANTHROPIC_AUTH_TOKEN to that value.
 * - EPISODIC_MEMORY_API_TIMEOUT_MS: when the variable has a non-empty value, the function sets API_TIMEOUT_MS to that value. callClaude also reads the variable for its own abort timer.
 *
 * callClaude and callModel read EPISODIC_MEMORY_API_MODEL and EPISODIC_MEMORY_API_MODEL_FALLBACK. The function getApiEnv does not read them.
 */
export function getApiEnv(): Record<string, string | undefined> | undefined {
  const baseUrlRaw = process.env.EPISODIC_MEMORY_API_BASE_URL;
  const token = process.env.EPISODIC_MEMORY_API_TOKEN;
  const timeoutMs = process.env.EPISODIC_MEMORY_API_TIMEOUT_MS;

  let safeBaseUrl: string | undefined;
  if (baseUrlRaw) {
    const check = validateApiBaseUrl(baseUrlRaw);
    if (check.ok) {
      safeBaseUrl = check.url;
    } else {
      // Refuse to point the summarizer at an unsafe endpoint — fall back to
      // the default Anthropic API rather than exfiltrating transcripts.
      console.error(
        `episodic-memory: ignoring EPISODIC_MEMORY_API_BASE_URL: ${check.reason}`
      );
    }
  }

  // Always include the reentrancy guard so the SDK-spawned Claude subprocess
  // (which inherits this env) marks itself as a reentrant context. The
  // SessionStart hook runs `sync --background`, which checks the guard with
  // shouldSkipReentrantSync() and exits before it syncs. The check stops a
  // recursive cascade of sync processes.
  return {
    ...process.env,
    [SUMMARIZER_GUARD_ENV]: '1',
    ...(safeBaseUrl && { ANTHROPIC_BASE_URL: safeBaseUrl }),
    ...(token && { ANTHROPIC_AUTH_TOKEN: token }),
    ...(timeoutMs && { API_TIMEOUT_MS: timeoutMs }),
  };
}

/**
 * Re-export `shouldSkipReentrantSync` from `./reentrancy.js`.
 *
 * The sync CLI imports the function from `./reentrancy.js`, so the CLI does not load this module's SDK dependencies.
 * Code that imports the function from this module keeps working.
 */
export { shouldSkipReentrantSync };

/**
 * Format exchanges as the transcript text of a summarization prompt.
 *
 * Each exchange becomes a `User:` paragraph and an `Agent:` paragraph. The function joins the exchanges with a horizontal rule.
 */
export function formatConversationText(exchanges: ConversationExchange[]): string {
  return exchanges.map(ex => {
    return `User: ${ex.userMessage}\n\nAgent: ${ex.assistantMessage}`;
  }).join('\n\n---\n\n');
}

/**
 * Return the summary that a model answer contains.
 *
 * The function returns the trimmed text between the first `<summary>` tag and the next `</summary>` tag.
 * When the answer has no such pair, the function returns the trimmed answer.
 * The function throws an Error when the answer is not a string. The message says that the SDK call failed.
 */
export function extractSummary(text: string): string {
  // Reject a non-string input with a clear error. Without this check, the match call
  // below throws a TypeError.
  if (typeof text !== 'string') {
    throw new Error(
      `Summarizer returned no text (received ${text === undefined ? 'undefined' : typeof text}); the underlying SDK call failed.`,
    );
  }
  const match = text.match(/<summary>(.*?)<\/summary>/s);
  if (match) {
    return match[1].trim();
  }
  // Fallback if no tags found
  return text.trim();
}

/**
 * Build the prompt that summarizes a short conversation from its transcript text.
 *
 * The prompt carries the full transcript text.
 */
function buildShortSummaryPrompt(conversationText: string): string {
  return `${SUMMARIZER_CONTEXT_MARKER}.

Please write a concise, factual summary of this conversation. Output ONLY the summary - no preamble. Claude will see this summary when searching previous conversations for useful memories and information.

Summarize what happened in 2-4 sentences. Be factual and specific. Output in <summary></summary> tags.

Include:
- What was built/changed/discussed (be specific)
- Key technical decisions or approaches
- Problems solved or current state

Exclude:
- Apologies, meta-commentary, or your questions
- Raw logs or debug output
- Generic descriptions - focus on what makes THIS conversation unique

Good:
<summary>Built JWT authentication for React app with refresh tokens and protected routes. Fixed token expiration bug by implementing refresh-during-request logic.</summary>

Bad:
<summary>I apologize. The conversation discussed authentication and various approaches were considered...</summary>

${conversationText}`;
}

/**
 * Build the options object passed to the Claude Agent SDK's query() for a summarization call.
 *
 * persistSession: false stops the SDK from saving the session to ~/.claude/projects/.
 * No later call can resume the session. Without this option, each summary adds
 * a session to the IDE session sidebar (#83). The claude-agent-sdk type
 * declarations describe the option.
 */
export function buildSummarizerQueryOptions(args: {
  model: string;
}): Record<string, unknown> {
  const { model } = args;
  return {
    model,
    max_tokens: 4096,
    env: getApiEnv(),
    persistSession: false,
    // Run the summarizer subprocess in isolation. Without `settingSources: []`, the
    // SDK loads the user's filesystem settings. Those settings start the configured
    // MCP servers and run SessionStart hooks inside the summary subprocess.
    // `mcpServers: {}` adds a second guard that starts no MCP server.
    settingSources: [],
    mcpServers: {},
    systemPrompt: 'Write concise, factual summaries. Output ONLY the summary - no preamble, no "Here is", no "I will". Your output will be indexed directly.',
  };
}

/**
 * Return the prompt for one summary turn in a forked Codex session.
 *
 * The prompt contains no transcript. The forked session supplies the context.
 * The prompt tells the model not to inspect files, run commands, search the web or change state.
 * The prompt asks for one `<summary>` block. Pass the answer to extractSummary to read the block.
 */
export function buildCodexSummaryPrompt(): string {
  return `${SUMMARIZER_CONTEXT_MARKER}.

You are running in an ephemeral Codex fork of an existing session. Use the forked session context, including available reasoning summaries and thinking context, to write a concise, factual summary of the conversation.

Do not inspect files, run commands, search the web, or modify state. Use only the conversation context already available in this forked session.

Output ONLY a <summary></summary> block. Summarize what happened in 2-4 sentences.

Include:
- What was built/changed/discussed (be specific)
- Key technical decisions or approaches
- Problems solved or current state

Exclude:
- Apologies, meta-commentary, or your questions
- Raw logs or debug output
- Generic descriptions - focus on what makes THIS conversation unique

Good:
<summary>Built JWT authentication for React app with refresh tokens and protected routes. Fixed token expiration bug by implementing refresh-during-request logic.</summary>

Bad:
<summary>I apologize. The conversation discussed authentication and various approaches were considered...</summary>`;
}

/**
 * Build the command that starts a Codex app server for one summary.
 *
 * The executable is the `codexBin` argument. If the argument is empty or not set, the function uses the EPISODIC_MEMORY_CODEX_BIN variable. If the variable is also empty or not set, the executable is `codex`.
 *
 * The arguments are `app-server`. The result also holds the prompt, the session id and the model. The function starts no process.
 */
export function buildCodexSummarizerCommand(args: {
  sessionId: string;
  prompt: string;
  model?: string;
  codexBin?: string;
}): CodexSummarizerCommand {
  const command = args.codexBin || process.env.EPISODIC_MEMORY_CODEX_BIN || 'codex';

  return {
    command,
    args: ['app-server'],
    prompt: args.prompt,
    sessionId: args.sessionId,
    model: args.model,
  };
}

/**
 * Timeout (ms) for a single summarizer SDK call.
 * Configurable via EPISODIC_MEMORY_API_TIMEOUT_MS (also forwarded to the SDK env as API_TIMEOUT_MS).
 * Default 120s.
 */
function summarizerTimeoutMs(): number {
  const configured = Number(process.env.EPISODIC_MEMORY_API_TIMEOUT_MS);
  return Number.isFinite(configured) && configured > 0 ? configured : 120000;
}

/** Options for one Claude text call. Omitted values read the environment. */
export interface CallClaudeOptions {
  /** Model for the primary attempt. Default: `EPISODIC_MEMORY_API_MODEL || 'haiku'`. */
  model?: string;
  /** Model for the retry. Default: `EPISODIC_MEMORY_API_MODEL_FALLBACK || 'sonnet'`. */
  fallbackModel?: string;
  /** Start on the fallback model. */
  useFallback?: boolean;
}

async function callClaude(prompt: string, opts: CallClaudeOptions = {}): Promise<string> {
  const primaryModel = opts.model || process.env.EPISODIC_MEMORY_API_MODEL || 'haiku';
  const fallbackModel =
    opts.fallbackModel || process.env.EPISODIC_MEMORY_API_MODEL_FALLBACK || 'sonnet';
  const useFallback = opts.useFallback === true;
  const model = useFallback ? fallbackModel : primaryModel;

  // Bound the call. A stalled SDK subprocess would otherwise block the sync. Abort
  // through an AbortController after the timeout, and throw an error the caller can record.
  const controller = new AbortController();
  const timeoutMs = summarizerTimeoutMs();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    for await (const message of query({
      prompt,
      options: { ...buildSummarizerQueryOptions({ model }), abortController: controller } as any,
    })) {
      if (message && typeof message === 'object' && 'type' in message && message.type === 'result') {
        const m = message as any;
        const result = m.result;

        // Check if result is an API error (SDK returns errors as result strings)
        if (typeof result === 'string' && result.includes('API Error') && result.includes('thinking.budget_tokens')) {
          if (!useFallback) {
            // stderr only: this module is reachable from the MCP server, where
            // stdout is reserved for JSON-RPC (CLAUDE.md gotcha #1).
            console.error(`    ${primaryModel} hit thinking budget error, retrying with ${fallbackModel}`);
            clearTimeout(timer);
            return await callClaude(prompt, { model: primaryModel, fallbackModel, useFallback: true });
          }
          // If fallback also fails, return error message
          return result;
        }

        // The SDK signalled an error or returned no string result. Throw an error
        // that names the subtype, so the caller can record the failure.
        if (m.is_error === true || typeof result !== 'string') {
          throw new Error(
            `Summarizer SDK call failed (subtype=${m.subtype ?? 'unknown'}).`,
          );
        }

        return result;
      }
    }
    return '';
  } catch (err) {
    if (controller.signal.aborted) {
      throw new Error(`Summarizer SDK call timed out after ${timeoutMs}ms.`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Call Ollama, and retry once on a Claude model when the call fails.
 *
 * EPISODIC_MEMORY_OLLAMA_FALLBACK_MODEL names the retry model (for example `haiku`). When the variable is unset or blank, the Ollama error propagates.
 * A `GpuReservedError` always propagates, because a reservation must defer the work and not move it.
 */
async function callOllamaWithFallback(prompt: string, opts: OllamaCallOptions = {}): Promise<string> {
  try {
    return await callOllama(prompt, opts);
  } catch (err) {
    const fallback = (process.env.EPISODIC_MEMORY_OLLAMA_FALLBACK_MODEL || '').trim();
    if (!fallback || err instanceof GpuReservedError) throw err;
    console.error(`    ollama call failed (${(err as Error).message}); retrying with ${fallback}`);
    return callClaude(prompt, { model: fallback, fallbackModel: fallback });
  }
}

/**
 * Route a prompt to the configured backend (see ollama-backend.ts).
 *
 * `requireSummaryBlock` is true for the conversation-summary prompts. These prompts ask for a `<summary>` block.
 */
function callModel(prompt: string, requireSummaryBlock = true): Promise<string> {
  return summarizerBackend() === 'ollama'
    ? callOllamaWithFallback(prompt, { requireSummaryBlock })
    : callClaude(prompt, {
        model: process.env.EPISODIC_MEMORY_API_MODEL || 'haiku',
        fallbackModel: process.env.EPISODIC_MEMORY_API_MODEL_FALLBACK || 'sonnet',
      });
}

/** Digest entry point: same backend, model and fallback choice as session summaries. */
export function callDigestModel(prompt: string): Promise<string> {
  // The digest prompt asks for cited lines, not a <summary> block. parseCitedLines checks the reply.
  return callModel(prompt, false);
}

/**
 * Return the model and the retry model for learning calls.
 *
 * The learn model reads EPISODIC_MEMORY_LEARN_MODEL. The retry model reads EPISODIC_MEMORY_API_MODEL_FALLBACK, which the digest also reads. Both default to `sonnet`. A blank value counts as unset.
 *
 * callLearnModel uses these models for text-only learning calls when the backend is not ollama. The learn model does not change the digest model.
 *
 * @param env the variables to read. The default is process.env.
 */
export function resolveLearnModels(
  env: Record<string, string | undefined> = process.env
): { model: string; fallbackModel: string } {
  const model = (env.EPISODIC_MEMORY_LEARN_MODEL || '').trim() || 'sonnet';
  const fallbackModel = (env.EPISODIC_MEMORY_API_MODEL_FALLBACK || '').trim() || 'sonnet';
  return { model, fallbackModel };
}

/**
 * Learn entry point: the backend switch with the learn model.
 *
 * Text-only calls (task generation, learner split/merge, the recall judge) go
 * through here. A tool-using solver or learner is an SDK subprocess and does not
 * use this switch. The ollama backend makes text calls only.
 */
export function callLearnModel(prompt: string): Promise<string> {
  if (summarizerBackend() === 'ollama') {
    // Learn prompts ask for JSON or plain text, not a <summary> block. Each caller parses its reply.
    return callOllamaWithFallback(prompt, { requireSummaryBlock: false });
  }
  return callClaude(prompt, resolveLearnModels());
}

interface PendingAppServerRequest {
  method: string;
  resolve: (value: any) => void;
  reject: (error: Error) => void;
}

function appServerTimeoutMs(): number {
  const configured = Number(process.env.EPISODIC_MEMORY_CODEX_SUMMARY_TIMEOUT_MS);
  return Number.isFinite(configured) && configured > 0 ? configured : 120000;
}

function readCommandOutput(command: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env: getApiEnv(),
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let output = '';
    let settled = false;

    // Bound the probe, for example `codex --version`. A stalled binary must not hang
    // the summary loop. The probe uses the same timeout as the app-server run.
    const timeoutMs = appServerTimeoutMs();
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { child.kill('SIGTERM'); } catch {}
      reject(new Error(`${command} ${args.join(' ')} timed out after ${timeoutMs}ms: ${output.trim()}`));
    }, timeoutMs);

    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };

    child.stdout.on('data', chunk => {
      output += chunk.toString();
    });
    child.stderr.on('data', chunk => {
      output += chunk.toString();
    });
    child.on('error', err => settle(() => reject(err)));
    child.on('exit', code => settle(() => {
      if (code === 0) {
        resolve(output);
      } else {
        reject(new Error(`${command} ${args.join(' ')} failed with exit code ${code}: ${output.trim()}`));
      }
    }));
  });
}

async function assertSupportedCodexVersion(command: CodexSummarizerCommand): Promise<void> {
  if (command.skipVersionCheck) {
    return;
  }

  const output = await readCommandOutput(command.command, command.versionArgs || ['--version']);
  const version = parseCodexCliVersion(output);
  if (!version || !versionMeetsMinimum(version)) {
    throw new Error(codexVersionRequirementMessage(output));
  }
}

function requireThreadId(result: any, method: string): string {
  const threadId = result?.thread?.id;
  if (typeof threadId !== 'string' || !threadId) {
    throw new Error(`${method} returned unexpected response: ${JSON.stringify(result)}`);
  }
  return threadId;
}

function requireTurnId(result: any, method: string): string {
  const turnId = result?.turn?.id;
  if (typeof turnId !== 'string' || !turnId) {
    throw new Error(`${method} returned unexpected response: ${JSON.stringify(result)}`);
  }
  return turnId;
}

/**
 * Run one summary turn in a Codex app server and return the answer text.
 *
 * The function runs the version check first, unless the caller sets `skipVersionCheck`. The check runs `command.versionArgs`, or `--version` by default. The function rejects when the version is missing or below the supported minimum.
 *
 * The function starts `command.command` with `command.args`, using the environment from getApiEnv. The function forks the thread `command.sessionId` as an ephemeral, read-only thread. The function starts one turn with `command.prompt`.
 *
 * The returned promise resolves with the answer text when the turn completes. The function does not parse the text. Pass the text to extractSummary to read the `<summary>` block.
 *
 * The returned promise rejects in these cases:
 *
 * - the turn does not complete.
 * - the server answers a request with an error.
 * - the server exits early.
 * - the server writes a line that is not valid JSON.
 * - a process error occurs.
 * The promise also rejects when the run lasts longer than EPISODIC_MEMORY_CODEX_SUMMARY_TIMEOUT_MS milliseconds (default 120000). The version check uses the same timeout. After the server starts, the function sends SIGTERM to the server before the promise settles.
 */
export async function runCodexCommand(command: CodexSummarizerCommand): Promise<string> {
  await assertSupportedCodexVersion(command);

  return new Promise((resolve, reject) => {
    const child = spawn(command.command, command.args, {
      env: getApiEnv(),
      stdio: ['pipe', 'pipe', 'pipe']
    });

    let stderr = '';
    let answer = '';
    let nextRequestId = 1;
    let targetTurnId: string | undefined;
    let finished = false;
    let timeout: NodeJS.Timeout | undefined;
    const pending = new Map<number, PendingAppServerRequest>();
    const lines = createInterface({ input: child.stdout });

    child.stderr.on('data', chunk => {
      stderr += chunk.toString();
    });

    const cleanup = () => {
      if (timeout) {
        clearTimeout(timeout);
      }
      lines.close();
      // Reject any in-flight requests. Their awaiters, the initialize, fork and turn
      // steps in the IIFE below, do not wait forever when the child dies or times out.
      // The IIFE's catch calls finish(), which does nothing when the run already settled.
      for (const [, request] of pending) {
        request.reject(new Error('Codex app-server stream closed before response'));
      }
      pending.clear();
      if (!child.killed) {
        child.kill('SIGTERM');
      }
    };

    // Guard stdin writes: writing to a dead child can throw EPIPE synchronously on
    // some platforms. Without the guard, that error is an uncaught exception.
    const safeWrite = (payload: string) => {
      try {
        child.stdin.write(payload);
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)));
      }
    };

    const finish = (error: Error | undefined, result = '') => {
      if (finished) return;
      finished = true;
      cleanup();
      if (error) {
        reject(error);
      } else {
        resolve(result);
      }
    };

    timeout = setTimeout(() => {
      finish(new Error(`Codex summarizer timed out after ${appServerTimeoutMs()}ms: ${stderr.trim()}`));
    }, appServerTimeoutMs());

    const send = (method: string, params?: Record<string, unknown>): Promise<any> => {
      const id = nextRequestId++;
      const promise = new Promise<any>((resolveRequest, rejectRequest) => {
        pending.set(id, { method, resolve: resolveRequest, reject: rejectRequest });
      });
      safeWrite(JSON.stringify({ method, id, params }) + '\n');
      return promise;
    };

    const notify = (method: string, params?: Record<string, unknown>) => {
      const message = params === undefined ? { method } : { method, params };
      safeWrite(JSON.stringify(message) + '\n');
    };

    lines.on('line', line => {
      if (!line.trim()) return;

      let message: any;
      try {
        message = JSON.parse(line);
      } catch (error) {
        finish(new Error(`Codex app-server emitted invalid JSON: ${line}`));
        return;
      }

      if (typeof message.id === 'number' && pending.has(message.id)) {
        const request = pending.get(message.id)!;
        pending.delete(message.id);
        if (message.error) {
          request.reject(new Error(`${request.method} failed: ${JSON.stringify(message.error)}`));
        } else {
          request.resolve(message.result);
        }
        return;
      }

      if (message.method === 'item/agentMessage/delta') {
        answer += message.params?.delta ?? '';
        return;
      }

      if (message.method === 'item/completed' && message.params?.item?.type === 'agentMessage') {
        answer = message.params.item.text ?? answer;
        return;
      }

      if (
        message.method === 'turn/completed' &&
        (!targetTurnId || message.params?.turn?.id === targetTurnId)
      ) {
        if (message.params.turn.status === 'completed') {
          finish(undefined, answer);
        } else {
          const detail = message.params.turn.error?.message || message.params.turn.status;
          finish(new Error(`Codex summarizer turn did not complete: ${detail}`));
        }
      }
    });

    child.on('error', error => {
      finish(error);
    });

    child.on('exit', code => {
      if (!finished) {
        const detail = code === 0
          ? 'Codex app-server exited before the summary turn completed'
          : `Codex summarizer failed with exit code ${code}: ${stderr.trim()}`;
        finish(new Error(detail));
      }
    });

    (async () => {
      try {
        await send('initialize', {
          clientInfo: {
            name: 'episodic-memory',
            title: 'Episodic Memory',
            version: VERSION,
          },
          capabilities: {
            experimentalApi: true,
          },
        });
        notify('initialized');

        const fork = await send('thread/fork', {
          threadId: command.sessionId,
          ephemeral: true,
          sandbox: 'read-only',
          approvalPolicy: 'never',
          ...(command.model ? { model: command.model } : {}),
        });
        const forkThreadId = requireThreadId(fork, 'thread/fork');

        const turn = await send('turn/start', {
          threadId: forkThreadId,
          input: [{
            type: 'text',
            text: command.prompt,
            textElements: [],
          }],
        });
        targetTurnId = requireTurnId(turn, 'turn/start');
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)));
      }
    })();
  });
}

async function callCodex(prompt: string, sessionId: string, model?: string): Promise<string> {
  const command = buildCodexSummarizerCommand({ sessionId, prompt, model });
  return runCodexCommand(command);
}

function chunkExchanges(exchanges: ConversationExchange[], chunkSize: number): ConversationExchange[][] {
  const chunks: ConversationExchange[][] = [];
  for (let i = 0; i < exchanges.length; i += chunkSize) {
    chunks.push(exchanges.slice(i, i + chunkSize));
  }
  return chunks;
}

function getCodexSessionId(exchanges: ConversationExchange[], sessionId?: string): string | undefined {
  if (!exchanges.some(exchange => exchange.harness === 'codex')) {
    return undefined;
  }
  return sessionId || exchanges.find(exchange => exchange.sessionId)?.sessionId;
}

function getCodexModel(exchanges: ConversationExchange[]): string | undefined {
  return exchanges.find(exchange => exchange.harness === 'codex' && exchange.model)?.model;
}

/**
 * Summarize one conversation and return the summary text.
 *
 * The function returns `Trivial conversation with no substantive content.` without a model call when the conversation has no exchanges.
 * The function also returns that text for one exchange when its formatted text is under 100 characters.
 * The function also returns that text for one exchange whose user message is `/exit`.
 *
 * When some exchange comes from Codex and a session id is available, the function asks Codex for the summary first. The session id is the `sessionId` argument, or else the first session id found in the exchanges. When Codex fails, the function logs the error and uses the transcript path.
 *
 * The transcript path makes one model call for up to 15 exchanges. Any model error rejects the promise in this case.
 *
 * For more than 15 exchanges, the function summarizes each chunk of exchanges. The function then synthesizes the chunk summaries into one summary. The chunk size is 8 exchanges. A larger chunk size keeps the chunk count at 20 or less. The function logs a failed chunk and skips it. A failed synthesis returns the chunk summaries joined with a space. When no chunk succeeds, the function returns `Error: Unable to summarize conversation.` as the result.
 *
 * A GpuReservedError from a model call rejects the promise.
 *
 * The function writes its progress lines with console.log, so they go to stdout.
 *
 * @param sessionId the Codex session to fork. When the caller omits `sessionId`, the function uses the session id of the first exchange that has one.
 */
export async function summarizeConversation(exchanges: ConversationExchange[], sessionId?: string): Promise<string> {
  // Handle trivial conversations
  if (exchanges.length === 0) {
    return 'Trivial conversation with no substantive content.';
  }

  if (exchanges.length === 1) {
    const text = formatConversationText(exchanges);
    if (text.length < 100 || exchanges[0].userMessage.trim() === '/exit') {
      return 'Trivial conversation with no substantive content.';
    }
  }

  const codexSessionId = getCodexSessionId(exchanges, sessionId);
  if (codexSessionId) {
    try {
      const result = await callCodex(buildCodexSummaryPrompt(), codexSessionId, getCodexModel(exchanges));
      return extractSummary(result);
    } catch (error) {
      console.log(`  Codex summarizer unavailable, falling back to transcript text: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  // For up to 15 exchanges, summarize the transcript text in one model call.
  if (exchanges.length <= 15) {
    const result = await callModel(buildShortSummaryPrompt(formatConversationText(exchanges)));
    return extractSummary(result);
  }

  // For long conversations, use hierarchical summarization
  console.log(`  Long conversation (${exchanges.length} exchanges) - using hierarchical summarization`);

  // Split the conversation into chunks of 8 exchanges.

  // Use a larger chunk size when 8 would give more than 20 chunks.
  // The limit keeps the number of sequential model calls low.
  const MAX_HIERARCHICAL_CHUNKS = 20;
  const chunkSize = Math.max(8, Math.ceil(exchanges.length / MAX_HIERARCHICAL_CHUNKS));
  const chunks = chunkExchanges(exchanges, chunkSize);
  console.log(`  Split into ${chunks.length} chunks (chunk size ${chunkSize})`);

  // Summarize each chunk
  const chunkSummaries: string[] = [];
  for (let i = 0; i < chunks.length; i++) {
    const chunkText = formatConversationText(chunks[i]);
    const prompt = `${SUMMARIZER_CONTEXT_MARKER}.

Please write a concise summary of this part of a conversation in 2-3 sentences. What happened, what was built/discussed. Use <summary></summary> tags.

${chunkText}

Example: <summary>Implemented HID keyboard functionality for ESP32. Hit Bluetooth controller initialization error, fixed by adjusting memory allocation.</summary>`;

    try {
      const summary = await callModel(prompt); // No sessionId for chunks
      const extracted = extractSummary(summary);
      chunkSummaries.push(extracted);
      console.log(`  Chunk ${i + 1}/${chunks.length}: ${extracted.split(/\s+/).length} words`);
    } catch (error) {
      // A reserved GPU stops the whole summary: skipping the chunk would store a partial summary.
      if (error instanceof GpuReservedError) throw error;
      console.log(`  Chunk ${i + 1} failed, skipping`);
    }
  }

  if (chunkSummaries.length === 0) {
    return 'Error: Unable to summarize conversation.';
  }

  // Synthesize chunks into final summary
  const synthesisPrompt = `${SUMMARIZER_CONTEXT_MARKER}.

Please write a concise, factual summary that synthesizes these part-summaries into one cohesive paragraph. Focus on what was accomplished and any notable technical decisions or challenges. Output in <summary></summary> tags. Claude will see this summary when searching previous conversations for useful memories and information.

Part summaries:
${chunkSummaries.map((s, i) => `${i + 1}. ${s}`).join('\n')}

Good:
<summary>Built conversation search system with JavaScript, sqlite-vec, and local embeddings. Implemented hierarchical summarization for long conversations. System archives conversations permanently and provides semantic search via CLI.</summary>

Bad:
<summary>This conversation synthesizes several topics discussed across multiple parts...</summary>

Your summary (max 200 words):`;

  console.log(`  Synthesizing final summary...`);
  try {
    const result = await callModel(synthesisPrompt); // No sessionId for synthesis
    return extractSummary(result);
  } catch (error) {
    if (error instanceof GpuReservedError) throw error;
    console.log(`  Synthesis failed, using chunk summaries`);
    return chunkSummaries.join(' ');
  }
}
