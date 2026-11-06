/**
 * Citation gate for model-written learned text.
 *
 * Tool-using agents see real exchange ids. Their lines must end in a mark group
 * that names those ids: `[#<32 hex>,...]`. A reflection may add `[@<attemptId>]`
 * marks in the same group. The gate keeps a line only when all three
 * tests pass:
 *
 * - the line has at least one `#` mark;
 * - every mark resolves;
 * - the line shares enough content tokens with one cited exchange to make the
 *   citation meaningful.
 *
 * The module is pure. Callers inject the resolvers. The module reads no environment and imports only types.
 * The digest's text-only `parseCitedLines` is a separate function that owns the `[3,5]` mark-map form.
 */

import type { SourceRef } from './types.js';

/** One `#`/`@` mark inside a bracket group. */
const MARK = /#[0-9a-f]{32}|@\d+/;

/** The mark group a line must end with. Numeric `[7]` digest marks never match. */
const TRAILING_MARK_GROUP =
  /\[((?:#[0-9a-f]{32}|@\d+)(?:\s*,\s*(?:#[0-9a-f]{32}|@\d+))*)\]\s*$/;

/**
 * This pattern matches every mark group on the line, including ones before the
 * trailing group. A mid-line group is still a citation. An id in that group has
 * to resolve, or the gate drops the line. An unresolved id therefore cannot
 * survive in the stored body.
 */
const MARK_GROUP =
  /\[((?:#[0-9a-f]{32}|@\d+)(?:\s*,\s*(?:#[0-9a-f]{32}|@\d+))*)\]/g;

/** A content token: four or more lowercase letters or digits. */
const CONTENT_TOKEN = /[a-z0-9]{4,}/g;

/**
 * Words that carry no grounding signal. Kept short: the four-character and
 * length rules already drop most function words.
 */
const STOP_WORDS = new Set([
  'about',
  'after',
  'again',
  'against',
  'also',
  'because',
  'been',
  'before',
  'being',
  'between',
  'both',
  'could',
  'does',
  'doing',
  'during',
  'each',
  'from',
  'further',
  'have',
  'having',
  'here',
  'into',
  'itself',
  'just',
  'more',
  'most',
  'much',
  'must',
  'only',
  'other',
  'over',
  'same',
  'should',
  'some',
  'such',
  'than',
  'that',
  'their',
  'them',
  'then',
  'there',
  'these',
  'they',
  'this',
  'those',
  'through',
  'under',
  'until',
  'very',
  'were',
  'what',
  'when',
  'where',
  'which',
  'while',
  'will',
  'with',
  'would',
  'your',
]);

/** An exchange that an exchange mark resolves to. */
export interface ResolvedExchange {
  ref: SourceRef;
  /** The exchange text the grounding check compares against. */
  text: string;
}

/**
 * The lookups that parseIdCitedLines uses to resolve the marks of a line.
 *
 * The caller supplies the lookups, so the parser reads no store.
 */
export interface IdCitationResolver {
  /** Return the exchange for this id, or null when no such exchange exists. The id has no leading `#`. */
  exchange: (id: string) => ResolvedExchange | null;
  /** Return true when this attempt id exists. */
  attempt: (id: number) => boolean;
}

/**
 * The reason that the citation gate dropped a line.
 *
 * `no-marks` means the line has no usable citation group, or no text before the group.
 * `unknown-id` means that a mark does not resolve.
 * `ungrounded` means that no cited exchange shares enough content tokens with the line.
 */
export type DropReason = 'no-marks' | 'unknown-id' | 'ungrounded';

/** The result of parseIdCitedLines. */
export interface IdCitedLines {
  /** Kept lines, marks rewritten to the canonical `[#<id>,@<n>]` form. */
  lines: string[];
  /** Every exchange cited by a kept line, deduplicated, in first-seen order. */
  sources: SourceRef[];
  /** Every attempt id cited by a kept line, deduplicated, in first-seen order. */
  attempts: number[];
  /** Lines rejected, with the reason, in input order. */
  dropped: Array<{ line: string; reason: DropReason }>;
}

function contentTokens(text: string): Set<string> {
  const out = new Set<string>();
  for (const match of text.toLowerCase().matchAll(CONTENT_TOKEN)) {
    if (!STOP_WORDS.has(match[0])) out.add(match[0]);
  }
  return out;
}

function sharedTokenCount(a: Set<string>, b: Set<string>): number {
  let shared = 0;
  for (const token of a) if (b.has(token)) shared++;
  return shared;
}

function splitMarks(group: string): string[] {
  return group.split(',').map(mark => mark.trim()).filter(mark => MARK.test(mark));
}

/**
 * Split a model's answer into the lines the citation gate keeps.
 *
 * A kept line keeps its body and gets its marks rewritten to the canonical
 * form, so a downstream writer stores one citation shape. The function skips blank lines without counting them as drops.
 * The function reports every other rejected line with its reason.
 *
 * @param raw the model answer, one statement for each line
 * @param resolve looks up the exchange marks and the attempt marks
 * @param minGrounding the number of content tokens that a line must share with one cited exchange
 */
export function parseIdCitedLines(
  raw: string,
  resolve: IdCitationResolver,
  minGrounding: number
): IdCitedLines {
  const lines: string[] = [];
  const sources: SourceRef[] = [];
  const sourceIds = new Set<string>();
  const attempts: number[] = [];
  const attemptIds = new Set<number>();
  const dropped: Array<{ line: string; reason: DropReason }> = [];

  for (const rawLine of raw.split(/\r?\n/)) {
    const line = rawLine.replace(/^\s*(?:[-*\u2022]\s+)?/, '').trimEnd();
    if (!line.trim()) continue;

    const group = TRAILING_MARK_GROUP.exec(line);
    if (!group) {
      dropped.push({ line, reason: 'no-marks' });
      continue;
    }

    const body = line.slice(0, group.index).trimEnd();
    const marks = splitMarks(group[1]);
    const hasExchangeMark = marks.some(mark => mark.startsWith('#'));
    if (!body || !hasExchangeMark) {
      dropped.push({ line, reason: 'no-marks' });
      continue;
    }

    // Marks before the trailing group are not the citation that ends the line.
    // An unresolved mark still drops the line, so no unresolved mark reaches the body.
    const earlierMarks: string[] = [];
    for (const match of body.matchAll(MARK_GROUP)) earlierMarks.push(...splitMarks(match[1]));

    const citedExchanges: ResolvedExchange[] = [];
    const citedAttempts: number[] = [];
    let resolved = true;
    for (const mark of [...earlierMarks, ...marks]) {
      if (mark.startsWith('#')) {
        const found = resolve.exchange(mark.slice(1));
        if (!found) {
          resolved = false;
          break;
        }
        citedExchanges.push(found);
      } else {
        const id = Number(mark.slice(1));
        if (!Number.isInteger(id) || !resolve.attempt(id)) {
          resolved = false;
          break;
        }
        citedAttempts.push(id);
      }
    }
    if (!resolved) {
      dropped.push({ line, reason: 'unknown-id' });
      continue;
    }

    // Drop the mid-line groups from the stored body once they have resolved.
    // The code below writes the trailing group in canonical form. Leaving an earlier group
    // in place would keep a second citation shape, and its id is already in `sources`.
    const storedBody = body.replace(MARK_GROUP, ' ').replace(/[ \t]{2,}/g, ' ').trim();
    if (!storedBody) {
      dropped.push({ line, reason: 'no-marks' });
      continue;
    }

    const bodyTokens = contentTokens(storedBody);
    const grounded = citedExchanges.some(
      exchange => sharedTokenCount(bodyTokens, contentTokens(exchange.text)) >= minGrounding
    );
    if (!grounded) {
      dropped.push({ line, reason: 'ungrounded' });
      continue;
    }

    lines.push(`${storedBody} [${marks.join(',')}]`);
    for (const exchange of citedExchanges) {
      if (sourceIds.has(exchange.ref.id)) continue;
      sourceIds.add(exchange.ref.id);
      sources.push(exchange.ref);
    }
    for (const id of citedAttempts) {
      if (attemptIds.has(id)) continue;
      attemptIds.add(id);
      attempts.push(id);
    }
  }

  return { lines, sources, attempts, dropped };
}
