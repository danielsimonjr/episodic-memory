/**
 * The gate every proposal passes before it may be stored.
 *
 * Pipeline (spec §7 rules 3, 4, 6, 7):
 *
 * 1. the slug must be portable (`isValidSlug`),
 * 2. `redactSecrets` runs on every text field,
 * 3. `parseIdCitedLines` keeps only lines with resolving, grounded marks,
 * 4. `redactPii` runs on each kept line body and on the title, description and
 *    scope — never on the trailing mark group, whose 32-hex ids would trip the
 *    digit-run patterns,
 * 5. `screenLearnedText` runs on the slug, title, description, scope and body,
 * 6. the scope must be non-empty and the confidence in the enum,
 * 7. `steps`, when present, must hold known actions and string parameters.
 *
 * Pure: no SDK, no memoryjs, no database. The resolvers and the PII redactor
 * are injected by the caller, so this runs in tests without a store.
 */

import { redactSecrets } from '../redact.js';
import { parseIdCitedLines, type IdResolvers } from './cited-ids.js';
import type { LearnConfig } from './learn-config.js';
import { screenLearnedText } from './learned-text-screen.js';
import {
  isValidSlug,
  type Confidence,
  type NewKnowledgeEntry,
  type ProcedureStepSpec,
  type ProposedEntry,
} from './types.js';

export interface GateDeps {
  resolve: IdResolvers;
  redactPii: (text: string) => string;
  config: Pick<LearnConfig, 'minGrounding'>;
  runId: string;
}

export type GateResult =
  | { entry: NewKnowledgeEntry; attempts: number[] }
  | { rejected: string };

/** The trailing citation mark group of one body line. */
const TRAILING_MARKS =
  /\s*\[((?:#[0-9a-f]{32}|@\d+)(?:\s*,\s*(?:#[0-9a-f]{32}|@\d+))*)\]\s*$/;

const CONFIDENCES: readonly Confidence[] = ['low', 'medium', 'high'];

const ACTIONS: readonly ProcedureStepSpec['action'][] = [
  'search',
  'read',
  'digest',
  'skills',
  'check',
];

/**
 * Redact one field: secrets first, then PII.
 *
 * A body is handled line by line so the trailing mark group is split off
 * before the PII patterns run. `PiiRedactor`'s phone and card patterns match
 * any run of 10 to 19 digits, and a 32-hex exchange id is exactly such a run.
 */
export function redactLearnedText(
  text: string,
  deps: { redactPii: (text: string) => string }
): string {
  if (!text) return text;
  return text
    .split('\n')
    .map(line => {
      const match = TRAILING_MARKS.exec(line);
      if (!match) return deps.redactPii(redactSecrets(line));
      const body = line.slice(0, match.index);
      const marks = match[0].trim();
      const redactedBody = deps.redactPii(redactSecrets(body)).trimEnd();
      return redactedBody ? `${redactedBody} ${marks}` : marks;
    })
    .join('\n');
}

function screenField(
  field: string,
  text: string,
  opts: { kind: ProposedEntry['kind']; field: string }
): string | null {
  const result = screenLearnedText(text, opts);
  return result.ok ? null : `screened: ${field}: ${result.reason}`;
}

function validSteps(steps: ProcedureStepSpec[] | undefined): boolean {
  if (steps === undefined) return true;
  for (const step of steps) {
    if (!ACTIONS.includes(step.action)) return false;
    if (typeof step.parameters !== 'object' || step.parameters === null) return false;
    for (const value of Object.values(step.parameters)) {
      if (typeof value !== 'string') return false;
    }
  }
  return true;
}

/** Gate one proposal into a storable candidate, or explain the rejection. */
export function gateEntry(proposal: ProposedEntry, deps: GateDeps): GateResult {
  if (!isValidSlug(proposal.slug)) return { rejected: 'invalid slug' };

  // 2. secrets, on every text field, before anything else reads them.
  const slug = proposal.slug;
  const title = redactSecrets(proposal.title ?? '');
  const description = redactSecrets(proposal.description ?? '');
  const scope = redactSecrets(proposal.scope ?? '');
  const body = redactSecrets(proposal.body ?? '');

  // 3. citations.
  const cited = parseIdCitedLines(body, deps.resolve, deps.config.minGrounding);
  if (cited.lines.length === 0) return { rejected: 'no cited line' };

  // 4. PII, line by line, so marks are never fed to the digit patterns.
  const redactedBody = redactLearnedText(cited.lines.join('\n'), { redactPii: deps.redactPii });
  const redactedTitle = deps.redactPii(title);
  const redactedDescription = deps.redactPii(description);
  const redactedScope = deps.redactPii(scope);

  // 5. the injection screen, on every stored field.
  const screened =
    screenField('slug', slug, { kind: proposal.kind, field: 'slug' }) ??
    screenField('title', redactedTitle, { kind: proposal.kind, field: 'title' }) ??
    screenField('description', redactedDescription, { kind: proposal.kind, field: 'description' }) ??
    screenField('scope', redactedScope, { kind: proposal.kind, field: 'scope' }) ??
    screenField('body', redactedBody, { kind: proposal.kind, field: 'body' });
  if (screened) return { rejected: screened };

  // 6. scope and confidence.
  if (redactedScope.trim() === '') return { rejected: 'empty scope' };
  if (!CONFIDENCES.includes(proposal.confidence)) return { rejected: 'invalid confidence' };

  // 7. steps.
  if (!validSteps(proposal.steps)) return { rejected: 'invalid steps' };

  const entry: NewKnowledgeEntry = {
    kind: proposal.kind,
    project: proposal.project,
    slug,
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
  if (proposal.steps) entry.steps = proposal.steps.map(step => ({
    action: step.action,
    parameters: { ...step.parameters },
  }));

  return { entry, attempts: cited.attempts };
}
