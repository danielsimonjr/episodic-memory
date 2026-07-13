// Process priority for the detached background sync worker.
//
// The `--background` path spawns a DETACHED child and exits, so the worker
// outlives its parent by design. That worker then boots transformers.js and
// embeds exchanges on the CPU — onnxruntime saturates every core it is given.
// Inheriting NORMAL priority, it competes on equal terms with the interactive
// session that spawned it, including the MCP servers that must complete a
// handshake inside Claude Code's 30s startup budget. Observed 2026-07-13: a
// background sync held ~5 of 12 cores for 10+ minutes, the machine sat at 100%,
// and plugin MCP servers timed out at 30s.
//
// A task explicitly labelled "background" must never be able to starve the
// foreground that launched it. Dropping the worker to BELOW_NORMAL lets the OS
// preempt it for interactive work; the sync still finishes, just out of the way.
import os from 'os';

export const BACKGROUND_WORKER_ENV = 'EPISODIC_MEMORY_BACKGROUND_WORKER';

/** True when this process is the detached worker spawned by `sync --background`. */
export function isBackgroundWorker(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[BACKGROUND_WORKER_ENV] === '1';
}

/**
 * Drop this process to below-normal priority if it is the background sync
 * worker. Call BEFORE the heavy imports (transformers / better-sqlite3) so the
 * expensive work never runs at normal priority.
 *
 * Returns whether the priority was actually lowered. Never throws: priority is
 * an optimization, and a platform that refuses it must not break the sync.
 *
 * @param setPriority injectable for tests (defaults to os.setPriority)
 */
export function lowerPriorityIfBackgroundWorker(
  env: NodeJS.ProcessEnv = process.env,
  setPriority: (pid: number, priority: number) => void = os.setPriority,
): boolean {
  if (!isBackgroundWorker(env)) return false;
  try {
    // pid 0 = the current process
    setPriority(0, os.constants.priority.PRIORITY_BELOW_NORMAL);
    return true;
  } catch {
    return false;
  }
}
