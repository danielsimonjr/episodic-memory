/**
 * Reentrancy guard for the SessionStart sync hook (#87) — deliberately
 * dependency-free.
 *
 * The summarizer spawns a Claude Agent SDK subprocess, which fires SessionStart,
 * which runs `sync`, which would call the summarizer again — a cascading fanout
 * that pegs CPU and burns API quota. To break it, `getApiEnv()` sets the guard
 * env var on the SDK subprocess and the sync entry point bails when it sees it.
 *
 * This logic lives in its own tiny module (no SDK, no native deps) so `sync-cli`
 * can check the guard BEFORE importing the heavy stack (transformers,
 * better-sqlite3). Loading those just to exit on a guarded subprocess wasted
 * seconds per spawn.
 */

/** Env var the summarizer sets on SDK-spawned subprocesses to mark reentrancy. */
export const SUMMARIZER_GUARD_ENV = 'EPISODIC_MEMORY_SUMMARIZER_GUARD';

/**
 * Whether the current process is a Claude Agent SDK subprocess the summarizer
 * just spawned. Sync entry points call this first and exit before re-entering
 * the sync→summarizer→spawn cycle.
 */
export function shouldSkipReentrantSync(): boolean {
  return process.env[SUMMARIZER_GUARD_ENV] === '1';
}
