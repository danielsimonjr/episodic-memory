/**
 * The read-only handlers behind the solver's in-process `episodic-learn` server.
 *
 * These are *not* `handleToolCall` with different arguments. Three deliberate
 * differences keep a task's answer out of a solver's hands (spec §4.4, §7 rule 9):
 *
 * 1. `learnSearch` passes the task's source exchange ids as `excludeIds`, turns
 *    summaries off (a summary is a paraphrase of the very exchange being
 *    hidden), and reuses the shared reader.
 * 2. `learnDigest` filters every line citing a hidden id, and refuses to expand
 *    one. It never reaches `handleToolCall('digest', …)`, whose default branch
 *    builds the unfiltered text and whose `handoff` branch is a write.
 * 3. There is no `handoff`. A solver has nothing to write.
 *
 * `learnRead` is the production `read` handler unchanged apart from the MCP
 * token, which the server injects: an in-process tool call from an SDK
 * subprocess never carries the host's `auth_token`, and a run with
 * `EPISODIC_MEMORY_MCP_TOKEN` set must still be able to read.
 */

import { initDatabase } from '../db.js';
import { getRequiredMcpToken } from '../mcp-auth.js';
import { handleToolCall } from '../mcp-tools.js';
import { buildDigestText, digestMaxChars } from '../digest-inject.js';
import { searchDigest } from '../digest-db.js';
import { skillsToolText, type SkillsToolParams } from './skills-tool.js';

/**
 * The arguments of `learnSearch`. They follow the `search` tool, with a markdown response only.
 */
export interface LearnSearchArgs {
  query: string | string[];
  mode?: 'vector' | 'text' | 'both';
  limit?: number;
  after?: string;
  before?: string;
  project?: string;
  session_id?: string;
  git_branch?: string;
  /** A markdown answer is what a solver reasons over; JSON is not offered. */
  response_format?: 'markdown';
}

/**
 * The arguments of `learnRead`. They follow the `read` tool.
 */
export interface LearnReadArgs {
  path: string;
  startLine?: number;
  endLine?: number;
}

/**
 * The arguments of `learnDigest`.
 *
 * When `expand` is set, the function ignores `query`. Without `expand`, a set `query` searches the digest. Without either field, the function returns the default digest view.
 */
export interface LearnDigestArgs {
  query?: string;
  expand?: string;
  limit?: number;
}

/**
 * The per-task context of `learnSearch`. The context names the exchange ids that the search must not return.
 */
export interface LearnContext {
  /** Exchange ids that must not appear in any output. */
  hideExchangeIds: string[];
}

/**
 * The per-task context of `learnDigest`. The context names the project to read and the exchange ids to hide.
 */
export interface LearnDigestContext {
  /** The project whose digest to read; never inferred from the solver's cwd. */
  project: string;
  hideExchangeIds: string[];
}

/** What `learnDigest` says when asked to expand an id it must not show. */
export const HIDDEN_EXPAND_MESSAGE =
  'That exchange is not available in this session. Search for the conversation instead.';

function hiddenSet(ids: string[] | undefined): Set<string> {
  return new Set((ids ?? []).filter(id => typeof id === 'string' && id.length > 0));
}

/**
 * `search` as a solver sees it.
 *
 * The exclusion lives in SQL (`e.id NOT IN (…)`), so it applies to the vector,
 * text and multi-concept paths alike — filtering the results afterwards would
 * still admit the hidden row into the candidate set a vector query ranked.
 */
