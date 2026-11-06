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
const TRUTHY = new Set(['1', 'true', 'yes', 'on']);
const APPROVE_MODES = ['instructions', 'all', 'none'];
function positiveNumber(name, fallback) {
    const raw = process.env[name];
    if (raw === undefined)
        return fallback;
    const trimmed = raw.trim();
    if (trimmed === '')
        return fallback;
    const value = Number(trimmed);
    if (!Number.isFinite(value) || value <= 0)
        return fallback;
    return value;
}
function approveMode() {
    const raw = process.env.EPISODIC_MEMORY_LEARN_APPROVE?.trim();
    if (raw && APPROVE_MODES.includes(raw)) {
        return raw;
    }
    return 'instructions';
}
function modelName() {
    const raw = process.env.EPISODIC_MEMORY_LEARN_MODEL?.trim();
    return raw ? raw : 'sonnet';
}
/** `EPISODIC_MEMORY_LEARN` defaults off. */
export function learnEnabled() {
    const raw = process.env.EPISODIC_MEMORY_LEARN;
    if (!raw)
        return false;
    return TRUTHY.has(raw.trim().toLowerCase());
}
/** Every setting, with the defaults from the plan's Global Constraints. */
export function learnConfig() {
    return {
        model: modelName(),
        approve: approveMode(),
        maxCalls: positiveNumber('EPISODIC_MEMORY_LEARN_MAX_CALLS', 200),
        maxUsd: positiveNumber('EPISODIC_MEMORY_LEARN_MAX_USD', 5),
        maxMinutes: positiveNumber('EPISODIC_MEMORY_LEARN_MAX_MINUTES', 60),
        maxTasks: positiveNumber('EPISODIC_MEMORY_LEARN_MAX_TASKS', 120),
        concurrency: positiveNumber('EPISODIC_MEMORY_LEARN_CONCURRENCY', 3),
        rounds: positiveNumber('EPISODIC_MEMORY_LEARN_ROUNDS', 3),
        minSavingPct: positiveNumber('EPISODIC_MEMORY_LEARN_MIN_SAVING', 10),
        minGrounding: positiveNumber('EPISODIC_MEMORY_LEARN_MIN_GROUNDING', 3),
        solverMaxTurns: positiveNumber('EPISODIC_MEMORY_LEARN_SOLVER_MAX_TURNS', 12),
        learnerMaxTurns: positiveNumber('EPISODIC_MEMORY_LEARN_LEARNER_MAX_TURNS', 30),
        maxChars: positiveNumber('EPISODIC_MEMORY_LEARN_MAX_CHARS', 2500),
        leafMax: positiveNumber('EPISODIC_MEMORY_LEARN_LEAF_MAX', 12),
        editsPerRound: positiveNumber('EPISODIC_MEMORY_LEARN_EDITS_PER_ROUND', 3),
        validateSample: positiveNumber('EPISODIC_MEMORY_LEARN_VALIDATE_SAMPLE', 5),
    };
}
