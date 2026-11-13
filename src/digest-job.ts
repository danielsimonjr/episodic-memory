import type Database from 'better-sqlite3';
import type { ConversationExchange } from './types.js';
import { shouldSkipReentrantSync } from './reentrancy.js';
import { gpuReservationBlock } from './gpu-reservation.js';
import { summarizerBackend } from './ollama-backend.js';
import { deferralDetail } from './deferral.js';
import { callDigestModel, promptBudgetChars } from './summarizer.js';
import { buildSessionPrompt } from './digest-prompts.js';
import { parseCitedLines, redactEntryText } from './digest-validate.js';
import { insertDigestEntry } from './digest-db.js';
import { compressDigest } from './digest-compress.js';

/** Options for runDigest. The fields let tests replace the model call and the clock. */
export interface DigestOptions {
  /** Model call. Defaults to the configured summarizer backend; tests pass a fake. */
  model?: (prompt: string) => Promise<string>;
  /** The time that the job uses for the recent-session check and for compression. Defaults to the current time. */
  now?: Date;
}

/** The counts that runDigest returns. */
export interface DigestResult {
  /** Session entries that the job inserted. */
  written: number;
  /** Sessions left out because their last exchange is recent, or because they hold one trivial exchange. */
  skipped: number;
  /** Failed summarizer calls, for sessions and for compression. */
  failed: number;
  /** Day and week entries created by compression. Undefined when the job stopped before compression. */
  compressed?: number;
  /** The reason of the deferral that stopped the job (`src/deferral.ts` lists the causes). A deferral is not a failure. */
  deferred?: string;
}

/** A session whose last exchange is newer than this is still running; summarize it next time. */
export const QUIET_MS = 30 * 60 * 1000;
const DEFAULT_MAX_SESSIONS = 5;

/**
 * Return true when the digest feature is on.
 *
 * The feature is on only when EPISODIC_MEMORY_DIGEST is exactly `1`. Other values, such as `true`, leave it off.
 */
export function digestEnabled(): boolean {
  return process.env.EPISODIC_MEMORY_DIGEST === '1';
}

function maxSessions(): number {
  const n = Number(process.env.EPISODIC_MEMORY_DIGEST_MAX_SESSIONS);
  return Number.isInteger(n) && n > 0 ? n : DEFAULT_MAX_SESSIONS;
}

interface SessionRow {
  project: string;
  session_id: string;
  start: string;
  end: string;
}

/** One exchange row, as the exchanges table returns it. */
export interface ExchangeRow {
  id: string;
  project: string;
  timestamp: string;
  user_message: string;
  assistant_message: string;
  archive_path: string;
  line_start: number;
  line_end: number;
}

/** Map an exchange row to the public shape. */
export function toExchange(r: ExchangeRow): ConversationExchange {
  return {
    id: r.id,
    project: r.project,
    timestamp: r.timestamp,
    userMessage: r.user_message,
    assistantMessage: r.assistant_message,
    archivePath: r.archive_path,
    lineStart: r.line_start,
    lineEnd: r.line_end,
  };
}

/** The exchanges of one session, oldest first. */
export function sessionExchanges(db: Database.Database, project: string, sessionId: string): ConversationExchange[] {
  const rows = db
    .prepare(
      `SELECT id, project, timestamp, user_message, assistant_message, archive_path, line_start, line_end
       FROM exchanges WHERE project = ? AND session_id = ? ORDER BY timestamp, line_start`
    )
    .all(project, sessionId) as ExchangeRow[];
  return rows.map(toExchange);
}

/** Tell whether a session is trivial: one exchange that is `/exit` or is shorter than 100 characters. */
export function isTrivial(exchanges: ConversationExchange[]): boolean {
  if (exchanges.length !== 1) return false;
  const [e] = exchanges;
  return e.userMessage.trim() === '/exit' || e.userMessage.length + e.assistantMessage.length < 100;
}

