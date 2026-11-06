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
 * Where a run records the PIDs it owns. Task 6 supplies the real one, which also
 * writes `.learn.pids` so the orphan reaper leaves a live run alone.
 */
export interface PidRegistry {
    add(pid: number): void;
    remove(pid: number): void;
}
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
export declare function buildAgentQueryOptions(args: BuildAgentQueryOptionsArgs): Record<string, unknown>;
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
 * Null means "register nothing this poll": a run that cannot see its children is
 * better off with a short `.learn.pids` than with a wrong one.
 */
export declare function listAgentProcesses(): ProcSnapshot[] | null;
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
    queryFn?: (params: {
        prompt: string;
        options: Record<string, unknown>;
    }) => AsyncIterable<SDKMessage>;
    /** Test seam: defaults to `listAgentProcesses`. */
    processLister?: () => ProcSnapshot[] | null;
    /** How often the spawn tree is polled while the agent runs. */
    pollMs?: number;
}
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
 * True when the failure was the subprocess dying by a signal rather than
 * returning an error result. The SDK surfaces this as an error whose message (or
 * `signal` field) names a signal, and `killed` is the outcome that keeps such an
 * attempt out of diagnosis (spec §7 rule 11).
 */
export declare function looksKilled(error: unknown): boolean;
/**
 * Run one agent to completion.
 *
 * The timeout aborts the SDK call the way `callClaude` does; the spawn-tree poll
 * registers the SDK's own children so a background reaper leaves them alone while
 * the run is live. Result text is deliberately not stored: a trace records the
 * address a tool returned and how much text it was, which is what the diagnose
 * step needs and nothing a later prompt could leak.
 */
export declare function runAgent(options: AgentRunOptions): Promise<AgentRunResult>;
