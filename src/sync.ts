import fs from 'fs';
import path from 'path';
import { SUMMARIZER_CONTEXT_MARKER } from './constants.js';
import { getExcludedProjects, findJsonlFiles } from './paths.js';

const EXCLUSION_MARKERS = [
  '<INSTRUCTIONS-TO-EPISODIC-MEMORY>DO NOT INDEX THIS CHAT</INSTRUCTIONS-TO-EPISODIC-MEMORY>',
  'Only use NO_INSIGHTS_FOUND',
  SUMMARIZER_CONTEXT_MARKER,
];

/** How many leading bytes to scan for exclusion markers (avoids full-file reads). */
const SKIP_MARKER_SCAN_BYTES = 256 * 1024;

/**
 * True when the conversation should be excluded from indexing / summarization.
 * Only scans the first SKIP_MARKER_SCAN_BYTES — markers are emitted early in
 * agent prompts, so a head scan is sufficient and vastly cheaper on huge JSONL.
 */
export function shouldSkipConversation(filePath: string): boolean {
  try {
    const fd = fs.openSync(filePath, 'r');
    try {
      const buf = Buffer.alloc(SKIP_MARKER_SCAN_BYTES);
      const bytesRead = fs.readSync(fd, buf, 0, SKIP_MARKER_SCAN_BYTES, 0);
      const content = buf.subarray(0, bytesRead).toString('utf-8');
      return EXCLUSION_MARKERS.some(marker => content.includes(marker));
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    // If we can't read the file, don't skip it
    return false;
  }
}

export interface SyncResult {
  copied: number;
  skipped: number;
  indexed: number;
  summarized: number;
  summaryAttempts: number; // how many summaries were attempted (success + failure) this run
  // How many conversations still LACK a summary after this run. Added 2026-08-29: the CLI had a
  // totalNeedingSummaries field that nothing ever populated, so it read 0 forever and any banner
  // built on it would have been decorative. Without this number "Summarized: 0" is ambiguous
  // between "nothing needed doing" and "the queue is stalled" - the two states that matter most.
  pendingSummaries: number;
  /**
   * Zero-byte -summary.txt files seen this run, and how many of those carry NO recorded reason.
   *
   * WHY THIS EXISTS. An empty summary is written on three legitimate paths (oversized skip,
   * zero-exchange conversation, give-up after N attempts) and the needs-summary gate is a bare
   * existsSync - so an empty file reads as DONE forever. Until 1.5.2 the give-up path also
   * DELETED its failure record, making a permanently-failed summary byte-identical to a
   * legitimately-empty one. Measured on one machine 2026-09-02: 2,919 zero-byte summaries of
   * 6,762 (43%) and ZERO failure markers. pendingSummaries counts only files with no summary at
   * all, so it read 0 and the 1.5.1 honest banner - shipped precisely to catch a silent
   * summariser - could never fire for this mode.
   *
   * unexplainedEmptySummaries is therefore the honest number: empty, and nothing says why.
   */
  emptySummaries: number;
  unexplainedEmptySummaries: number;
  errors: Array<{ file: string; error: string }>;
}

export interface SyncOptions {
  skipIndex?: boolean;
  skipSummaries?: boolean;
  summaryLimit?: number; // Max summaries to generate per run (default: 10)
}

/**
 * Max times a single conversation may fail to summarize before we give up and
 * write an empty sentinel. Without this cap a conversation that deterministically
 * fails (corrupt transcript, persistent API error) is re-queued on EVERY sync
 * forever — the "backlog never drains" bug (F1). Read dynamically so it's
 * configurable at runtime (and per-test).
 */
/** Byte ceiling above which a transcript is skipped rather than handed to a timed call. */
function maxSummaryBytes(): number {
  const configured = parseInt(process.env.EPISODIC_MEMORY_MAX_SUMMARY_BYTES || '10485760', 10);
  return Number.isFinite(configured) && configured >= 0 ? configured : 10485760;
}

function maxSummaryAttempts(): number {
  const configured = parseInt(process.env.EPISODIC_MEMORY_MAX_SUMMARY_ATTEMPTS || '3', 10);
  return Number.isFinite(configured) && configured > 0 ? configured : 3;
}

/** Sidecar recording failed summary attempts for a conversation. */
function summaryFailPath(filePath: string): string {
  return filePath.replace('.jsonl', '-summary.failed');
}

function readSummaryAttempts(filePath: string): number {
  try {
    const data = JSON.parse(fs.readFileSync(summaryFailPath(filePath), 'utf-8'));
    return typeof data.attempts === 'number' ? data.attempts : 0;
  } catch {
    return 0;
  }
}

function copyIfNewer(src: string, dest: string): boolean {
  // Ensure destination directory exists
  const destDir = path.dirname(dest);
  if (!fs.existsSync(destDir)) {
    fs.mkdirSync(destDir, { recursive: true });
  }

  // Check if destination exists and is up-to-date
  if (fs.existsSync(dest)) {
    const srcStat = fs.statSync(src);
    const destStat = fs.statSync(dest);
    if (destStat.mtimeMs >= srcStat.mtimeMs) {
      return false; // Dest is current, skip
    }
  }

  // Atomic copy: temp file + rename. Use a unique suffix and clean the temp up if
  // the rename fails (e.g. Windows EPERM when an AV scanner briefly locks dest),
  // so the archive doesn't accumulate orphaned *.tmp.* files (F10).
  const tempDest = `${dest}.tmp.${process.pid}.${Math.random().toString(36).slice(2)}`;
  try {
    fs.copyFileSync(src, tempDest);
    fs.renameSync(tempDest, dest); // Atomic on same filesystem
  } catch (err) {
    try { fs.unlinkSync(tempDest); } catch {}
    throw err;
  }
  return true;
}

export function extractSessionIdFromPath(filePath: string): string | null {
  // Extract session ID from Claude filename or Codex rollout filename.
  const basename = path.basename(filePath, '.jsonl');
  const uuidPattern = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/ig;
  const matches = basename.match(uuidPattern);
  if (matches && matches.length > 0) {
    return matches[matches.length - 1];
  }
  return null;
}

export async function syncConversations(
  sourceDir: string,
  destDir: string,
  options: SyncOptions = {}
): Promise<SyncResult> {
  const result: SyncResult = {
    copied: 0,
    skipped: 0,
    indexed: 0,
    summarized: 0,
    summaryAttempts: 0,
    pendingSummaries: 0,
    emptySummaries: 0,
    unexplainedEmptySummaries: 0,
    errors: []
  };

  // Ensure source directory exists
  if (!fs.existsSync(sourceDir)) {
    return result;
  }

  // Collect files to index and summarize
  const filesToIndex: string[] = [];
  const filesToSummarize: Array<{ path: string; sessionId: string }> = [];

  // Walk source directory
  const projects = fs.readdirSync(sourceDir);
  const excludedProjects = getExcludedProjects();
  const excludedDirSet = new Set(excludedProjects);

  for (const project of projects) {
    if (excludedProjects.includes(project)) {
      console.log("\nSkipping excluded project: " + project);
      continue;
    }

    const projectPath = path.join(sourceDir, project);
    const stat = fs.statSync(projectPath);

    if (!stat.isDirectory()) continue;

    const files = findJsonlFiles(projectPath, excludedDirSet);

    for (const file of files) {
      const srcFile = path.join(projectPath, file);
      const destFile = path.join(destDir, project, file);

      try {
        const wasCopied = copyIfNewer(srcFile, destFile);
        if (wasCopied) {
          result.copied++;
          filesToIndex.push(destFile);
        } else {
          result.skipped++;
        }

        // Check if this file needs a summary (whether newly copied or existing)
        if (!options.skipSummaries) {
          const summaryPath = destFile.replace('.jsonl', '-summary.txt');
          // An empty summary reads as DONE to the gate below, forever. Count them so the
          // condition is at least VISIBLE, and separate the ones nothing explains. Deliberately
          // does NOT re-queue them: 43% of one real archive is empty, and re-queuing thousands
          // at once would storm the very summariser that is failing. Visibility first.
          if (fs.existsSync(summaryPath)) {
            try {
              if (fs.statSync(summaryPath).size === 0) {
                result.emptySummaries++;
                if (!fs.existsSync(summaryFailPath(destFile))) result.unexplainedEmptySummaries++;
              }
            } catch { /* unreadable summary is not evidence either way */ }
          }
          if (!fs.existsSync(summaryPath) && !shouldSkipConversation(destFile)) {
            // Fall back to the filename (sans .jsonl) when there's no embedded UUID,
            // so transcripts named without a session UUID are still summarized rather
            // than silently dropped (F9). The id only matters for Codex resume.
            const sessionId = extractSessionIdFromPath(destFile) ?? path.basename(destFile, '.jsonl');
            if (sessionId) {
              filesToSummarize.push({ path: destFile, sessionId });
            }
          }
        }
      } catch (error) {
        result.errors.push({
          file: srcFile,
          error: error instanceof Error ? error.message : String(error)
        });
      }
    }
  }

  // Index copied files (unless skipIndex is set)
  if (!options.skipIndex && filesToIndex.length > 0) {
    const { initDatabase, insertExchange, getMaxIndexedLine } = await import('./db.js');
    const { initEmbeddings, generateExchangeEmbeddings } = await import('./embeddings.js');
    const { parseConversation } = await import('./parser.js');

    const db = initDatabase();
    // try/finally so a throw from initEmbeddings or anything outside the per-file
    // catch can't leak the DB handle (and its WAL), which would surface as a
    // "database is locked" / stale .db-wal on the next run (F6).
    try {
      await initEmbeddings();

      for (const file of filesToIndex) {
        try {
          // Check for DO NOT INDEX marker
          if (shouldSkipConversation(file)) {
            continue; // Skip indexing but file is already copied
          }

          const project = path.basename(path.dirname(file));
          const exchanges = await parseConversation(file, project, file);

          // High-water mark: transcript JSONLs are append-only, so only embed
          // exchanges past MAX(line_end). Matches indexUnprocessed (#84).
          const maxIndexedLine = getMaxIndexedLine(db, file);
          const newExchanges =
            maxIndexedLine > 0
              ? exchanges.filter((e) => e.lineStart > maxIndexedLine)
              : exchanges;

          if (newExchanges.length === 0) {
            result.indexed++;
            continue;
          }

          const embeddings = await generateExchangeEmbeddings(
            newExchanges.map((exchange) => ({
              userMessage: exchange.userMessage,
              assistantMessage: exchange.assistantMessage,
              toolNames: exchange.toolCalls?.map((tc) => tc.toolName),
            }))
          );

          const insertTx = db.transaction(() => {
            for (let i = 0; i < newExchanges.length; i++) {
              const exchange = newExchanges[i];
              const toolNames = exchange.toolCalls?.map((tc) => tc.toolName);
              insertExchange(db, exchange, embeddings[i], toolNames);
            }
          });
          insertTx();

          result.indexed++;
        } catch (error) {
          result.errors.push({
            file,
            error: error instanceof Error ? error.message : String(error)
          });
        }
      }
    } finally {
      db.close();
    }
  }

  // Generate summaries for files that need them
  if (!options.skipSummaries && filesToSummarize.length > 0) {
    const { parseConversation } = await import('./parser.js');
    const { summarizeConversation } = await import('./summarizer.js');

    const summaryLimit = options.summaryLimit ?? 10;

    // STARVATION FIX (2026-08-29). Files are enqueued in directory order and the budget takes
    // the FIRST N. A conversation that times out keeps its place at the front, so the same
    // doomed files consumed the whole budget every sync - attempts 1/3 then 2/3 - while fresh
    // conversations behind them were never reached. Measured on the ZBOOK: 87 of 140 sync
    // blocks reported "Summarized: 0" while the backlog oscillated instead of draining.
    // Retries still happen; they just go LAST, so they use leftover budget rather than all of it.
    const withFailureState = filesToSummarize.map(f => ({ ...f, priorFailures: readSummaryAttempts(f.path) }));
    withFailureState.sort((a, b) => a.priorFailures - b.priorFailures);
    const toSummarize = withFailureState.slice(0, summaryLimit);
    const deferredFailures = withFailureState.length - toSummarize.length;
    const retriedHere = toSummarize.filter(f => f.priorFailures > 0).length;
    if (retriedHere > 0) {
      console.log(`  (${retriedHere} of these are retries of previously failed conversations)`);
    }
    void deferredFailures;
    const remaining = filesToSummarize.length - toSummarize.length;

    result.pendingSummaries = filesToSummarize.length;
    console.log(`Generating summaries for ${toSummarize.length} conversation(s)...`);
    if (remaining > 0) {
      console.log(`  (${remaining} more need summaries - will process on next sync)`);
    }

    for (const { path: filePath, sessionId } of toSummarize) {
      try {
        // SIZE GUARD (2026-08-29). A 45.8 MB transcript was handed whole to a 120 s summariser
        // call, which could only ever time out - it then burned its three attempts across three
        // syncs while its archive fell a day behind. Oversized conversations are now recorded as
        // deliberately skipped rather than retried to no purpose. Raise the ceiling with
        // EPISODIC_MEMORY_MAX_SUMMARY_BYTES once summarisation can stream them.
        const sizeCeiling = maxSummaryBytes();
        let fileBytes = 0;
        try { fileBytes = fs.statSync(filePath).size; } catch { fileBytes = 0; }
        if (sizeCeiling > 0 && fileBytes > sizeCeiling) {
          const summaryPath = filePath.replace('.jsonl', '-summary.txt');
          fs.writeFileSync(summaryPath, '', 'utf-8');
          try {
            fs.writeFileSync(summaryFailPath(filePath), JSON.stringify({
              attempts: maxSummaryAttempts(),
              lastError: `skipped: ${fileBytes} bytes exceeds EPISODIC_MEMORY_MAX_SUMMARY_BYTES (${sizeCeiling})`
            }), 'utf-8');
          } catch {}
          console.log(`  Skipping ${path.basename(filePath)}: ${(fileBytes / 1048576).toFixed(1)} MB exceeds the ${(sizeCeiling / 1048576).toFixed(0)} MB summary ceiling`);
          result.errors.push({ file: filePath, error: `oversized transcript skipped (${fileBytes} bytes)` });
          continue;
        }

        const project = path.basename(path.dirname(filePath));
        const exchanges = await parseConversation(filePath, project, filePath);

        if (exchanges.length === 0) {
          // Skip empty conversations — write an empty -summary.txt sentinel so they aren't re-queued
          // forever, AND record why. Every empty summary must carry a reason; an empty file with no
          // marker now means "nobody knows", which is a reportable condition rather than a silence.
          const summaryPath = filePath.replace('.jsonl', '-summary.txt');
          fs.writeFileSync(summaryPath, '', 'utf-8');
          try {
            fs.writeFileSync(summaryFailPath(filePath), JSON.stringify({
              reason: 'no-exchanges', recordedAt: new Date().toISOString()
            }), 'utf-8');
          } catch {}
          continue;
        }

        console.log(`  Summarizing ${path.basename(filePath)} (${exchanges.length} exchanges)...`);
        result.summaryAttempts++;
        const summary = await summarizeConversation(exchanges, sessionId);

        const summaryPath = filePath.replace('.jsonl', '-summary.txt');
        fs.writeFileSync(summaryPath, summary, 'utf-8');
        try { fs.unlinkSync(summaryFailPath(filePath)); } catch {} // clear any prior failure record
        result.summarized++;
      } catch (error) {
        const errMsg = error instanceof Error ? error.message : String(error);
        const attempts = readSummaryAttempts(filePath) + 1;
        if (attempts >= maxSummaryAttempts()) {
          // Give up: write an empty sentinel (same marker zero-exchange files use)
          // so this conversation stops re-queuing every sync forever (F1).
          const summaryPath = filePath.replace('.jsonl', '-summary.txt');
          try { fs.writeFileSync(summaryPath, '', 'utf-8'); } catch {}
          // KEEP the record. Deleting it (as this did until 1.5.2) made a permanently-failed
          // summary indistinguishable from a legitimately-empty one, which is how a machine
          // accumulated 2,919 empty summaries and 0 failure markers. The sentinel above is what
          // stops the re-queue loop; the marker is only evidence, and erasing evidence to stop a
          // loop was never the mechanism - it was collateral.
          try {
            fs.writeFileSync(summaryFailPath(filePath), JSON.stringify({
              attempts, lastError: errMsg, gaveUp: true, gaveUpAt: new Date().toISOString()
            }), 'utf-8');
          } catch {}
          console.log(`  Giving up on ${path.basename(filePath)} after ${attempts} failed attempts: ${errMsg}`);
        } else {
          try {
            fs.writeFileSync(summaryFailPath(filePath), JSON.stringify({ attempts, lastError: errMsg }), 'utf-8');
          } catch {}
        }
        result.errors.push({
          file: filePath,
          error: `Summary generation failed (attempt ${attempts}/${maxSummaryAttempts()}): ${errMsg}`
        });
      }
    }
  }

  return result;
}
