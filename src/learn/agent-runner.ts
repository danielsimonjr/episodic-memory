/**
 * The agent runner: one isolated Claude Agent SDK subprocess.
 *
 * This module and `sdk-tools.ts` are the only learn modules that import the SDK.
 * Its options builder is the twin of `buildSummarizerQueryOptions` in
 * `summarizer.ts`, with the isolation of spec §7 rule 9 added: no built-in tools,
 * no settings sources, no `.mcp.json`, no persisted session, and exactly one MCP
 * server — the in-process `episodic-learn` one. If the two builders drift, a
 * solver can quietly recover a tool it was never meant to have, so keep the shapes
 * recognisably parallel.
 *
 * `runAgent` adds what a caller needs from a run: an abort timeout, the tool list
 * the subprocess was actually granted, a trace of addresses (never result text),
 * the cost, and an outcome that says whether the attempt may be graded at all.
 */

import { execFileSync } from 'node:child_process';
import {
  query as sdkQuery,
  type McpSdkServerConfigWithInstance,
  type SDKMessage,
} from '@anthropic-ai/claude-agent-sdk';
import { getApiEnv } from '../summarizer.js';
import type { AttemptOutcome, Cost, TraceStep } from './types.js';
import { servedToolNames } from './sdk-tools.js';

/** The tool names an isolated agent may never reach. */
export const DISALLOWED_TOOLS = [
  'Bash',
  'Read',
  'Write',
  'Edit',
  'WebFetch',
  'WebSearch',
  'Agent',
  'Skill',
  'Glob',
  'Grep',
];

/**
 * Where a run records the PIDs it owns. Task 6 supplies the real one, which also
 * writes `.learn.pids` so the orphan reaper leaves a live run alone.
 */
export interface PidRegistry {
  add(pid: number): void;
  remove(pid: number): void;
}

/**
 * The inputs to `buildAgentQueryOptions`.
 */
export interface BuildAgentQueryOptionsArgs {
  server: McpSdkServerConfigWithInstance;
  allowPropose: boolean;
  maxTurns: number;
  maxBudgetUsd: number;
  model: string;
  abortController: AbortController;
  systemPrompt: string;
}

/**
 * The options object handed to the SDK's `query()`.
 *
 * `tools: []` is the actual isolation (nothing built in is even offered); the
 * `disallowedTools` list is belt-and-suspenders so a future SDK default cannot
 * reintroduce one. `canUseTool` denies anything that is not a served name, which
 * covers a same-named tool from another server.
 */
export function buildAgentQueryOptions(
  args: BuildAgentQueryOptionsArgs
): Record<string, unknown> {
  const allowed = new Set(servedToolNames(args.allowPropose));

  return {
    model: args.model,
    maxTurns: args.maxTurns,
    maxBudgetUsd: args.maxBudgetUsd,
    env: getApiEnv() ?? {},
    tools: [],
    disallowedTools: [...DISALLOWED_TOOLS],
    strictMcpConfig: true,
    settingSources: [],
    persistSession: false,
    mcpServers: { 'episodic-learn': args.server },
    allowedTools: ['mcp__episodic-learn__*'],
    systemPrompt: args.systemPrompt,
    abortController: args.abortController,
    canUseTool: async (toolName: string) =>
      allowed.has(toolName)
        ? { behavior: 'allow' as const }
        : {
            behavior: 'deny' as const,
            message: `${toolName} is not available in this run. Use the episodic-learn tools only.`,
          },
  };
}

// ---------------------------------------------------------------------------
// PID registration
// ---------------------------------------------------------------------------

/**
 * One process from a process listing, with its id, its parent id when known, and its command line.
 */
export interface ProcSnapshot {
  pid: number;
  ppid?: number;
  commandLine: string;
}