export async function learnSearch(args: LearnSearchArgs, ctx: LearnContext): Promise<string> {
  const {
    searchConversations,
    searchMultipleConcepts,
    formatResults,
    formatMultiConceptResults,
  } = await import('../search.js');

  const hideExchangeIds = (ctx.hideExchangeIds ?? []).filter(id => typeof id === 'string' && id.length > 0);

  if (Array.isArray(args.query)) {
    const results = await searchMultipleConcepts(args.query, {
      limit: args.limit ?? 10,
      after: args.after,
      before: args.before,
      project: args.project,
      session_id: args.session_id,
      git_branch: args.git_branch,
      excludeIds: hideExchangeIds,
      includeSummaries: false,
      useSharedReader: true,
    });
    return formatMultiConceptResults(results, args.query);
  }

  const results = await searchConversations(args.query, {
    mode: args.mode ?? 'both',
    limit: args.limit ?? 10,
    after: args.after,
    before: args.before,
    project: args.project,
    session_id: args.session_id,
    git_branch: args.git_branch,
    excludeIds: hideExchangeIds,
    includeSummaries: false,
    useSharedReader: true,
  });
  return formatResults(results);
}

/**
 * `read`, through the production handler.
 *
 * The token is injected here because the host's `EPISODIC_MEMORY_MCP_TOKEN`
 * check runs inside `handleToolCall`; an in-process call from a subprocess has
 * no way to present it and must not be locked out of its own archive.
 */
export async function learnRead(args: LearnReadArgs): Promise<string> {
  const token = getRequiredMcpToken();
  const payload: Record<string, unknown> = {
    path: args.path,
    ...(args.startLine !== undefined ? { startLine: args.startLine } : {}),
    ...(args.endLine !== undefined ? { endLine: args.endLine } : {}),
    ...(token !== undefined ? { auth_token: token } : {}),
  };

  const result = await handleToolCall('read', payload);
  if (result.isError) {
    const text = result.content.map(part => part.text).join('\n');
    throw new Error(text.replace(/^Error:\s*/, ''));
  }
  return result.content.map(part => part.text).join('\n');
}

/** The default digest view for a hidden-id set, at the configured budget. */
function digestView(project: string, hideExchangeIds: string[]): string {
  const db = initDatabase();
  try {
    return buildDigestText(db, project, digestMaxChars(), { hideExchangeIds });
  } finally {
    db.close();
  }
}

/**
 * `digest` as a solver sees it: the read-only view and the query, both filtered.
 *
 * Refusing to expand a hidden id is the point of the filter, not a courtesy: the
 * id is the task's answer, and the expansion is its path and line range.
 */
export async function learnDigest(
  args: LearnDigestArgs,
  ctx: LearnDigestContext
): Promise<string> {
  const hide = hiddenSet(ctx.hideExchangeIds);

  if (args.expand) {
    if (hide.has(args.expand)) return HIDDEN_EXPAND_MESSAGE;
    const db = initDatabase();
    try {
      const row = db
        .prepare(
          'SELECT archive_path, line_start, line_end, project, timestamp FROM exchanges WHERE id = ?'
        )
        .get(args.expand) as
        | { archive_path: string; line_start: number; line_end: number; project: string; timestamp: string }
        | undefined;
      if (!row) return `No digest entry or exchange with id ${args.expand}.`;
      return `Exchange ${args.expand} (${row.project}, ${row.timestamp})\npath: ${row.archive_path}\nstartLine: ${row.line_start}\nendLine: ${row.line_end}\nPass path, startLine and endLine to the read tool.`;
    } finally {
      db.close();
    }
  }

  if (args.query) {
    const db = initDatabase();
    try {
      const hits = searchDigest(db, args.query, ctx.project, args.limit ?? 10, {
        hideExchangeIds: [...hide],
      });
      if (hits.length === 0) return `No digest entries match "${args.query}".`;
      return hits
        .map(h => `## ${h.tier} ${h.periodStart.slice(0, 10)} (${h.project})\n${h.text}`)
        .join('\n\n');
    } finally {
      db.close();
    }
  }

  const text = digestView(ctx.project, [...hide]);
  return text || `No digest entries for ${ctx.project}.`;
}

/** `skills`, read-only, through the same implementation the MCP tool uses. */
export async function learnSkills(args: SkillsToolParams): Promise<string> {
  return skillsToolText(args);
}
