/**
 * The learned-knowledge feature switch and its settings.
 *
 * This module imports nothing on purpose: the SessionStart hook loads it on its
 * fast path, next to `better-sqlite3` and the small `dist/` modules, and must not
 * pull in transformers, the SDK or the knowledge store to read one environment variable.
 */
export type LearnApproveMode = 'instructions' | 'all' | 'none';
export interface LearnConfig {
    model: string;
    approve: LearnApproveMode;
    maxCalls: number;
    maxUsd: number;
    maxMinutes: number;
    maxTasks: number;
    concurrency: number;
    rounds: number;
    minSavingPct: number;
    minGrounding: number;
    solverMaxTurns: number;
    learnerMaxTurns: number;
    maxChars: number;
    leafMax: number;
    editsPerRound: number;
    validateSample: number;
}
/**
 * True when `EPISODIC_MEMORY_LEARN` names an affirmative value. Everything is
 * off by default: with the flag off the hook output is byte-identical to today
 * and no store is opened.
 */
export declare function learnEnabled(): boolean;
/**
 * What the `skills` tool says with the flag off.
 *
 * Lives here, not in `skills-tool.ts`, so `mcp-tools.ts` can answer before it
 * imports that module. Importing `skills-tool` is what opens the knowledge store.
 */
export declare const LEARN_OFF_MESSAGE = "Learning is off. Learned skills appear here once EPISODIC_MEMORY_LEARN=1 is set and the episodic-memory learn CLI has written some.";
/**
 * The run's settings. Every value comes from its own `EPISODIC_MEMORY_LEARN_*`
 * variable and falls back to the Global Constraints default when it is absent,
 * not positive, not a whole number where a count is needed, or not in an enum.
 */
export declare function learnConfig(): LearnConfig;
