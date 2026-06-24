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

export interface CodexSummarizerCommand {
  command: string;
  args: string[];
  prompt: string;
  sessionId: string;
  model?: string;
  versionArgs?: string[];
  skipVersionCheck?: boolean;
}

/**
 * Get API environment overrides for summarization calls.
 * Returns full env merged with process.env so subprocess inherits PATH, HOME, etc.
 *
 * Env vars (all optional):
 * - EPISODIC_MEMORY_API_MODEL: Model to use (default: haiku)
 * - EPISODIC_MEMORY_API_MODEL_FALLBACK: Fallback model on error (default: sonnet)
 * - EPISODIC_MEMORY_API_BASE_URL: Custom API endpoint
 * - EPISODIC_MEMORY_API_TOKEN: Auth token for custom endpoint
 * - EPISODIC_MEMORY_API_TIMEOUT_MS: Timeout for API calls (default: SDK default)
 */
export function getApiEnv(): Record<string, string | undefined> | undefined {
  const baseUrl = process.env.EPISODIC_MEMORY_API_BASE_URL;
  const token = process.env.EPISODIC_MEMORY_API_TOKEN;
  const timeoutMs = process.env.EPISODIC_MEMORY_API_TIMEOUT_MS;

  // Always include the reentrancy guard so the SDK-spawned Claude subprocess
  // (which inherits this env) marks itself as a reentrant context. The
  // SessionStart hook checks the guard via shouldSkipReentrantSync() and
  // exits before launching another sync, breaking the recursive cascade
  // reported in #87.
  return {
    ...process.env,
    [SUMMARIZER_GUARD_ENV]: '1',
    ...(baseUrl && { ANTHROPIC_BASE_URL: baseUrl }),
    ...(token && { ANTHROPIC_AUTH_TOKEN: token }),
    ...(timeoutMs && { API_TIMEOUT_MS: timeoutMs }),
  };
}

// Re-exported from the dependency-free reentrancy module so existing importers
// (and tests) can keep importing it from here. The guard check itself lives in
// ./reentrancy.js so sync-cli can use it without loading this module's SDK deps.
export { shouldSkipReentrantSync };

export function formatConversationText(exchanges: ConversationExchange[]): string {
  return exchanges.map(ex => {
    return `User: ${ex.userMessage}\n\nAgent: ${ex.assistantMessage}`;
  }).join('\n\n---\n\n');
}

export function extractSummary(text: string): string {
  // Guard against a non-string input. callClaude can return undefined when the
  // SDK signals an error (e.g. resuming a session that no longer exists). Without
  // this guard the line below crashed with the cryptic "Cannot read properties of
  // undefined (reading 'match')", which masked the real failure and let the sync
  // backlog retry forever.
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
 * Build the prompt for summarizing a short conversation from its transcript text.
 *
 * The summarizer used to prefer resuming the original session (sending an empty
 * body, letting the resumed context supply the transcript). That path was removed:
 * resume always fails from the background-sync context because the SDK resolves a
 * session by the subprocess's CWD-derived project dir (the plugin dir), not the
 * user's project — so every resume spawned a doomed subprocess and fell back here
 * anyway. We now always summarize the transcript text we already hold.
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
 * Build the options object passed to the Claude Agent SDK's query() for a
 * summarization call.
 *
 * persistSession: false keeps the SDK from writing its session transcript to
 * ~/.claude/projects/ (#83). Without it, every summarization spawns a fake
 * session JSONL that pollutes the IDE session sidebar. The option is honored
 * by claude-agent-sdk >= 0.2.0.
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
    // Run the summarizer subprocess in full isolation. Without `settingSources: []`
    // the SDK loads the user's filesystem settings, which boots every configured
    // MCP server AND fires SessionStart hooks inside each summary subprocess — the
    // process cascade behind the wedged-orphan storm (each hung subprocess spawned
    // a tree of ~14 children). `[]` also means no tools are available, so the model
    // simply answers. `mcpServers: {}` is belt-and-suspenders on top of that.
    settingSources: [],
    mcpServers: {},
    systemPrompt: 'Write concise, factual summaries. Output ONLY the summary - no preamble, no "Here is", no "I will". Your output will be indexed directly.',
  };
}

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
 * Timeout (ms) for a single summarizer SDK call. Configurable via
 * EPISODIC_MEMORY_API_TIMEOUT_MS (also forwarded to the SDK env as API_TIMEOUT_MS).
 * Default 120s.
 */
