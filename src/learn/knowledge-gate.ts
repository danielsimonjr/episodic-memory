/**
 * The gate every proposal passes before it becomes stored knowledge.
 *
 * Pipeline, in this order and for the reasons the spec gives:
 *
 * 1. `isValidSlug` — the slug is an entity-name component and an export
 *    directory name, so it is validated before anything else touches it.
 * 2. `redactSecrets` on every text field — a secret must not reach storage even
 *    if a later check would have dropped the entry.
 * 3. `parseIdCitedLines` — citation and grounding, which also rewrites the marks
 *    and yields the `sources` the entry stores.
 * 4. `redactPii` on each surviving line body and on title, description and
 *    scope — after the mark group is off, because the PII phone and card
 *    patterns match any 10 to 19 digit run and a 32-hex mark can hold one.
 * 5. `screenLearnedText` on every field — the injection screen.
 * 6. Shape checks — non-empty scope, `confidence` in its enum, valid `steps`.
 *
 * The module is pure. No SDK, no memoryjs and no database import lives here: the
 * resolvers, the PII redactor and the config all come from the caller, so this
 * file is safe to load from a test or a hook.
 */

import { redactSecrets } from '../redact.js';
import { isValidSlug } from './types.js';
import type { Confidence, NewKnowledgeEntry, ProcedureStepSpec, ProposedEntry } from './types.js';
import { parseIdCitedLines, type IdCitationResolver } from './cited-ids.js';
import { screenLearnedText } from './learned-text-screen.js';
import type { LearnConfig } from './learn-config.js';

/** A trailing mark group, in either citation form. */
const TRAILING_MARKS = /\[(?:#|@)[^\]]*\]\s*$/;

/**
 * Every exchange or attempt mark, wherever it sits on the line. The PII
 * redactor's 10–19 digit runs match inside a 32-hex id, so each mark is
 * lifted out before redaction and put back after — not only the trailing group.
 */
const ANY_MARK = /#[0-9a-f]{32}|@\d+/g;

const CONFIDENCES: readonly Confidence[] = ['low', 'medium', 'high'];
const STEP_ACTIONS: readonly ProcedureStepSpec['action'][] = [
  'search',
  'read',
  'digest',
  'skills',
  'check',
];

export interface GateDeps {
  resolve: IdCitationResolver;
  redactPii: (text: string) => string;
  config: Pick<LearnConfig, 'minGrounding'>;
  runId: string;
}

export interface GateAccepted {
  entry: NewKnowledgeEntry;
  attempts: number[];
}

export type GateResult = GateAccepted | { rejected: string };

/**
 * Lift every `#<32 hex>` and `@<digits>` mark out of `text` so a digit-run
 * redactor cannot rewrite one. Placeholders are private-use sentinels, which
 * neither the secret patterns nor a case-changing redactor rewrite.
 */
function shieldMarks(text: string): { text: string; marks: string[] } {
  const marks: string[] = [];
  const shielded = text.replace(ANY_MARK, mark => {
    const token = `\uE000${marks.length}\uE001`;
    marks.push(mark);
    return token;
  });
  return { text: shielded, marks };
}

function restoreMarks(text: string, marks: string[]): string {
  return text.replace(/\uE000(\d+)\uE001/g, (_match, index: string) => marks[Number(index)] ?? '');
}

/**
 * Redact one text field: secrets first, then PII. The trailing mark group is
 * split off, and every earlier `#`/`@` mark is shielded, so the digit-run
 * patterns never see a 32-hex exchange mark.
 */
export function redactLearnedText(
  text: string,
  deps: { redactPii: (t: string) => string }
): string {
  return text
    .split('\n')
    .map(line => {
      const group = TRAILING_MARKS.exec(line);
      const head = group ? line.slice(0, group.index) : line;
      const tail = group ? line.slice(group.index) : '';
      const shielded = shieldMarks(head);
      const redacted = deps.redactPii(redactSecrets(shielded.text));
      return restoreMarks(redacted, shielded.marks) + tail;
    })
    .join('\n');
}

function isValidSteps(steps: unknown): steps is ProcedureStepSpec[] {
  if (!Array.isArray(steps)) return false;
  return steps.every(step => {
    if (!step || typeof step !== 'object') return false;
    const candidate = step as Partial<ProcedureStepSpec>;
    if (!STEP_ACTIONS.includes(candidate.action as ProcedureStepSpec['action'])) return false;
    const parameters = candidate.parameters;
    if (!parameters || typeof parameters !== 'object' || Array.isArray(parameters)) return false;
    return Object.values(parameters).every(value => typeof value === 'string');
  });
}

/**
 * Gate one proposal. Returns the entry to store, or the reason it was rejected
 * (the reason string is what `learn report` prints).
 */
export function gateEntry(proposal: ProposedEntry, deps: GateDeps): GateResult {
  if (!isValidSlug(proposal.slug)) return { rejected: 'invalid-slug' };

  const title = redactSecrets(proposal.title);
  const description = redactSecrets(proposal.description);
  const scope = redactSecrets(proposal.scope);
  const body = redactSecrets(proposal.body);

  const cited = parseIdCitedLines(body, deps.resolve, deps.config.minGrounding);
  if (cited.lines.length === 0) return { rejected: 'no-cited-lines' };

  const redactedBody = cited.lines
    .map(line => redactLearnedText(line, { redactPii: deps.redactPii }))
    .join('\n');
  const redactedTitle = deps.redactPii(title);
  const redactedDescription = deps.redactPii(description);
  const redactedScope = deps.redactPii(scope);

  const screens: Array<[string, string]> = [
    ['slug', proposal.slug],
    ['title', redactedTitle],
    ['description', redactedDescription],
    ['scope', redactedScope],
  ];
  for (const [field, text] of screens) {
    const result = screenLearnedText(text, { kind: proposal.kind, field });
    if (!result.ok) return { rejected: result.reason };
  }
  const bodyScreen = screenLearnedText(redactedBody, {
    kind: proposal.kind,
    field: 'body',
  });
  if (!bodyScreen.ok) return { rejected: bodyScreen.reason };

  if (!redactedScope.trim()) return { rejected: 'empty-scope' };
  if (!CONFIDENCES.includes(proposal.confidence)) return { rejected: 'invalid-confidence' };

  if (proposal.steps !== undefined && !isValidSteps(proposal.steps)) {
    return { rejected: 'invalid-steps' };
  }

  const entry: NewKnowledgeEntry = {
    kind: proposal.kind,
    project: proposal.project,
    slug: proposal.slug,
    title: redactedTitle,
    description: redactedDescription,
    body: redactedBody,
    scope: redactedScope,
    confidence: proposal.confidence,
    trust: 'unverified',
    sources: cited.sources,
    status: 'candidate',
    runId: deps.runId,
  };
  if (proposal.steps !== undefined) entry.steps = proposal.steps;

  return { entry, attempts: cited.attempts };
}
