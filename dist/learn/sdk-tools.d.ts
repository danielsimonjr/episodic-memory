/**
 * The in-process `episodic-learn` MCP server a solver or learner subprocess sees.
 *
 * One of the two learn modules allowed to import the Claude Agent SDK (the other
 * is `agent-runner.ts`). Everything the server exposes is read-only except
 * `propose_entry`, which hands a proposal to the orchestrator and writes nothing:
 * validation and storage happen in Node, never in the model (spec §4.2, §7 rule 9).
 *
 * The handlers it registers are the ones in `learn-handlers.ts`; this module is
 * only the SDK surface, so a test can exercise the handlers without an SDK.
 */
import { type McpSdkServerConfigWithInstance } from '@anthropic-ai/claude-agent-sdk';
import type { ProposedEntry } from './types.js';
/** The name of the in-process MCP server. The tool names below include the server name, as `mcp__episodic-learn__`. */
export declare const SERVER_NAME = "episodic-learn";
/** The four tools every agent gets, fully qualified as an SDK `allowedTools` entry. */
export declare const SERVED_TOOL_NAMES: readonly ["mcp__episodic-learn__search", "mcp__episodic-learn__read", "mcp__episodic-learn__digest", "mcp__episodic-learn__skills"];
/** The write-shaped exception: learners and bootstrappers only. The write-shaped exception stores nothing. */
export declare const PROPOSE_TOOL_NAME = "mcp__episodic-learn__propose_entry";
/** The exact tool list that a run's agent can see. */
export declare function servedToolNames(allowPropose: boolean): string[];
/** What the server says when a caller hands over a proposal, or drops one, without writing. */
export declare const PROPOSAL_RECEIVED_MESSAGE = "Proposal received. The orchestrator validates it; nothing was written by this tool.";
/**
 * The settings that `buildLearnToolServer` needs for one agent.
 */
export interface LearnToolServerOptions {
    /** The project key whose digest and skills this agent sees. */
    project: string;
    /** Exchange ids that must never appear in any tool output (the task's answer). */
    hideExchangeIds: string[];
    /** Register `propose_entry` at all. */
    allowPropose: boolean;
    /** Called once per valid proposal. Never awaited for storage. */
    onPropose?: (proposal: ProposedEntry) => void;
}
/**
 * Build the server.
 *
 * `tool()` takes a raw Zod shape (`{ query: z.string() }`), not a `z.object`.
 * So the schemas below are plain shape objects.
 */
export declare function buildLearnToolServer(options: LearnToolServerOptions): McpSdkServerConfigWithInstance;