// The same three shapes `orphan-reaper.ts` reaps. Duplicated here on purpose:
// Task 6 adds a `protectedPids` parameter to that module, and this module only
// needs to recognise the children so it can register them.
const DAEMON = /\bdaemon\s+run\b[\s\S]*--origin\s+transient/;
const PTYHOST = /--bg-pty-host\b/;
const FORK = /--fork-session\b/;

/** True when a command line is one of the SDK's own spawn-tree shapes. */
export function isAgentSpawnTree(commandLine: string): boolean {
  return DAEMON.test(commandLine) || PTYHOST.test(commandLine) || FORK.test(commandLine);
}

/**
 * The machine's `claude` processes, or null when enumeration fails.
 *
 * Null means "register nothing this poll": a run that cannot see its children is
 * better off with a short `.learn.pids` than with a wrong one.
 */
export function listAgentProcesses(): ProcSnapshot[] | null {
  try {
    if (process.platform !== 'win32') {
      const out = execFileSync('ps', ['-eo', 'pid=,ppid=,args='], { encoding: 'utf8', timeout: 15000 });
      return out
        .split('\n')
        .map(line => line.trim())
        .filter(Boolean)
        .map(line => {
          const first = line.indexOf(' ');
          const rest = line.slice(first + 1);
          const second = rest.indexOf(' ');
          const pid = Number(line.slice(0, first));
          const ppid = Number(rest.slice(0, second));
          return {
            pid,
            ppid: Number.isFinite(ppid) ? ppid : undefined,
            commandLine: rest.slice(second + 1),
          };
        })
        .filter(proc => Number.isFinite(proc.pid) && /claude/i.test(proc.commandLine));
    }
    const script =
      "Get-CimInstance Win32_Process -Filter \"Name='claude.exe'\" | " +
      'Select-Object ProcessId,ParentProcessId,CommandLine | ConvertTo-Json -Compress';
    const out = execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], {
      encoding: 'utf8',
      timeout: 20000,
    });
    const raw = JSON.parse(out || '[]') as
      | { ProcessId: number; ParentProcessId?: number; CommandLine?: string }
      | Array<{ ProcessId: number; ParentProcessId?: number; CommandLine?: string }>;
    const rows = Array.isArray(raw) ? raw : [raw];
    return rows.filter(Boolean).map(row => ({
      pid: row.ProcessId,
      ppid: row.ParentProcessId,
      commandLine: row.CommandLine || '',
    }));
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// runAgent
// ---------------------------------------------------------------------------

/**
 * The inputs to `runAgent`. The `queryFn` and `processLister` fields are test seams.
 */
export interface AgentRunOptions {
  prompt: string;
  systemPrompt: string;
  server: McpSdkServerConfigWithInstance;
  allowPropose: boolean;
  maxTurns: number;
  maxBudgetUsd: number;
  timeoutMs: number;
  model: string;
  pids?: PidRegistry;
  /** Test seam: the SDK's `query` by default. */
  queryFn?: (params: { prompt: string; options: Record<string, unknown> }) => AsyncIterable<SDKMessage>;
  /** Test seam: defaults to `listAgentProcesses`. */
  processLister?: () => ProcSnapshot[] | null;
  /** How often the spawn tree is polled while the agent runs. */
  pollMs?: number;
}

/**
 * What one `runAgent` call returns: the final text, the trace, the cost, and the outcome.
 */
export interface AgentRunResult {
  text: string;
  trace: TraceStep[];
  cost: Cost;
  outcome: AttemptOutcome;
  /** The tool list from the init message: what the subprocess was actually given. */
  toolsSeen: string[];
}

const DEFAULT_TIMEOUT_MS = 300_000;
const DEFAULT_POLL_MS = 1_000;

function emptyCost(): Cost {
  return { turns: 0, inputTokens: 0, outputTokens: 0, usd: null };
}

/** Thrown internally when the timeout has fired, so the catch reports `aborted`. */
class AbortMarker extends Error {
  constructor() {
    super('Agent run aborted.');
    this.name = 'AbortMarker';
  }
}