function summarizerTimeoutMs(): number {
  const configured = Number(process.env.EPISODIC_MEMORY_API_TIMEOUT_MS);
  return Number.isFinite(configured) && configured > 0 ? configured : 120000;
}

async function callClaude(prompt: string, useFallback = false): Promise<string> {
  const primaryModel = process.env.EPISODIC_MEMORY_API_MODEL || 'haiku';
  const fallbackModel = process.env.EPISODIC_MEMORY_API_MODEL_FALLBACK || 'sonnet';
  const model = useFallback ? fallbackModel : primaryModel;

  // Bound the call: a stalled SDK subprocess must not wedge the sync forever (the
  // root cause of the orphaned-process storm). Abort via an AbortController after
  // the timeout and surface a clear error the caller can record.
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
            console.log(`    ${primaryModel} hit thinking budget error, retrying with ${fallbackModel}`);
            clearTimeout(timer);
            return await callClaude(prompt, true);
          }
          // If fallback also fails, return error message
          return result;
        }

        // The SDK signalled an error rather than producing text (e.g. subtype
        // 'error_during_execution', is_error true, no `result` field). Throw a
        // clear, actionable error instead of returning undefined — the caller
        // records it so the conversation can be retried or sentinel-skipped.
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

    // Bound the probe (e.g. `codex --version`): a wedged binary must not hang the
    // whole summary loop (F7). Mirror the app-server turn timeout.
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
      // Reject any in-flight requests so their awaiters (the initialize/fork/turn
      // chain in the IIFE below) don't dangle forever when the child dies or times
      // out (F8). The IIFE's catch re-routes to finish(), which is idempotent.
      for (const [, request] of pending) {
        request.reject(new Error('Codex app-server stream closed before response'));
      }
      pending.clear();
      if (!child.killed) {
        child.kill('SIGTERM');
      }
    };

    // Guard stdin writes: writing to a dead child throws EPIPE synchronously on
    // some platforms, which would otherwise be an uncaught exception (F8).
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

  // For short conversations (≤15 exchanges), summarize the transcript text
  // directly. (We no longer attempt to resume the original session — see
  // buildShortSummaryPrompt: resume always failed from the background-sync
  // context and only spawned a doomed subprocess.)
  if (exchanges.length <= 15) {
    const result = await callClaude(buildShortSummaryPrompt(formatConversationText(exchanges)));
    return extractSummary(result);
  }

  // For long conversations, use hierarchical summarization
  console.log(`  Long conversation (${exchanges.length} exchanges) - using hierarchical summarization`);

  // Note: Hierarchical summarization doesn't support resume mode (needs fresh session for each chunk)
  // This is fine since we only use resume for the main session-end hook

  // Chunk into groups of ~8 exchanges, but cap the chunk COUNT so a very long
  // conversation can't fan out an unbounded number of sequential SDK calls (F14).
  // Above the cap we grow the chunk size instead of adding chunks.
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
      const summary = await callClaude(prompt); // No sessionId for chunks
      const extracted = extractSummary(summary);
      chunkSummaries.push(extracted);
      console.log(`  Chunk ${i + 1}/${chunks.length}: ${extracted.split(/\s+/).length} words`);
    } catch (error) {
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
    const result = await callClaude(synthesisPrompt); // No sessionId for synthesis
    return extractSummary(result);
  } catch (error) {
    console.log(`  Synthesis failed, using chunk summaries`);
    return chunkSummaries.join(' ');
  }
}
