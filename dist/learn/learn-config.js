/**
 * The learned-knowledge feature switch and its settings.
 *
 * This module imports nothing on purpose: the SessionStart hook loads it on its
 * fast path, next to the node:sqlite adapter and the small `dist/` modules, and must not
 * pull in transformers, the SDK or the knowledge store to read one environment variable.
 */
const TRUTHY = new Set(['1', 'true', 'yes', 'on']);
const PREFIX = 'EPISODIC_MEMORY_LEARN_';
const APPROVE_MODES = ['instructions', 'all', 'none'];
function raw(suffix) {
    const value = process.env[PREFIX + suffix];
    if (value === undefined)
        return undefined;
    const trimmed = value.trim();
    return trimmed === '' ? undefined : trimmed;
}
/** A count: a positive integer, or the default when the value is unusable. */
function count(suffix, fallback) {
    const value = raw(suffix);
    if (value === undefined)
        return fallback;
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed <= 0)
        return fallback;
    return parsed;
}
/** A positive number that may be fractional, or the default when unusable. */
function amount(suffix, fallback) {
    const value = raw(suffix);
    if (value === undefined)
        return fallback;
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed <= 0)
        return fallback;
    return parsed;
}
/**
 * True when `EPISODIC_MEMORY_LEARN` names an affirmative value.
 *
 * Everything is off by default. With the flag off, the hook output is byte-identical to the output
 * without the feature. No store is opened.
 */
export function learnEnabled() {
    const value = process.env.EPISODIC_MEMORY_LEARN;
    if (!value)
        return false;
    return TRUTHY.has(value.trim().toLowerCase());
}
/**
 * What the `skills` tool says with the flag off.
 *
 * Lives here, not in `skills-tool.ts`, so `mcp-tools.ts` can answer before it
 * imports that module. Importing `skills-tool` is what opens the knowledge store.
 */
export const LEARN_OFF_MESSAGE = 'Learning is off. Learned skills appear here once EPISODIC_MEMORY_LEARN=1 is set and the episodic-memory learn CLI has written some.';
/**
 * The run's settings.
 *
 * Every value comes from its own `EPISODIC_MEMORY_LEARN_*` variable.
 * A value falls back to the Global Constraints default when the variable is absent or empty.
 * The default also applies when a number is not positive.
 * A count also needs a whole number.
 * An approve mode must be one of the allowed modes.
 */
export function learnConfig() {
    const approveRaw = raw('APPROVE');
    const approve = approveRaw !== undefined && APPROVE_MODES.includes(approveRaw)
        ? approveRaw
        : 'instructions';
    const model = raw('MODEL') ?? 'sonnet';
    return {
        model,
        approve,
        maxCalls: count('MAX_CALLS', 200),
        maxUsd: amount('MAX_USD', 5),
        maxMinutes: count('MAX_MINUTES', 60),
        maxTasks: count('MAX_TASKS', 120),
        concurrency: count('CONCURRENCY', 3),
        rounds: count('ROUNDS', 3),
        minSavingPct: count('MIN_SAVING', 10),
        minGrounding: count('MIN_GROUNDING', 3),
        solverMaxTurns: count('SOLVER_MAX_TURNS', 12),
        learnerMaxTurns: count('LEARNER_MAX_TURNS', 30),
        maxChars: count('MAX_CHARS', 2500),
        leafMax: count('LEAF_MAX', 12),
        editsPerRound: count('EDITS_PER_ROUND', 3),
        validateSample: count('VALIDATE_SAMPLE', 5),
        pidPollMs: count('PID_POLL_MS', 1000),
    };
}
