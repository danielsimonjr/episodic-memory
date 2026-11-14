/**
 * `episodic-memory learn` — the process entry point (`dist/learn-cli.js`).
 *
 * Everything below the five early exits is imported lazily. A learning run loads
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
 * 4. `learnOptionRefusal()` — an option the subcommand does not read. Exit 2, one line.
 * 5. `gpuReservationBlock()` — the fleet rule: do not compete. Exit 0, deferred.
 *
 * Only then is the process marked a background worker and dropped in priority,
 * so the heavy import that follows never runs at normal priority.
 */

import { shouldSkipReentrantSync } from './reentrancy.js';
import { learnEnabled, LEARN_OFF_MESSAGE } from './learn/learn-config.js';
import { LEARN_USAGE, learnOptionRefusal } from './learn/usage.js';
import { gpuReservationBlock } from './gpu-reservation.js';
import { BACKGROUND_WORKER_ENV, lowerPriorityIfBackgroundWorker } from './priority.js';
import { formatLogLine, getLearnLogPath } from './logging.js';
import fs from 'fs';

const argv = process.argv.slice(2);

if (shouldSkipReentrantSync()) {
  console.error('episodic-memory: skipping learn inside a summarizer-spawned subprocess (#87)');
  process.exit(0);
}

if (argv.includes('--help') || argv.includes('-h')) {
  // Printed from the light module. Importing cli-main here would load the
  // Agent SDK and the knowledge store before this process has decided to do any work.
  console.log(LEARN_USAGE);
  process.exit(0);
}

if (!learnEnabled()) {
  console.error(LEARN_OFF_MESSAGE);
  process.exit(0);
}

// Refuse a bad option before the priority drop and its notice, so a usage error prints one line.
const refusal = learnOptionRefusal(argv[0] ?? '', argv.slice(1));
if (refusal !== undefined) {
  console.error(refusal);
  process.exit(2);
}

const reserved = gpuReservationBlock();
if (reserved) {
  console.error(`episodic-memory: learn deferred: ${reserved}`);
  process.exit(0);
}

// A learning run is a heavy local process. Mark it, then let the helper drop the
// process below normal priority before the SDK and transformers load. The
// marker is inherited by every subprocess through `getApiEnv()`, which spreads
// `process.env`.
process.env[BACKGROUND_WORKER_ENV] = '1';
if (lowerPriorityIfBackgroundWorker()) {
  console.error('episodic-memory: learn running at below-normal priority');
}

const { runLearnCli } = await import('./learn/cli-main.js');

/** A learning run outlives its terminal often enough that progress belongs in its own log. */
function logPath(): string | null {
  try {
    return getLearnLogPath();
  } catch {
    return null;
  }
}
const logFile = logPath();
const appendLog = (line: string): void => {
  if (!logFile) return;
  try {
    fs.appendFileSync(logFile, line, 'utf-8');
  } catch {
    // A run must not fail because its log is unwritable.
  }
};

appendLog(formatLogLine('info', `learn ${argv.join(' ') || '(no command)'} started by pid ${process.pid}`));

const code = await runLearnCli(argv, {
  stdout: text => process.stdout.write(text),
  stderr: text => {
    process.stderr.write(text);
    appendLog(formatLogLine('info', text.trimEnd()));
  },
});

appendLog(formatLogLine(code === 0 ? 'info' : 'error', `learn exited ${code}`));
process.exit(code);
