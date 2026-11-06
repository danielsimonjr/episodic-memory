/**
 * The `skills` MCP tool: read active learned skills out of the knowledge store.
 *
 * The module holds the store-backed half of the tool on purpose.
 * `mcp-tools.ts` imports this module *inside* the `skills` branch. A server with the
 * flag off therefore never opens the knowledge store. A session that never asks for
 * a skill pays nothing for the feature.
 *
 * The tool opens a store for each call and closes it in `finally`. A long-running
 * server therefore holds no handle on `knowledge.db` between calls. The server does not block a `learn` run in
 * another process, and the next call sees a later `learn` run.
 */
import { LEARN_OFF_MESSAGE } from './learn-config.js';
/**
 * The message that the skills tool returns when learning is off. learn-config.ts declares the constant, and this module re-exports it.
 */
export { LEARN_OFF_MESSAGE };
/** The text that the skills tool returns when the knowledge store file does not exist. */
export declare const NO_SKILLS_MESSAGE = "No learned skills yet. Set EPISODIC_MEMORY_LEARN=1 and run the episodic-memory learn CLI to collect some.";
/** The parameters of the `skills` tool. Each field has the same name as in `SkillsInputSchema`. */
export interface SkillsToolParams {
    /** The slug of one skill to return. */
    get?: string;
    /** The text to search the learned skills for. */
    query?: string;
    /** The project key. The default is the key of the working directory. */
    project?: string;
    /** The maximum number of skills to return. The default is 10. */
    limit?: number;
}
/**
 * The tool's text. Opens nothing with the flag off.
 *
 * The store file check runs before construction. An `openKnowledgeStore()` call
 * would create `knowledge.db`, because a writable open creates its tables. A
 * read-only tool call must never create the learned directory.
 */
export declare function skillsToolText(params: SkillsToolParams): Promise<string>;
