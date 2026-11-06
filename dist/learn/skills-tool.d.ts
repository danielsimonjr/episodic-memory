/**
 * The `skills` MCP tool: read active learned skills out of the knowledge store.
 *
 * This module holds the memoryjs-backed half of the tool on purpose.
 * `mcp-tools.ts` imports it *inside* the `skills` branch, so a server with the
 * flag off never loads memoryjs — a session that never asks for a skill pays
 * nothing for the feature.
 *
 * It opens a store per call and closes it in `finally`: memoryjs serves every
 * read from an in-memory cache loaded once per context, so a module-level
 * context would keep answering from whatever was on disk when the server
 * started and a `learn` run later in the session would be invisible.
 */
import { LEARN_OFF_MESSAGE } from './learn-config.js';
export { LEARN_OFF_MESSAGE };
export declare const NO_SKILLS_MESSAGE = "No learned skills yet. Set EPISODIC_MEMORY_LEARN=1 and run the episodic-memory learn CLI to collect some.";
export interface SkillsToolParams {
    get?: string;
    query?: string;
    project?: string;
    limit?: number;
}
/**
 * The tool's text. Opens nothing with the flag off.
 *
 * The store file check comes before construction: an `openKnowledgeStore()`
 * would create `knowledge.db` (memoryjs writes on open), and a read-only tool
 * call must never be what creates the learned directory.
 */
export declare function skillsToolText(params: SkillsToolParams): Promise<string>;
