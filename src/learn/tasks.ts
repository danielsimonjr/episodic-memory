/**
 * Self-practice task generation and staleness checks (spec §4.4).
 *
 * A task is built from one held-out exchange: the solver never sees its address
 * or its assistant message, and the grade compares what the solver found with
 * the address the exchange actually has. The archive is therefore both the
 * corpus and the answer key, and no rubric author is needed.
 *
 * What this module guarantees:
 *
 * - **Redaction before any model sees text, and again before storage.** The
 *   paraphrase prompt carries redacted exchange text; the returned prompt is
 *   redacted and truth is redacted before the row is written.
 * - **Screening.** A prompt that fails the learned-text screen is not stored.
 *   A paraphrase is untrusted text from a model that just read the archive, and
 *   it becomes a learner prompt later.
 * - **A stratified 60/40 split** per `(project, tier)` from the seed stored on
 *   the run, so the held-out split is comparable across runs.
 * - **Truth is an address**, not a copied transcript, so a re-index that moves a
 *   line marks the task stale instead of silently wrong.
 */

import path from 'path';
import type Database from 'better-sqlite3';
import type { ConversationExchange } from '../types.js';
import { redactSecrets } from '../redact.js';
import { screenLearnedText } from './learned-text-screen.js';
import { insertTask, markStale, type LearningTask } from './learning-db.js';
import type { LearningKind, LearningTier, SourceRef } from './types.js';
import { callLearnModel } from '../summarizer.js';

/** Default floors from spec §4.4. */
export const MIN_PER_PROJECT = 20;
export const MIN_USER_CHARS = 80;
export const MIN_ASSISTANT_CHARS = 200;

/** The train fraction of each `(project, tier)` cell. */
const TRAIN_SHARE = 0.6;

const KINDS: LearningKind[] = ['locate', 'recall', 'when', 'multi'];
const TIERS: LearningTier[] = [1, 2, 3];

export interface SelectSourceOptions {
  perProject: number;
  seed: number;
  minPerProject?: number;
  minUser?: number;
  minAssistant?: number;
}

