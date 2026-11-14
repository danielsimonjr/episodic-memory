/**
 * The isolation checks of the e2e suite (PLAN.md, "Isolation controls"). Each e2e file calls
 * `useIsolation()` first, before its own hooks. Its beforeAll takes the baselines. Its afterAll
 * runs LAST (vitest runs afterAll hooks in stack order) and fails the file with the difference.
 *
 * Three checks:
 * 1. The repo canary, on every run: `ensureDeps` prunes or installs under `node_modules`.
 * 2. The real data folders of this machine, LOCAL only: no file there may carry the name of a
 *    transcript this run seeded (see `SEEDED_FILE_NAMES`). On CI those folders do not exist, so
 *    the check is vacuous there and the failure message says so.
 * 3. The sync-cli worker processes: no worker that started during the file may still run.
 */
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll } from 'vitest';
import { SEEDED_FILE_NAMES, listTree, newSyncWorkers, startRepoCanary, syncWorkerPids } from './harness.js';

/** The number of diff lines that a failure prints. */
const DIFF_LIMIT = 20;
/** The hooks of this suite start under a timeout that covers a listing of a large data folder. */
const HOOK_TIMEOUT_MS = 300_000;

/**
 * The real data folders that no test may write. Resolved from os.homedir(), never from
 * EPISODIC_MEMORY_CONFIG_DIR, which the test process has already overwritten.
 */
export function realDataRoots(): string[] {
  return [
    path.join(os.homedir(), '.config', 'superpowers'),
    path.join(os.homedir(), '.claude', 'episodic-memory-data'),
  ];
}

/** The failure text of one check: the first lines of the difference, and the count of the rest. */
function describeDiff(label: string, lines: readonly string[]): string {
  const shown = lines.slice(0, DIFF_LIMIT).join('\n    ');
  const more = lines.length > DIFF_LIMIT ? `\n    ... ${lines.length - DIFF_LIMIT} more` : '';
  return `  ${label}:\n    ${shown}${more}`;
}

/**
 * The listing lines (from `listTree`) whose file name is a transcript this process seeded. The
 * live plugin writes the real folders at any time, so the check matches names, not changes.
 */
export function leakedSeedFiles(listing: readonly string[]): string[] {
  return listing.filter((line) => SEEDED_FILE_NAMES.has(path.posix.basename(line.split('\t')[0])));
}

/** Register the isolation checks of one e2e file. Call it before the file's own beforeAll. */
export function useIsolation(): void {
  const local = !process.env.CI;
  let repo: { changes(): string[] } | undefined;
  let workersBefore: number[] = [];

  beforeAll(() => {
    repo = startRepoCanary();
    workersBefore = syncWorkerPids();
  }, HOOK_TIMEOUT_MS);

  afterAll(() => {
    const problems: string[] = [];
    const repoChanges = repo ? repo.changes() : ['the repo canary never started'];
    if (repoChanges.length > 0) {
      problems.push(describeDiff('repo node_modules changed (ensureDeps prunes or installs there)', repoChanges));
    }
    if (local) {
      const listing = listTree(realDataRoots());
      const leaked = leakedSeedFiles(listing);
      if (leaked.length > 0) {
        problems.push(describeDiff('a transcript seeded by this run reached the real data folders', leaked));
      }
      const unreadable = listing.filter((line) => line.startsWith('UNREADABLE '));
      if (unreadable.length > 0) {
        problems.push(describeDiff('the real data folders could not be read in full, so the leak check is partial', unreadable));
      }
    }
    const workers = newSyncWorkers(workersBefore, syncWorkerPids());
    if (workers.length > 0) {
      problems.push(`  sync-cli worker pid(s) started during this file and still running: ${workers.join(', ')}`);
    }
    if (problems.length > 0) {
      const scope = local ? '' : ' (real data folders not checked: CI, vacuous)';
      throw new Error(`e2e isolation check failed${scope}:\n${problems.join('\n')}`);
    }
  }, HOOK_TIMEOUT_MS);
}
