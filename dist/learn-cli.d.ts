/**
 * `episodic-memory learn` — the process entry point (`dist/learn-cli.js`).
 *
 * Everything below the four early exits is imported lazily. A learning run loads
 * the knowledge store, the Agent SDK and transformers; a guarded reentrant subprocess, a
 * flag-off invocation, a deferred GPU reservation or `--help` must pay none of
 * that (spec §7 rules 8, 10 and 12). The order is fixed and mirrors
 * `sync-cli.ts`:
 *
 * 1. `shouldSkipReentrantSync()` — a SessionStart hook inside a subprocess the
 *    summarizer spawned. Exit 0.
 * 2. `--help` — needs nothing.
 * 3. `learnEnabled()` — flag off exits 0 with the same message every `learn`
 *    subcommand gives.
 * 4. `gpuReservationBlock()` — the fleet rule: do not compete. Exit 0, deferred.
 *
 * Only then is the process marked a background worker and dropped in priority,
 * so the heavy import that follows never runs at normal priority.
 */
export {};