/** A small, well-distributed PRNG. Deterministic across platforms and Node versions. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Fold a string into a 32-bit seed so each project shuffles differently. */
function stringSeed(text: string): number {
  let hash = 2166136261;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function shuffle<T>(items: T[], random: () => number): T[] {
  const out = items.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
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
  session_id: string | null;
}

function exchangeFromRow(row: ExchangeRow): ConversationExchange {
  return {
    id: row.id,
    project: row.project,
    timestamp: row.timestamp,
    userMessage: row.user_message,
    assistantMessage: row.assistant_message,
    archivePath: row.archive_path,
    lineStart: row.line_start,
    lineEnd: row.line_end,
    sessionId: row.session_id ?? undefined,
  };
}

/**
 * Pick the exchanges tasks may be built from.
 *
 * Deterministic from the seed. Excludes sidechains, exchanges whose user or
 * assistant message is below the floor (a one-line exchange has nothing to
 * locate), and projects below `minPerProject` indexed exchanges (a project with
 * a dozen exchanges makes a task trivially findable).
 */
export function selectSourceExchanges(
  indexDb: Database.Database,
  options: SelectSourceOptions
): ConversationExchange[] {
  const minPerProject = options.minPerProject ?? MIN_PER_PROJECT;
  const minUser = options.minUser ?? MIN_USER_CHARS;
  const minAssistant = options.minAssistant ?? MIN_ASSISTANT_CHARS;

  const rows = indexDb
    .prepare(
      `SELECT id, project, timestamp, user_message, assistant_message,
              archive_path, line_start, line_end, session_id
         FROM exchanges e
        WHERE COALESCE(e.is_sidechain, 0) = 0
          AND LENGTH(e.user_message) >= ?
          AND LENGTH(e.assistant_message) >= ?
          AND e.project IN (
            SELECT project FROM exchanges
             WHERE COALESCE(is_sidechain, 0) = 0
             GROUP BY project
            HAVING COUNT(*) >= ?
          )
        ORDER BY e.project, e.id`
    )
    .all(minUser, minAssistant, minPerProject) as ExchangeRow[];

  const byProject = new Map<string, ExchangeRow[]>();
  for (const row of rows) {
    const list = byProject.get(row.project) ?? [];
    list.push(row);
    byProject.set(row.project, list);
  }

  const selected: ConversationExchange[] = [];
  for (const project of [...byProject.keys()].sort()) {
    const pool = byProject.get(project)!;
    const random = mulberry32((options.seed ^ stringSeed(project)) >>> 0);
    const picked = shuffle(pool, random).slice(0, Math.max(0, options.perProject));
    // A stable order inside the project keeps the split reproducible too.
    picked.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    for (const row of picked) selected.push(exchangeFromRow(row));
  }
  return selected;
}

/** `YYYY-MM-DD` in UTC. */
function utcDate(timestamp: string): string {
  const parsed = new Date(timestamp);
  return Number.isNaN(parsed.getTime())
    ? timestamp.slice(0, 10)
    : parsed.toISOString().slice(0, 10);
}

function sourceRef(exchange: ConversationExchange): SourceRef {
  return {
    id: exchange.id,
    path: exchange.archivePath,
    lineStart: exchange.lineStart,
    lineEnd: exchange.lineEnd,
    sessionId: exchange.sessionId ?? null,
  };
}

/** Every exchange of the same session, so truth can span a date range and a multi task. */
function sessionSiblings(indexDb: Database.Database, exchange: ConversationExchange): ExchangeRow[] {
  if (!exchange.sessionId) return [];
  return indexDb
    .prepare(
      `SELECT id, project, timestamp, user_message, assistant_message,
              archive_path, line_start, line_end, session_id
         FROM exchanges
        WHERE session_id = ? AND project = ?
        ORDER BY timestamp, id`
    )
    .all(exchange.sessionId, exchange.project) as ExchangeRow[];
}

/**
 * The paraphrase prompt.
 *
 * One call per source exchange returns all three tiers; the tiers differ only in
 * how much of the user's own vocabulary survives. Tier 3 deliberately adds a
 * wrong-but-plausible detail the solver has to reject.
 */
export function paraphrasePrompt(exchange: ConversationExchange): string {
  const user = redactSecrets(exchange.userMessage).slice(0, 2000);
  const assistant = redactSecrets(exchange.assistantMessage).slice(0, 1200);
  return [
    'You write retrieval practice questions about a past conversation, for a system that must find',
    'the conversation again from the question alone.',
    '',
    'Rules:',
    '- Never quote a file path, a session id or a message id.',
    '- Never mention the words "paraphrase", "tier" or "task".',
    '- Each question must be answerable from the conversation alone.',
    '',
    'What the user asked:',
    user,
    '',
    'What the assistant answered:',
    assistant,
    '',
    'Return exactly three tagged blocks. In each block write four lines, one per kind,',
    'each starting with the kind name and a colon:',
    '',
    'locate: <a question asking where this was addressed>',
    'recall: <the locate question, plus a request to state the outcome in two sentences>',
    'when: <a question asking when this work happened>',
    'multi: <a question asking two distinct things that the conversation settled>',
    '',
    'Tier 1 reuses the user\'s own words.',
    'Tier 2 is a paraphrase with none of the user\'s rare terms.',
    'Tier 3 is a paraphrase that adds one plausible but wrong detail.',
    '',
    '<tier1>',
    '</tier1>',
    '<tier2>',
    '</tier2>',
    '<tier3>',
    '</tier3>',
  ].join('\n');
}

/** One parsed tier: kind → prompt. */
type TierBlock = Partial<Record<LearningKind, string>>;

const TIER_TAG = /<tier([123])>([\s\S]*?)<\/tier\1>/g;

/**
 * A stored prompt is the solver's only view of the task. The archive path and
 * the session id are the answer key (spec §4.4), so a paraphrase that echoes
 * either of them is dropped rather than stored.
 *
 * The check is lexical: a `.jsonl` path (POSIX or Windows), the source
 * exchange's own path or session id, or a bare `session-<id>` token. The word
 * "session" on its own is a legitimate question and is kept.
 */
export function promptLeaksAnswerKey(prompt: string, exchange: ConversationExchange): boolean {
  if (typeof prompt !== 'string' || !prompt) return false;
  if (/\.jsonl\b/i.test(prompt)) return true;
  if (/(?:^|\s)(?:\/|\\|[A-Za-z]:[\\/])\S+/.test(prompt)) return true;

  const sessionId = exchange.sessionId?.trim();
  if (sessionId && sessionId.length >= 3 && prompt.includes(sessionId)) return true;

  const archivePath = exchange.archivePath?.trim();
  if (archivePath && prompt.includes(archivePath)) return true;
  if (archivePath) {
    const base = path.basename(archivePath);
    if (base.length >= 3 && prompt.includes(base)) return true;
  }

  // A session id the model named even when it is not this exchange's id
  // (`session-0` while paraphrasing a sibling) is still an address.
  if (/\bsession[-_][A-Za-z0-9][\w.-]*/.test(prompt)) return true;
  return false;
}

/** Parse the model's tagged blocks. A missing or malformed block yields no prompts. */
export function parseParaphrase(raw: string): Record<LearningTier, TierBlock> {
  const blocks: Record<LearningTier, TierBlock> = { 1: {}, 2: {}, 3: {} };
  if (typeof raw !== 'string' || !raw) return blocks;

  for (const match of raw.matchAll(TIER_TAG)) {
    const tier = Number(match[1]) as LearningTier;
    for (const line of match[2].split('\n')) {
      const parsed = line.match(/^\s*[-*]?\s*\**\s*(locate|recall|when|multi)\s*\**\s*:\s*\**\s*(.+?)\s*$/i);
      if (!parsed) continue;
      const kind = parsed[1].toLowerCase() as LearningKind;
      const prompt = parsed[2].replace(/\**\s*$/, '').trim();
      if (prompt) blocks[tier][kind] = prompt;
    }
  }
  return blocks;
}

export interface GenerateTasksOptions {
  runId: string;
  seed: number;
  /** Text-only model. Default `callLearnModel`. */
  model?: (prompt: string) => Promise<string>;
  perProject?: number;
  maxTasks: number;
}

export interface GenerateTasksResult {
  created: number;
  byKindTier: Record<string, number>;
}

/** A task before it is inserted, carrying the stratum it belongs to. */
interface DraftTask {
  kind: LearningKind;
  tier: LearningTier;
  project: string;
  prompt: string;
  truth: LearningTask['truth'];
}

/**
 * Generate tasks from the archive, split them, and store them.
 *
 * One paraphrase call per source exchange. Each returned prompt is redacted and
 * screened; a prompt that fails either is dropped, and an exchange whose whole
 * answer is unusable simply contributes no tasks.
 */
export async function generateTasks(
  learningDb: Database.Database,
  indexDb: Database.Database,
  options: GenerateTasksOptions
): Promise<GenerateTasksResult> {
  const model = options.model ?? callLearnModel;
  const perProject = options.perProject ?? 8;
  const sources = selectSourceExchanges(indexDb, { perProject, seed: options.seed });

  const drafts: DraftTask[] = [];

  for (const exchange of sources) {
    let raw: string;
    try {
      raw = await model(paraphrasePrompt(exchange));
    } catch {
      continue;
    }
    const blocks = parseParaphrase(raw);
    const siblings = sessionSiblings(indexDb, exchange);
    const dates = (siblings.length > 0 ? siblings.map(s => s.timestamp) : [exchange.timestamp]).sort();
    const sessionDateRange: [string, string] = [
      utcDate(dates[0]),
      utcDate(dates[dates.length - 1]),
    ];

    const exchangeRefs: SourceRef[] = [sourceRef(exchange)];
    const sibling = siblings.find(row => row.id !== exchange.id);
    if (sibling) {
      exchangeRefs.push(sourceRef(exchangeFromRow(sibling)));
    }

    const assistantMessage = redactSecrets(exchange.assistantMessage);

    for (const tier of TIERS) {
      for (const kind of KINDS) {
        const rawPrompt = blocks[tier][kind];
        if (!rawPrompt) continue;
        const prompt = redactSecrets(rawPrompt).trim();
        if (!prompt) continue;
        if (promptLeaksAnswerKey(prompt, exchange)) continue;
        if (!screenLearnedText(prompt).ok) continue;

        drafts.push({
          kind,
          tier,
          project: exchange.project,
          prompt,
          truth: {
            exchanges: kind === 'multi' ? exchangeRefs : [sourceRef(exchange)],
            sessionDateRange,
            project: exchange.project,
            assistantMessage,
          },
        });
      }
    }
  }

  // Stratify by (project, tier), sample each stratum down to its share of
  // `maxTasks`, then split 60/40 inside the surviving stratum. The share is a
  // floor plus a remainder handed out in a stable order, so the total never
  // exceeds the cap and the allocation is reproducible.
  const strata = new Map<string, DraftTask[]>();
  for (const draft of drafts) {
    const key = `${draft.project}\u0000${draft.tier}`;
    const list = strata.get(key) ?? [];
    list.push(draft);
    strata.set(key, list);
  }

  const stratumKeys = [...strata.keys()].sort();
  const cap = Math.max(0, options.maxTasks);
  const baseShare = stratumKeys.length === 0 ? 0 : Math.floor(cap / stratumKeys.length);
  const remainder = stratumKeys.length === 0 ? 0 : cap % stratumKeys.length;
  const share = new Map<string, number>();
  stratumKeys.forEach((key, index) => {
    share.set(key, baseShare + (index < remainder ? 1 : 0));
  });

  const kept: DraftTask[] = [];
  for (const key of stratumKeys) {
    const list = strata.get(key)!;
    const quota = Math.min(share.get(key) ?? 0, list.length);
    if (quota === 0) continue;
    const random = mulberry32((options.seed ^ stringSeed(key)) >>> 0);
    const sampled = shuffle(list, random).slice(0, quota);
    sampled.sort((a, b) => `${a.kind}`.localeCompare(`${b.kind}`));
    kept.push(...sampled);
  }

  const byKindTier: Record<string, number> = {};
  let created = 0;

  const byStratum = new Map<string, DraftTask[]>();
  for (const draft of kept) {
    const key = `${draft.project}\u0000${draft.tier}`;
    const list = byStratum.get(key) ?? [];
    list.push(draft);
    byStratum.set(key, list);
  }

  for (const key of [...byStratum.keys()].sort()) {
    const list = byStratum.get(key)!;
    const trainCount = Math.round(list.length * TRAIN_SHARE);
    list.forEach((draft, index) => {
      const split: 'train' | 'test' = index < trainCount ? 'train' : 'test';
      insertTask(learningDb, {
        runId: options.runId,
        kind: draft.kind,
        tier: draft.tier,
        split,
        project: draft.project,
        prompt: draft.prompt,
        truth: draft.truth,
        status: 'ok',
      });
      created += 1;
      const cell = `${draft.kind}:${draft.tier}`;
      byKindTier[cell] = (byKindTier[cell] ?? 0) + 1;
    });
  }

  return { created, byKindTier };
}

/** A row of the index, reduced to what a staleness check needs. */
interface AddressRow {
  archive_path: string;
  line_start: number;
  line_end: number;
}

/** True when some indexed exchange sits at `ref`'s path with an overlapping range. */
function addressResolves(indexDb: Database.Database, ref: SourceRef): boolean {
  const rows = indexDb
    .prepare('SELECT archive_path, line_start, line_end FROM exchanges WHERE archive_path = ?')
    .all(ref.path) as AddressRow[];
  return rows.some(
    row =>
      overlaps(ref.lineStart, ref.lineEnd, Number(row.line_start), Number(row.line_end)) &&
      row.archive_path === ref.path
  );
}

function overlaps(aStart: number, aEnd: number, bStart: number, bEnd: number): boolean {
  const start = Math.max(aStart, bStart);
  const end = Math.min(aEnd, bEnd);
  return start <= end;
}

/**
 * Mark every task whose source address no longer resolves.
 *
 * A re-indexed session keeps its path but moves its lines (the last exchange of
 * a growing session grows, and later inserts shift nothing but a repair can
 * renumber); a pruned project loses the path entirely. Both are `stale`, which
 * excludes the task from reads and metrics rather than scoring it as a failure.
 */
export function checkTasks(
  learningDb: Database.Database,
  indexDb: Database.Database
): { stale: number[] } {
  const rows = learningDb
    .prepare("SELECT id, truth FROM learning_task WHERE status = 'ok' ORDER BY id")
    .all() as Array<{ id: number; truth: string }>;

  const stale: number[] = [];
  for (const row of rows) {
    let truth: LearningTask['truth'];
    try {
      truth = JSON.parse(row.truth) as LearningTask['truth'];
    } catch {
      stale.push(row.id);
      continue;
    }
    const refs = Array.isArray(truth?.exchanges) ? truth.exchanges : [];
    if (refs.length === 0 || refs.some(ref => !addressResolves(indexDb, ref))) {
      stale.push(row.id);
    }
  }

  markStale(learningDb, stale);
  return { stale };
}
