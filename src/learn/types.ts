/**
 * Shared types for the Recursa learned-knowledge store.
 *
 * Every import here is `import type`, which TypeScript erases: the compiled
 * module has no runtime imports, so it loads with no transformers and no
 * database handle. `src/learn/knowledge-store.ts` is the only module that knows
 * how an entry is laid out on disk; every other module sees the shapes declared here.
 */

import type Database from 'better-sqlite3';
import type { KnowledgeStore } from './knowledge-store.js';

/**
 * The kind of a learned entry.
 *
 * An `instruction` is a rule for the agent. A `skill` is a procedure with steps. A `reflection` is a conclusion drawn from evidence.
 */
export type KnowledgeKind = 'instruction' | 'skill' | 'reflection';

/**
 * The lifecycle state of a learned entry.
 *
 * A `candidate` waits for validation or approval. An `active` entry is in use. A `retired` entry is no longer in use.
 */
export type KnowledgeStatus = 'candidate' | 'active' | 'retired';

/**
 * How sure the learner is of a learned entry: `low`, `medium` or `high`.
 */
export type Confidence = 'low' | 'medium' | 'high';

/**
 * The three trust levels the spec names. The store writes nothing else.
 */
export type TrustLevel = 'unverified' | 'verified' | 'ground-truth';

/** A cited exchange, stored so a citation survives an id change. */
export interface SourceRef {
  id: string;
  path: string;
  lineStart: number;
  lineEnd: number;
  sessionId: string | null;
}

/** The validation record a candidate needs before it can become active. */
export interface ValidationRecord {
  targeted: number[];
  sample: number[];
  passedBefore: number;
  passedAfter: number;
  regressions: number[];
  judgedAt: string;
  meanTurnsBefore: number | null;
  meanTurnsAfter: number | null;
  usdBefore: number | null;
  usdAfter: number | null;
  /**
   * The number of tasks with a graded attempt before the change. An errored or aborted attempt counts no task.
   * Only a bootstrap record has this field, because only its two sides can grade different numbers of tasks.
   * A validation and a merge-check grade one task set, so their records compare pass counts.
   */
  gradedBefore?: number;
  /**
   * The number of tasks with a graded attempt after the change. A record written before this field existed
   * has no value.
   */
  gradedAfter?: number;
}

/** A procedure skill's step, proposed by the agent alongside the prose body. */
export interface ProcedureStepSpec {
  action: 'search' | 'read' | 'digest' | 'skills' | 'check';
  parameters: Record<string, string>;
}

/** One learned entry, as every module outside knowledge-store.ts sees it. */
export interface KnowledgeEntry {
  /** The entity name: `learned:<kind>:<project>:<slug>:v<n>`. */
  id: string;
  kind: KnowledgeKind;
  project: string;
  slug: string;
  /**
   * Logical version, from the name and the `version:` observation.
   * NOT the row's write counter, which increments on every update.
   */
  version: number;
  title: string;
  description: string;
  body: string;
  scope: string;
  confidence: Confidence;
  trust: TrustLevel;
  sources: SourceRef[];
  status: KnowledgeStatus;
  runId: string;
  createdAt: string;
  supersededBy: string | null;
  validation: ValidationRecord | null;
  heuristicIds: string[];
  decisionId: string | null;
  procedureId: string | null;
  steps?: ProcedureStepSpec[];
}

/** What an agent proposes; the store assigns id, version and timestamps. */
export type NewKnowledgeEntry = Omit<
  KnowledgeEntry,
  | 'id'
  | 'version'
  | 'createdAt'
  | 'supersededBy'
  | 'validation'
  | 'heuristicIds'
  | 'decisionId'
  | 'procedureId'
>;

/** A gated proposal, with `body` still carrying its `[#id]` marks. */
export interface ProposedEntry {
  kind: KnowledgeKind;
  project: string;
  slug: string;
  title: string;
  description: string;
  body: string;
  scope: string;
  confidence: Confidence;
  steps?: ProcedureStepSpec[];
  /** Task ids the proposal targets. */
  targets?: number[];
}

/** One handle bundle, shared by every function from the solver onward. */
export interface LearnDbs {
  store: KnowledgeStore;
  learning: Database.Database;
  index: Database.Database;
}

/** Truth for a generated task: where the answer lives. */
export interface TaskTruth {
  exchanges: SourceRef[];
  /** UTC `YYYY-MM-DD` bounds of the source session. */
  sessionDateRange: [string, string];
  project: string;
  assistantMessage: string;
}

/** The four task kinds (§4.4). Only `locate`, `when` and `multi` are a signal. */
export type LearningKind = 'locate' | 'recall' | 'when' | 'multi';

/** Difficulty tiers. Tier 1 reuses the user's words and measures nothing. */
export type LearningTier = 1 | 2 | 3;

/** `ok`, or `stale` once `checkTasks` finds the source address gone. */
export type TaskStatus = 'ok' | 'stale';

/** One tool call a solver made. Result text is never stored. */
export interface TraceStep {
  tool: string;
  args: unknown;
  resultAddress: string | null;
  resultChars: number;
}

/**
 * What one agent attempt cost: turns, input and output tokens, and dollars.
 *
 * Input tokens include cache reads. `usd` is null when the agent reports no cost.
 */
export interface Cost {
  turns: number;
  inputTokens: number;
  outputTokens: number;
  usd: number | null;
}

/**
 * How one agent attempt ended.
 *
 * - `graded`: the agent returned a result that is not an error. The answer can be scored.
 * - `aborted`: the attempt passed its time limit.
 * - `killed`: the agent process ended because of a signal.
 * - `error`: the attempt failed in another way, or the agent returned an error result.
 */
export type AttemptOutcome = 'graded' | 'aborted' | 'killed' | 'error';

/** One row of `learning_attempt`. */
export interface AttemptRow {
  id: number;
  taskId: number;
  runId: string;
  snapshotId: number;
  role: 'solve' | 'validate' | 'merge-check';
  passed: boolean;
  score: number;
  answer: string;
  trace: TraceStep[];
  cost: Cost;
  outcome: AttemptOutcome;
  createdAt: string;
}

/** Names Windows refuses as file or directory names. */
const WINDOWS_RESERVED_NAMES = new Set([
  'con',
  'prn',
  'aux',
  'nul',
  ...Array.from({ length: 9 }, (_, i) => `com${i + 1}`),
  ...Array.from({ length: 9 }, (_, i) => `lpt${i + 1}`),
]);

/** A slug is also a directory name in the export, so it must be portable. */
export const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

/**
 * Return true when `slug` is safe to use as a directory name on every platform.
 *
 * A valid slug matches `SLUG_RE`. The pattern accepts lowercase letters, digits and hyphens. A slug has one to 64 characters. The first character must be a lowercase letter or a digit. The slug must not be a reserved Windows device name, such as `con`, `nul` or `com1`. An upper-case letter makes the check fail.
 */
export function isValidSlug(slug: string): boolean {
  if (!SLUG_RE.test(slug)) return false;
  return !WINDOWS_RESERVED_NAMES.has(slug.toLowerCase());
}