async function writeSessionEntries(
  db: Database.Database,
  model: (p: string) => Promise<string>,
  now: Date,
  result: DigestResult
): Promise<void> {
  const sessions = db
    .prepare(
      `SELECT project, session_id, MIN(timestamp) AS start, MAX(timestamp) AS end
       FROM exchanges
       WHERE session_id IS NOT NULL
       GROUP BY project, session_id
       ORDER BY MAX(timestamp) DESC`
    )
    .all() as SessionRow[];

  const exists = db.prepare(`SELECT 1 FROM digest_entry WHERE tier = 'session' AND project = ? AND period_start = ?`);
  let attempted = 0;
  for (const s of sessions) {
    if (attempted >= maxSessions()) break;
    if (exists.get(s.project, s.start)) continue;
    if (now.getTime() - new Date(s.end).getTime() < QUIET_MS) {
      result.skipped++;
      continue;
    }
    const exchanges = sessionExchanges(db, s.project, s.session_id);
    if (isTrivial(exchanges)) {
      result.skipped++;
      continue;
    }
    attempted++;
    // The prompt must fit the backend budget, because the Ollama call cuts anything longer without a word.
    // numberExchanges does not count the blank line between its blocks, so keep two characters of slack per exchange.
    const budget = promptBudgetChars();
    const overhead = buildSessionPrompt([], 0).prompt.length;
    const { prompt, marks } = buildSessionPrompt(exchanges, Math.max(0, budget - overhead));
    if (prompt.length > budget) {
      console.error(`digest: session ${s.session_id} does not fit the prompt budget of ${budget} characters`);
      result.failed++;
      continue;
    }
    let raw: string;
    try {
      raw = await model(prompt);
    } catch (err) {
      const deferred = deferralDetail(err);
      if (deferred !== null) {
        // A deferral (`src/deferral.ts` lists the causes), for example a GPU reservation that appeared during the run.
        // Every further call would fail the same way.
        result.deferred = deferred;
        return;
      }
      console.error(
        `digest: summarizer failed for session ${s.session_id}: ${err instanceof Error ? err.message : String(err)}`
      );
      result.failed++;
      continue;
    }
    const parsed = parseCitedLines(String(raw ?? ''), marks);
    if (parsed.lines.length === 0) continue;
    const id = insertDigestEntry(db, {
      tier: 'session',
      project: s.project,
      periodStart: s.start,
      periodEnd: s.end,
      text: redactEntryText(parsed.lines.join('\n')),
      sources: parsed.sources,
      model: process.env.EPISODIC_MEMORY_API_MODEL || 'haiku',
      handoff: false,
    });
    if (id !== null) result.written++;
  }
}

/**
 * Run the digest job. The job writes session entries, then compresses older entries.
 *
 * The function returns at once, and writes nothing, when EPISODIC_MEMORY_DIGEST is not `1`.
 * The function also returns at once when EPISODIC_MEMORY_SUMMARIZER_GUARD is `1`, which marks a summarizer subprocess.
 * The job stops early at a deferral (`src/deferral.ts` lists the causes). It reports the reason in `deferred`.
 *
 * @param db the open index database
 * @param opts replaces the model call or the clock. Without it, the job uses the default summarizer call and the current time.
 */
export async function runDigest(db: Database.Database, opts: DigestOptions = {}): Promise<DigestResult> {
  const result: DigestResult = { written: 0, skipped: 0, failed: 0 };
  if (!digestEnabled() || shouldSkipReentrantSync()) return result;
  // The default model call loads a model on the shared GPU. Wait while another agent holds it.
  if (!opts.model && summarizerBackend() === 'ollama') {
    const reserved = gpuReservationBlock();
    if (reserved) {
      console.error(`digest: skipped, ${reserved}`);
      result.deferred = reserved;
      return result;
    }
  }
  const model = opts.model ?? callDigestModel;
  const now = opts.now ?? new Date();
  await writeSessionEntries(db, model, now, result);
  if (result.deferred) return result;
  const c = await compressDigest(db, { model, now });
  result.compressed = c.created;
  result.failed += c.failed;
  if (c.deferred) result.deferred = c.deferred;
  return result;
}