/** The address a tool result names, or null. Text is never stored. */
export function addressFromResultText(text: string): string | null {
  if (!text) return null;
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (line.startsWith('path:')) return line.slice('path:'.length).trim();
    if (line.includes('archive_path')) {
      const match = line.match(/archive_path"?\s*[:=]\s*"?([^",\s]+)/);
      if (match) return match[1];
    }
  }
  return null;
}

/** Every text block of a Messages-API content value. */
function resultTextOf(block: any): string {
  const content = block?.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part: any) => (part && typeof part.text === 'string' ? part.text : ''))
      .join('\n');
  }
  return '';
}

function costFromResult(message: any): Cost {
  const usage = message?.usage ?? {};
  const inputTokens = Number(usage.input_tokens ?? 0) + Number(usage.cache_read_input_tokens ?? 0);
  const outputTokens = Number(usage.output_tokens ?? 0);
  const usd = typeof message?.total_cost_usd === 'number' ? message.total_cost_usd : null;
  return {
    turns: Number(message?.num_turns ?? 0),
    inputTokens: Number.isFinite(inputTokens) ? inputTokens : 0,
    outputTokens: Number.isFinite(outputTokens) ? outputTokens : 0,
    usd,
  };
}

/**
 * True when the failure was the subprocess dying by a signal rather than
 * returning an error result. The SDK surfaces this as an error whose message (or
 * `signal` field) names a signal, and `killed` is the outcome that keeps such an
 * attempt out of diagnosis (spec §7 rule 11).
 */
export function looksKilled(error: unknown): boolean {
  const candidate = error as { signal?: unknown; message?: unknown; code?: unknown } | null;
  if (!candidate) return false;
  if (typeof candidate.signal === 'string' && /^SIG[A-Z]+$/.test(candidate.signal)) return true;
  if (typeof candidate.code === 'string' && /^SIG[A-Z]+$/.test(candidate.code)) return true;
  const message = typeof candidate.message === 'string' ? candidate.message : '';
  return /\b(?:killed|SIGKILL|SIGTERM|SIGINT|signal)\b/i.test(message);
}

/**
 * Run one agent to completion.
 *
 * The timeout aborts the SDK call the way `callClaude` does; the spawn-tree poll
 * registers the SDK's own children so a background reaper leaves them alone while
 * the run is live. Result text is deliberately not stored: a trace records the
 * address a tool returned and how much text it was, which is what the diagnose
 * step needs and nothing a later prompt could leak.
 */
