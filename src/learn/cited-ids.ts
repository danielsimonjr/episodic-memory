/**
 * Citation gate for tool-using agents.
 *
 * A model that read the archive cites the exchanges it read, as a trailing
 * mark group: `[#<32 hex>, #<32 hex>, @<attempt id>]`. A line is kept only
 * when
 *
 * 1. it ends in such a group,
 * 2. the group holds at least one `#` exchange mark (an `@`-only line, or a
 *    numeric digest-style mark such as `[7]`, is not grounding),
 * 3. every mark resolves (the resolvers are injected, so this stays pure), and
 * 4. the line shares at least `minGrounding` distinct content tokens with the
 *    text of at least one cited exchange — a real id pinned to an unrelated
 *    sentence is not a citation.
 *
 * The existing `parseCitedLines` in `digest-validate.ts` is a different gate
 * for text-only prompts that carry a numeric mark map; it is unchanged.
 */

import type { SourceRef } from './types.js';

export type DropReason = 'no-marks' | 'unknown-id' | 'ungrounded';

export interface IdResolvers {
  exchange: (id: string) => { ref: SourceRef; text: string } | null;
  attempt: (id: number) => boolean;
}

export interface IdCitedLines {
  /** Kept lines, with the mark group exactly as the model wrote it. */
  lines: string[];
  /** Sources of every cited exchange, deduplicated, in first-seen order. */
  sources: SourceRef[];
  /** Cited attempt ids, deduplicated, in first-seen order. */
  attempts: number[];
  /** Lines that were dropped, with why. Blank lines are not reported. */
  dropped: Array<{ line: string; reason: DropReason }>;
}

/**
 * The trailing mark group. `[#<32 lowercase hex>]` and `[@<digits>]` marks,
 * comma separated. Numeric marks (digest style) deliberately do not match.
 */
const TRAILING_MARKS =
  /\[((?:#[0-9a-f]{32}|@\d+)(?:\s*,\s*(?:#[0-9a-f]{32}|@\d+))*)\]\s*$/;

/** Words too common to prove a line is about the exchange it cites. */
const STOP_WORDS = new Set([
  'that',
  'this',
  'with',
  'from',
  'have',
  'were',
  'they',
  'them',
  'their',
  'there',
  'then',
  'than',
  'when',
  'what',
  'which',
  'will',
  'would',
  'could',
  'should',
  'into',
  'about',
  'also',
  'just',
  'like',
  'some',
  'such',
  'only',
  'over',
  'very',
  'much',
  'more',
  'most',
  'does',
  'done',
  'been',
  'being',
  'each',
  'other',
  'same',
  'because',
  'before',
  'after',
  'while',
  'where',
  'here',
  'your',
  'yours',
]);

/** Distinct lowercase content tokens of four or more letters or digits. */
function contentTokens(text: string): Set<string> {
  const tokens = new Set<string>();
  for (const token of text.toLowerCase().split(/[^a-z0-9]+/)) {
    if (token.length < 4) continue;
    if (STOP_WORDS.has(token)) continue;
    tokens.add(token);
  }
  return tokens;
}

function sharedTokenCount(a: Set<string>, b: Set<string>): number {
  let count = 0;
  for (const token of a) if (b.has(token)) count++;
  return count;
}

/**
 * Parse and filter a model's cited body.
 *
 * `minGrounding` is `EPISODIC_MEMORY_LEARN_MIN_GROUNDING` (default 3).
 */
export function parseIdCitedLines(
  raw: string,
  resolve: IdResolvers,
  minGrounding: number
): IdCitedLines {
  const lines: string[] = [];
  const sources: SourceRef[] = [];
  const attempts: number[] = [];
  const dropped: Array<{ line: string; reason: DropReason }> = [];

  for (const rawLine of raw.split(/\r?\n/)) {
    const line = rawLine.replace(/^\s*(?:[-*•]\s+)?/, '').trimEnd();
    if (!line.trim()) continue;

    const match = TRAILING_MARKS.exec(line);
    if (!match) {
      dropped.push({ line, reason: 'no-marks' });
      continue;
    }

    const body = line.slice(0, match.index).trimEnd();
    const marksText = match[0].trim();
    const marks = match[1]
      .split(',')
      .map(mark => mark.trim())
      .filter(mark => mark.length > 0);

    const exchangeIds = marks.filter(mark => mark.startsWith('#')).map(mark => mark.slice(1));
    const attemptIds = marks.filter(mark => mark.startsWith('@')).map(mark => Number(mark.slice(1)));

    if (exchangeIds.length === 0) {
      dropped.push({ line, reason: 'no-marks' });
      continue;
    }

    const resolved: Array<{ ref: SourceRef; text: string }> = [];
    let unknown = false;
    for (const exchangeId of exchangeIds) {
      const hit = resolve.exchange(exchangeId);
      if (!hit) {
        unknown = true;
        break;
      }
      resolved.push(hit);
    }
    if (!unknown) {
      for (const attemptId of attemptIds) {
        if (!resolve.attempt(attemptId)) {
          unknown = true;
          break;
        }
      }
    }
    if (unknown) {
      dropped.push({ line, reason: 'unknown-id' });
      continue;
    }

    const bodyTokens = contentTokens(body);
    const grounded = resolved.some(hit => sharedTokenCount(bodyTokens, contentTokens(hit.text)) >= minGrounding);
    if (!grounded) {
      dropped.push({ line, reason: 'ungrounded' });
      continue;
    }

    lines.push(body ? `${body} ${marksText}` : marksText);
    for (const hit of resolved) {
      if (!sources.some(source => source.id === hit.ref.id)) sources.push(hit.ref);
    }
    for (const attemptId of attemptIds) {
      if (!attempts.includes(attemptId)) attempts.push(attemptId);
    }
  }

  return { lines, sources, attempts, dropped };
}
