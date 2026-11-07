/**
 * The learned-knowledge feature switch and its settings.
 *
 * This module imports nothing on purpose: the SessionStart hook loads it on its
 * fast path, next to `better-sqlite3` and the small `dist/` modules, and must not
 * pull in transformers, the SDK or the knowledge store to read one environment variable.
 */
/**
 * Which new instructions wait for a person before they activate.
 *
 * `instructions`, the default, keeps each instruction as a candidate until `learn approve` runs. `none` activates an instruction after validation, without a person. Skills activate after validation in every mode. `all` is accepted, and no code path gives `all` a separate effect.
 */
export type LearnApproveMode = 'instructions' | 'all' | 'none';
/**
 * The settings of one learning run, as `learnConfig` reads them from the `EPISODIC_MEMORY_LEARN_*` variables.
 *
 * Each field has a default. A variable that is missing, empty or invalid leaves its default in place.
 */
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
 * True when `EPISODIC_MEMORY_LEARN` names an affirmative value.
 *
 * Everything is off by default. With the flag off, the hook output is byte-identical to the output
 * without the feature. No store is opened.
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
 * The run's settings.
 *
 * Every value comes from its own `EPISODIC_MEMORY_LEARN_*` variable.
 * A value falls back to the Global Constraints default when the variable is absent or empty.
 * The default also applies when a number is not positive.
 * A count also needs a whole number.
 * An approve mode must be one of the allowed modes.
 */
export declare function learnConfig(): LearnConfig;