export async function runAgent(options: AgentRunOptions): Promise<AgentRunResult> {
  const queryFn = options.queryFn ?? (sdkQuery as AgentRunOptions['queryFn'] as any);
  const lister = options.processLister ?? listAgentProcesses;
  const pollMs = options.pollMs ?? DEFAULT_POLL_MS;
  const timeoutMs = options.timeoutMs > 0 ? options.timeoutMs : DEFAULT_TIMEOUT_MS;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  const trace: TraceStep[] = [];
  const byToolUseId = new Map<string, TraceStep>();
  let toolsSeen: string[] = [];
  let cost = emptyCost();
  let text = '';
  let outcome: AttemptOutcome = 'error';

  // The spawn tree, tracked by poll. The SDK exposes no PID accessor, so the
  // direct `claude` child is found by its parent (this process) and the
  // plumbing below it by its command line. `baseline` is what existed before
  // this run, so a long-lived session of the user's is never registered as ours.
  const baseline = new Set<number>((lister() ?? []).map(proc => proc.pid));
  const registered = new Set<number>();
  const poll = (): void => {
    if (!options.pids) return;
    const procs = lister();
    if (!procs) return;
    const live = new Set(procs.map(proc => proc.pid));
    const byPid = new Map(procs.map(proc => [proc.pid, proc]));

    /** True when `pid` descends from this process or from a registered child. */
    const isOurs = (pid: number): boolean => {
      let cursor = pid;
      for (let depth = 0; depth < 32; depth++) {
        const proc = byPid.get(cursor);
        if (!proc) return false;
        const parent = proc.ppid;
        if (parent === process.pid) return true;
        if (parent === undefined || !Number.isFinite(parent) || parent <= 0) return false;
        if (registered.has(parent)) return true;
        cursor = parent;
      }
      return false;
    };

    // Repeat until stable: a child found this pass can make its own children
    // ours in the same pass, so a single sweep may miss a deeper layer.
    let changed = true;
    while (changed) {
      changed = false;
      for (const proc of procs) {
        if (baseline.has(proc.pid) || registered.has(proc.pid)) continue;
        if (!isOurs(proc.pid) && !isAgentSpawnTree(proc.commandLine)) continue;
        registered.add(proc.pid);
        options.pids.add(proc.pid);
        changed = true;
      }
    }

    for (const pid of [...registered]) {
      if (!live.has(pid)) {
        registered.delete(pid);
        options.pids.remove(pid);
      }
    }
  };
  poll();
  const pollTimer = setInterval(poll, pollMs);
  if (typeof pollTimer.unref === 'function') pollTimer.unref();

  try {
    for await (const message of queryFn({
      prompt: options.prompt,
      options: buildAgentQueryOptions({
        server: options.server,
        allowPropose: options.allowPropose,
        maxTurns: options.maxTurns,
        maxBudgetUsd: options.maxBudgetUsd,
        model: options.model,
        abortController: controller,
        systemPrompt: options.systemPrompt,
      }),
    })) {
      // A live SDK call throws on abort; an injected stream may not, so the
      // timeout is honoured here too rather than only in the catch below.
      if (controller.signal.aborted) throw new AbortMarker();
      const typed = message as any;

      if (typed?.type === 'system' && typed?.subtype === 'init') {
        toolsSeen = Array.isArray(typed.tools) ? typed.tools.map(String) : [];
        continue;
      }

      if (typed?.type === 'assistant') {
        const blocks = typed?.message?.content;
        if (Array.isArray(blocks)) {
          for (const block of blocks) {
            if (block?.type === 'tool_use') {
              const step: TraceStep = {
                tool: String(block.name ?? ''),
                args: block.input ?? {},
                resultAddress: null,
                resultChars: 0,
              };
              trace.push(step);
              if (typeof block.id === 'string') byToolUseId.set(block.id, step);
            }
          }
        }
        continue;
      }

      if (typed?.type === 'user') {
        const blocks = typed?.message?.content;
        if (Array.isArray(blocks)) {
          for (const block of blocks) {
            if (block?.type !== 'tool_result') continue;
            const step = byToolUseId.get(String(block.tool_use_id ?? ''));
            if (!step) continue;
            const resultText = resultTextOf(block);
            step.resultAddress = addressFromResultText(resultText);
            step.resultChars = resultText.length;
          }
        }
        continue;
      }

      if (typed?.type === 'result') {
        if (controller.signal.aborted) throw new AbortMarker();
        cost = costFromResult(typed);
        if (typeof typed.result === 'string') text = typed.result;
        outcome = typed.is_error === true ? 'error' : 'graded';
      }
    }
    // A stream that ends without a result message is an error, not a grade.
    if (outcome === 'error' && !text) outcome = 'error';
  } catch (error) {
    if (controller.signal.aborted || error instanceof AbortMarker) {
      outcome = 'aborted';
      text = `Agent run timed out after ${timeoutMs}ms.`;
    } else if (looksKilled(error)) {
      outcome = 'killed';
      text = `Agent subprocess was killed: ${error instanceof Error ? error.message : String(error)}`;
    } else {
      outcome = 'error';
      text = `Agent run failed: ${error instanceof Error ? error.message : String(error)}`;
    }
  } finally {
    clearTimeout(timer);
    clearInterval(pollTimer);
    if (options.pids) {
      for (const pid of registered) options.pids.remove(pid);
      registered.clear();
    }
  }

  return { text, trace, cost, outcome, toolsSeen };
}
