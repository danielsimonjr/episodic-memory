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
export declare const HIDDEN_EXPAND_MESSAGE = "That exchange is not available in this session. Search for the conversation instead.";
/**
 * `search` as a solver sees it.
 *
 * The exclusion lives in SQL (`e.id NOT IN (…)`).
 * The SQL exclusion applies to the vector, text and multi-concept paths alike.
 * Filtering the results afterwards would still admit the hidden row into the candidate set that
 * a vector query ranked.
 */
export declare function learnSearch(args: LearnSearchArgs, ctx: LearnContext): Promise<string>;
/**
 * `read`, through the production handler.
 *
 * The function injects the token here, because the host's `EPISODIC_MEMORY_MCP_TOKEN`
 * check runs inside `handleToolCall`.
 * An in-process call from a subprocess has no way to present the token.
 * Such a call must not be locked out of its own archive.
 */
export declare function learnRead(args: LearnReadArgs): Promise<string>;
/**
 * `digest` as a solver sees it: the read-only view and the query, both filtered.
 *
 * Refusing to expand a hidden id is the point of the filter, not a courtesy.
 * The id is the task's answer.
 * The expansion is the path and line range of that answer.
 */
export declare function learnDigest(args: LearnDigestArgs, ctx: LearnDigestContext): Promise<string>;
/** `skills`, read-only, through the same implementation the MCP tool uses. */
export declare function learnSkills(args: SkillsToolParams): Promise<string>;
