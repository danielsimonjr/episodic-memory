// Dependency-light imports first, as in sync-cli: the guard and help paths must exit fast.
import { getArchiveDir } from './paths.js';
import { getSyncLockPath } from './logging.js';
import { shouldSkipReentrantSync } from './reentrancy.js';
import { acquireLock, releaseLock } from './lockfile.js';

const args = process.argv.slice(2);

if (shouldSkipReentrantSync()) {
  console.error('episodic-memory: skipping backfill inside summarizer-spawned subprocess (#87)');
  process.exit(0);
}

if (args.includes('--help') || args.includes('-h')) {
  console.log(`
Usage: episodic-memory backfill [--limit N] [--batch N] [--dry-run]

Summarize ARCHIVED conversations that sync can never reach: sync only walks transcripts whose
source file still exists, so pruned conversations keep no summary forever.

Selects conversations with no summary file, or with an empty summary that nothing explains.
Explained empties (no-exchanges, oversized, gave up) are left alone.

OPTIONS:
  --dry-run    Count candidates and exit
  --limit N    Stop after N conversations (default: all)
  --batch N    Conversations per batch (default 25). The sync lock is held per batch and released
               between batches, so a long backfill never blocks a SessionStart sync for long.

For bulk runs use a local model, not billed API calls:
  EPISODIC_MEMORY_SUMMARIZER_BACKEND=ollama EPISODIC_MEMORY_OLLAMA_MODEL=<model> episodic-memory backfill
`);
  process.exit(0);
}

function numArg(name: string): number | undefined {
  const i = args.indexOf(name);
  if (i < 0) return undefined;
  const n = Number(args[i + 1]);
  if (!Number.isInteger(n) || n <= 0) {
    console.error(`${name} needs a positive integer`);
    process.exit(1);
  }
  return n;
}

const limit = numArg('--limit');
const batch = numArg('--batch') ?? 25;
const dryRun = args.includes('--dry-run');
const archiveDir = getArchiveDir();

const { backfillArchive } = await import('./backfill.js');

if (dryRun) {
  const r = await backfillArchive(archiveDir, { dryRun: true });
  console.log(`Backfill candidates: ${r.candidates} (archive: ${archiveDir})`);
  process.exit(0);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let done = 0, summarized = 0, errors = 0;
let lastCandidates: number | undefined;
console.log(`Backfilling archive ${archiveDir} (batch ${batch}${limit ? `, limit ${limit}` : ''})`);

for (;;) {
  const want = limit ? Math.min(batch, limit - done) : batch;
  if (want <= 0) break;
  const lock = acquireLock(getSyncLockPath());
  if (!lock) {
    console.log('  sync is running; waiting 30 s');
    await sleep(30000);
    continue;
  }
  let r;
  try {
    r = await backfillArchive(archiveDir, { limit: want });
  } finally {
    releaseLock(lock);
  }
  done += r.processed;
  summarized += r.summarized;
  errors += r.errors.length;
  console.log(`  batch: ${r.processed} processed, ${r.summarized} summarized, ${r.errors.length} errors; ` +
    `${r.candidates - r.processed} candidates left`);
  for (const e of r.errors.slice(0, 3)) console.log(`    ${e.file}: ${e.error}`);
  if (r.processed === 0) break;
  // Guard against a candidate that survives its own processing (no progress): if the candidate
  // count did not fall, another pass would redo the same files.
  if (lastCandidates !== undefined && r.candidates >= lastCandidates && r.summarized === 0) {
    console.error('No progress since the previous batch; stopping.');
    process.exitCode = 1;
    break;
  }
  lastCandidates = r.candidates - r.processed;
  // A batch where every summarize attempt failed means the backend is down. Stop rather than
  // spend every candidate's retry attempts against a dead endpoint.
  if (r.summaryAttempts > 0 && r.summarized === 0) {
    console.error('Every summarize attempt in this batch failed; stopping. Check the backend.');
    process.exitCode = 1;
    break;
  }
}

console.log(`Backfill finished: ${done} processed, ${summarized} summarized, ${errors} errors`);
