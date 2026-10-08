import type Database from 'better-sqlite3';
import type { ConversationExchange } from './types.js';
import { shouldSkipReentrantSync } from './reentrancy.js';
import { callDigestModel } from './summarizer.js';
import { buildSessionPrompt } from './digest-prompts.js';
import { parseCitedLines, redactEntryText } from './digest-validate.js';
import { insertDigestEntry } from './digest-db.js';
import { compressDigest } from './digest-compress.js';

export interface DigestOptions {
  /** Model call. Defaults to the configured summarizer backend; tests pass a fake. */
  model?: (prompt: string) => Promise<string>;
  now?: Date;
}

export interface DigestResult {
  written: number;
  skipped: number;
  failed: number;
  /** Day and week entries created by compression (present only when the job ran). */
  compressed?: number;
}

/** A session whose last exchange is newer than this is still running; summarize it next time. */
const QUIET_MS = 30 * 60 * 1000;
const DEFAULT_MAX_SESSIONS = 5;

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

interface ExchangeRow {
  id: string;
  project: string;
  timestamp: string;
  user_message: string;
  assistant_message: string;
  archive_path: string;
  line_start: number;
  line_end: number;
}

function toExchange(r: ExchangeRow): ConversationExchange {
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

function isTrivial(exchanges: ConversationExchange[]): boolean {
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
    const rows = db
      .prepare(
        `SELECT id, project, timestamp, user_message, assistant_message, archive_path, line_start, line_end
         FROM exchanges WHERE project = ? AND session_id = ? ORDER BY timestamp, line_start`
      )
      .all(s.project, s.session_id) as ExchangeRow[];
    const exchanges = rows.map(toExchange);
    if (isTrivial(exchanges)) {
      result.skipped++;
      continue;
    }
    attempted++;
    const { prompt, marks } = buildSessionPrompt(exchanges);
    let raw: string;
    try {
      raw = await model(prompt);
    } catch (err) {
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

/** Write session digest entries, then compress old days and weeks. Does nothing unless EPISODIC_MEMORY_DIGEST=1 and the summarizer guard is unset. */
export async function runDigest(db: Database.Database, opts: DigestOptions = {}): Promise<DigestResult> {
  const result: DigestResult = { written: 0, skipped: 0, failed: 0 };
  if (!digestEnabled() || shouldSkipReentrantSync()) return result;
  const model = opts.model ?? callDigestModel;
  const now = opts.now ?? new Date();
  await writeSessionEntries(db, model, now, result);
  const c = await compressDigest(db, { model, now });
  result.compressed = c.created;
  result.failed += c.failed;
  return result;
}
