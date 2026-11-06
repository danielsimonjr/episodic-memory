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
import { type SkillsToolParams } from './skills-tool.js';
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
export interface LearnReadArgs {
    path: string;
    startLine?: number;
    endLine?: number;
}
export interface LearnDigestArgs {
    query?: string;
    expand?: string;
    limit?: number;
}
export interface LearnContext {
    /** Exchange ids that must not appear in any output. */
    hideExchangeIds: string[];
}
export interface LearnDigestContext {
    /** The project whose digest to read; never inferred from the solver's cwd. */
    project: string;
    hideExchangeIds: string[];
}
/** What `learnDigest` says when asked to expand an id it must not show. */
export declare const HIDDEN_EXPAND_MESSAGE = "That exchange is not available in this session. Search for the conversation instead.";
/**
 * `search` as a solver sees it.
 *
 * The exclusion lives in SQL (`e.id NOT IN (…)`), so it applies to the vector,
 * text and multi-concept paths alike — filtering the results afterwards would
 * still admit the hidden row into the candidate set a vector query ranked.
 */
export declare function learnSearch(args: LearnSearchArgs, ctx: LearnContext): Promise<string>;
/**
 * `read`, through the production handler.
 *
 * The token is injected here because the host's `EPISODIC_MEMORY_MCP_TOKEN`
 * check runs inside `handleToolCall`; an in-process call from a subprocess has
 * no way to present it and must not be locked out of its own archive.
 */
export declare function learnRead(args: LearnReadArgs): Promise<string>;
/**
 * `digest` as a solver sees it: the read-only view and the query, both filtered.
 *
 * Refusing to expand a hidden id is the point of the filter, not a courtesy: the
 * id is the task's answer, and the expansion is its path and line range.
 */
export declare function learnDigest(args: LearnDigestArgs, ctx: LearnDigestContext): Promise<string>;
/** `skills`, read-only, through the same implementation the MCP tool uses. */
export declare function learnSkills(args: SkillsToolParams): Promise<string>;
