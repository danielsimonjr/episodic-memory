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
import { type McpSdkServerConfigWithInstance, type SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import type { AttemptOutcome, Cost, TraceStep } from './types.js';
/** The tool names an isolated agent may never reach. */
export declare const DISALLOWED_TOOLS: string[];
/**
 * Where a run records the PIDs it owns.
 * The learn lock supplies the real registry. The registry also writes `.learn.pids`, so the orphan
 * reaper leaves a live run alone.
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
    /** The result of `claudeExecutableOption()`. Empty selects the bundled binary. */
    executable?: {
        pathToClaudeCodeExecutable?: string;
    };
}
/**
 * The options object handed to the SDK's `query()`.
 *
 * `tools: []` is the actual isolation. No built-in tool is even offered.
 * The `disallowedTools` list is a second safeguard, so a future SDK default cannot
 * reintroduce a built-in tool. `canUseTool` denies anything that is not a served name.
 * That rule also covers a same-named tool from another server.
 */
export declare function buildAgentQueryOptions(args: BuildAgentQueryOptionsArgs): Record<string, unknown>;
/**
 * One process from a process listing, with its id, its parent id when known, and its command line.
 */
export interface ProcSnapshot {
    pid: number;
    ppid?: number;
    commandLine: string;
}
/** True when a command line is one of the SDK's own spawn-tree shapes. */
export declare function isAgentSpawnTree(commandLine: string): boolean;
/**
 * The machine's `claude` processes, or null when enumeration fails.
 *
 * The listing runs as a child process and the function awaits it, so a slow listing never blocks
 * the event loop. On Windows one listing takes most of a second.
 * Null means that the run registers nothing during this poll.
 * A run that cannot see its children is better off with a short `.learn.pids` than with a wrong one.
 */
export declare function listAgentProcesses(): Promise<ProcSnapshot[] | null>;
/** A process lister. The real one is async. A test seam can answer at once. */
export type ProcessLister = () => ProcSnapshot[] | null | Promise<ProcSnapshot[] | null>;
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
    /** The executable option. The default is `claudeExecutableOption()`, which can throw `ClaudeBinError`. */
    executable?: {
        pathToClaudeCodeExecutable?: string;
    };
    /** Test seam: the SDK's `query` by default. */
    queryFn?: (params: {
        prompt: string;
        options: Record<string, unknown>;
    }) => AsyncIterable<SDKMessage>;
    /** Test seam: defaults to `listAgentProcesses`. */
    processLister?: ProcessLister;
    /**
     * Milliseconds between two listings of the spawn tree. The default is `EPISODIC_MEMORY_LEARN_PID_POLL_MS`.
     * Concurrent runs that share one registry share one poll. The interval of the first run applies.
     */
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
/** The address a tool result names, or null. Text is never stored. */
export declare function addressFromResultText(text: string): string | null;
/**
 * True when the failure was the subprocess dying by a signal rather than returning an error result.
 * The SDK surfaces a signal death as an error whose message (or `signal` field) names a signal.
 * `killed` is the outcome that keeps such an attempt out of diagnosis (spec §7 rule 11).
 */
export declare function looksKilled(error: unknown): boolean;
/**
 * Run one agent to completion.
 *
 * The timeout aborts the SDK call the way `callClaude` does.
 * The spawn-tree poll registers the SDK's own children. A background reaper leaves those
 * children alone while the run is live.
 * Result text is deliberately not stored. A trace records the address that a tool returned,
 * and the amount of text in that result.
 * The diagnose step needs that information and nothing that a later prompt could leak.
 */
export declare function runAgent(options: AgentRunOptions): Promise<AgentRunResult>;
