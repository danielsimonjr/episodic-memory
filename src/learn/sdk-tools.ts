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

import { z } from 'zod';
import {
  createSdkMcpServer,
  tool,
  type McpSdkServerConfigWithInstance,
  type SdkMcpToolDefinition,
} from '@anthropic-ai/claude-agent-sdk';
import {
  learnDigest,
  learnRead,
  learnSearch,
  learnSkills,
  type LearnDigestContext,
  type LearnContext,
} from './learn-handlers.js';
import type { ProposedEntry } from './types.js';

export const SERVER_NAME = 'episodic-learn';

/** The four tools every agent gets, fully qualified as an SDK `allowedTools` entry. */
export const SERVED_TOOL_NAMES = [
  'mcp__episodic-learn__search',
  'mcp__episodic-learn__read',
  'mcp__episodic-learn__digest',
  'mcp__episodic-learn__skills',
] as const;

/** The write-shaped exception: learners and bootstrappers only, and it stores nothing. */
export const PROPOSE_TOOL_NAME = 'mcp__episodic-learn__propose_entry';

/** The exact tool list a run's agent is allowed to see. */
export function servedToolNames(allowPropose: boolean): string[] {
  return allowPropose ? [...SERVED_TOOL_NAMES, PROPOSE_TOOL_NAME] : [...SERVED_TOOL_NAMES];
}

/** What the server says when a proposal was handed over (or dropped) without writing. */
export const PROPOSAL_RECEIVED_MESSAGE =
  'Proposal received. The orchestrator validates it; nothing was written by this tool.';

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

/** A successful MCP tool result. */
function ok(text: string): { content: Array<{ type: 'text'; text: string }> } {
  return { content: [{ type: 'text', text }] };
}

/** A failed MCP tool result. Errors are text, not thrown, so the model can react. */
function fail(text: string): { content: Array<{ type: 'text'; text: string }>; isError: true } {
  return { content: [{ type: 'text', text }], isError: true };
}

function errorText(error: unknown): string {
  return `Error: ${error instanceof Error ? error.message : String(error)}`;
}

const procedureStepSchema = z.object({
  action: z.enum(['search', 'read', 'digest', 'skills', 'check']),
  parameters: z.record(z.string(), z.string()),
});

/**
 * The proposal shape, validated here so a malformed proposal is a model-visible
 * error rather than an exception inside the orchestrator's callback.
 */
const proposalShape = {
  kind: z.enum(['instruction', 'skill', 'reflection']),
  project: z.string().min(1),
  slug: z.string().min(1),
  title: z.string().min(1),
  description: z.string().min(1),
  body: z.string().min(1),
  scope: z.string().min(1),
  confidence: z.enum(['low', 'medium', 'high']),
  steps: z.array(procedureStepSchema).optional(),
  targets: z.array(z.number().int()).optional(),
};

/**
 * Build the server.
 *
 * `tool()` takes a raw Zod shape (`{ query: z.string() }`), not a `z.object`, so
 * the schemas below are plain shape objects.
 */
export function buildLearnToolServer(
  options: LearnToolServerOptions
): McpSdkServerConfigWithInstance {
  const searchCtx: LearnContext = { hideExchangeIds: options.hideExchangeIds };
  const digestCtx: LearnDigestContext = {
    project: options.project,
    hideExchangeIds: options.hideExchangeIds,
  };

  const tools: Array<SdkMcpToolDefinition<any>> = [
    tool(
      'search',
      'Search past conversations. Summaries are off and the task\'s own source exchanges are excluded.',
      {
        query: z.union([z.string().min(2), z.array(z.string().min(2)).min(2).max(5)]),
        mode: z.enum(['vector', 'text', 'both']).optional(),
        limit: z.number().int().min(1).max(50).optional(),
        after: z.string().optional(),
        before: z.string().optional(),
        project: z.string().min(1).optional(),
        session_id: z.string().min(1).optional(),
        git_branch: z.string().min(1).optional(),
      },
      async args => {
        try {
          return ok(await learnSearch(args, searchCtx));
        } catch (error) {
          return fail(errorText(error));
        }
      }
    ),
    tool(
      'read',
      'Read a conversation JSONL by archive path and optional line range.',
      {
        path: z.string().min(1),
        startLine: z.number().int().min(1).optional(),
        endLine: z.number().int().min(1).optional(),
      },
      async args => {
        try {
          return ok(await learnRead(args));
        } catch (error) {
          return fail(errorText(error));
        }
      }
    ),
    tool(
      'digest',
      'The project digest, read-only. Lines citing the task\'s source exchanges are removed and their ids cannot be expanded.',
      {
        query: z.string().min(1).optional(),
        expand: z.string().min(1).optional(),
        limit: z.number().int().min(1).max(50).optional(),
      },
      async args => {
        try {
          return ok(await learnDigest(args, digestCtx));
        } catch (error) {
          return fail(errorText(error));
        }
      }
    ),
    tool(
      'skills',
      'List, load or search learned skills. Read-only.',
      {
        get: z.string().min(1).optional(),
        query: z.string().min(1).optional(),
        project: z.string().min(1).optional(),
        limit: z.number().int().min(1).max(50).optional(),
      },
      async args => {
        try {
          return ok(await learnSkills(args));
        } catch (error) {
          return fail(errorText(error));
        }
      }
    ),
  ];

  if (options.allowPropose) {
    tools.push(
      tool(
        'propose_entry',
        'Propose a learned entry for this run. The orchestrator validates, grades and stores it; this tool writes nothing.',
        proposalShape,
        async args => {
          const parsed = z.object(proposalShape).safeParse(args);
          if (!parsed.success) {
            const detail = parsed.error.issues
              .map(issue => `${issue.path.join('.') || 'proposal'}: ${issue.message}`)
              .join('; ');
            return fail(`Invalid proposal: ${detail}`);
          }
          const proposal: ProposedEntry = { ...(parsed.data as ProposedEntry) };
          try {
            options.onPropose?.(proposal);
          } catch (error) {
            return fail(errorText(error));
          }
          return ok(PROPOSAL_RECEIVED_MESSAGE);
        }
      )
    );
  }

  return createSdkMcpServer({ name: SERVER_NAME, version: '1.0.0', tools });
}
