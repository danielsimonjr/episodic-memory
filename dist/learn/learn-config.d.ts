/**
 * The `EPISODIC_MEMORY_LEARN*` settings.
 *
 * This module reads `process.env` and imports nothing at all: the digest hook
 * depends on it, and the hook must stay on the fast path (no SQLite driver, no
 * SDK, no memoryjs, no transformers). Keep it import-free.
 *
 * Every numeric setting is read as a positive finite number; anything else
 * (missing, empty, `0`, negative, `NaN`, `Infinity`, prose) falls back to the
 * documented default. The approval mode is an enum with the same rule.
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
/** `EPISODIC_MEMORY_LEARN` defaults off. */
export declare function learnEnabled(): boolean;
/** Every setting, with the defaults from the plan's Global Constraints. */
export declare function learnConfig(): LearnConfig;
