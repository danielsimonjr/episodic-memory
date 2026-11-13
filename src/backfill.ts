/**
 * Archive backfill: summarize conversations that sync can never reach.
 *
 * Purpose: sync walks the SOURCE projects directory, so sync only queues conversations
 * whose source .jsonl still exists. Once Claude Code prunes a transcript, sync never revisits its archived copy.
 *
 * Candidates are exactly what sync would retry if sync could see them.
 * A candidate has no summary file. A candidate also has an empty summary with no marker, or with a non-terminal (retrying) marker.
 * Explained empties are final.
 * Each candidate goes through summarizeOneFile. The evidence that summarizeOneFile leaves is identical to the evidence that sync leaves.
 * Use a local backend (EPISODIC_MEMORY_SUMMARIZER_BACKEND=ollama) for bulk runs.
 */

import fs from 'fs';
import path from 'path';
import { getExcludedProjects } from './paths.js';
import { gpuReservationBlock } from './gpu-reservation.js';
import { summarizerBackend } from './ollama-backend.js';
import {
  extractSessionIdFromPath,
  isTerminalFailRecord,
  shouldSkipConversation,
  summarizeOneFile,
} from './sync.js';

/**
 * One archived conversation that the backfill still has to summarize.
 */
export interface BackfillCandidate {
  path: string;
  sessionId: string;
}

/**
 * Options for `backfillArchive`.
 *
 * `limit` caps the number of candidates that one run handles. `dryRun` counts the candidates and summarizes nothing.
 */
export interface BackfillOptions {
  limit?: number;
  dryRun?: boolean;
}

/**
 * The counts from one `backfillArchive` run.
 */
export interface BackfillResult {
  candidates: number;
  processed: number;
  summarized: number;
  summaryAttempts: number;
  errors: Array<{ file: string; error: string }>;
  /** Set when the run stopped for a deferral: another agent holds the shared GPU, or no usable Claude Code executable exists. Not a failure. */
  deferred?: string;
}

function needsSummary(filePath: string): boolean {
  const summaryPath = filePath.replace(/\.jsonl$/, '-summary.txt');
  let size: number;
  try {
    size = fs.statSync(summaryPath).size;
  } catch {
    return true; // no summary file at all
  }
  if (size > 0) return false;
  const failPath = filePath.replace(/\.jsonl$/, '-summary.failed');
  if (!fs.existsSync(failPath)) return true; // legacy empty, nothing explains it
  return !isTerminalFailRecord(filePath);     // mid-retry, keep going
}

/**
 * Lists the archived conversations that still need a summary.
 *
 * The function skips excluded projects and any conversation that `shouldSkipConversation` rejects.
 * The function returns an empty list when the function cannot read the archive directory.
 * A missing summary file makes a conversation a candidate. An empty summary also makes a conversation a candidate, unless a terminal failure record explains the empty summary.
 *
 * @param archiveDir The archive directory, with one subdirectory per project.
 * @param opts Set `excludedProjects` to replace the configured exclude list.
 */
export function selectBackfillCandidates(
  archiveDir: string,
  opts: { excludedProjects?: string[] } = {}
): BackfillCandidate[] {
  const excluded = new Set(opts.excludedProjects ?? getExcludedProjects());
  const out: BackfillCandidate[] = [];
  let projects: fs.Dirent[];
  try {
    projects = fs.readdirSync(archiveDir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const project of projects) {
    if (!project.isDirectory() || excluded.has(project.name)) continue;
    const dir = path.join(archiveDir, project.name);
    for (const name of fs.readdirSync(dir).sort()) {
      if (!name.endsWith('.jsonl')) continue;
      const filePath = path.join(dir, name);
      const sessionId = extractSessionIdFromPath(filePath);
      if (!sessionId || !needsSummary(filePath) || shouldSkipConversation(filePath)) continue;
      out.push({ path: filePath, sessionId });
    }
  }
  return out;
}

/**
 * Summarizes the archived conversations that sync cannot reach, and returns the counts.
 *
 * Each candidate goes through `summarizeOneFile`. The evidence matches the evidence from a sync.
 * With `dryRun`, the function counts the candidates and summarizes nothing.
 * With the Ollama backend, the function stops at once when another agent holds the shared GPU. The result then sets `deferred`.
 * A deferral during the run also stops the loop and sets `deferred`: a reservation that appears, or no usable Claude Code executable.
 *
 * @param archiveDir The archive directory, with one subdirectory per project.
 * @param opts The limit and dry-run settings. See `BackfillOptions`.
 */
export async function backfillArchive(archiveDir: string, opts: BackfillOptions): Promise<BackfillResult> {
  const candidates = selectBackfillCandidates(archiveDir);
  const result: BackfillResult = { candidates: candidates.length, processed: 0, summarized: 0, summaryAttempts: 0, errors: [] };
  if (opts.dryRun) return result;

  // The ollama backend loads a model on the shared GPU. Ask for no summary while another agent holds it.
  if (summarizerBackend() === 'ollama') {
    const reserved = gpuReservationBlock();
    if (reserved) {
      result.deferred = reserved;
      return result;
    }
  }

  const { summarizeConversation } = await import('./summarizer.js');
  const limit = opts.limit && opts.limit > 0 ? opts.limit : candidates.length;
  for (const c of candidates.slice(0, limit)) {
    const deferred = await summarizeOneFile(c.path, c.sessionId, result, summarizeConversation);
    if (deferred) {
      // A deferral during the run. This conversation stays a candidate.
      result.deferred = deferred;
      break;
    }
    result.processed++;
  }
  return result;
}

/**
 * Decide what the batch loop does next.
 * `prevRemaining` is the remainder that the previous batch left
 * (candidates - processed); undefined on the first batch. Each batch starts at the previous remainder.
 * The function measures progress on the remainder that this batch leaves, not on where the batch starts.
 */
export function batchVerdict(
  prevRemaining: number | undefined,
  r: Pick<BackfillResult, 'candidates' | 'processed' | 'summarized' | 'summaryAttempts' | 'deferred'>
): 'continue' | 'done' | 'backend-down' | 'no-progress' | 'deferred' {
  // A wait for the shared GPU is neither progress nor a dead backend, and it comes before both.
  if (r.deferred) return 'deferred';
  if (r.processed === 0) return 'done';
  // Three or more real attempts and not one success: the backend is down, not one bad transcript.
  if (r.summaryAttempts >= 3 && r.summarized === 0) return 'backend-down';
  const remaining = r.candidates - r.processed;
  if (prevRemaining !== undefined && remaining >= prevRemaining) return 'no-progress';
  return 'continue';
}
