/**
 * Prompts for the solver (Task 5). The learner, bootstrapper, split, merge and
 * reflection prompts land here in Tasks 7 to 9.
 *
 * Every function is pure: text in, text out, no clock, no environment, no model.
 * That is what lets a test assert on the exact rules a prompt carries, and it
 * keeps the citation rule in one reviewable place.
 */
import type { KnowledgeEntry } from './types.js';
/** The answer lines a solver must produce, in order. */
export declare const SOLVER_ANSWER_FORMAT: string[];
/**
 * The solver's system prompt.
 *
 * `instructions` are the active instruction entries (project rows then global),
 * and `skillsIndex` is the one-line-per-skill index the rendered block also
 * shows. Both are inserted as data: the prompt says so, because learned text was
 * written by a model reading untrusted archive content.
 */
export declare function solverSystemPrompt(instructions: KnowledgeEntry[], skillsIndex: string): string;
