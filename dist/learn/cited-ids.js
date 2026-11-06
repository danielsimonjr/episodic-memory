/**
 * Citation gate for model-written learned text.
 *
 * Tool-using agents see real exchange ids, so their lines must end in a mark
 * group naming those ids: `[#<32 hex>,...]`, and a reflection may add
 * `[@<attemptId>]` marks in the same group. A line survives only when it has at
 * least one `#` mark, every mark resolves, and the line shares enough content
 * tokens with one cited exchange to make the citation meaningful.
 *
 * This module is pure: the resolvers are injected, it reads no environment, and
 * it imports only types. The digest's text-only `parseCitedLines` is untouched
 * and still owns the `[3,5]` mark-map form.
 */
/** The mark group a line must end with. Numeric `[7]` digest marks never match. */
const TRAILING_MARK_GROUP = /\[((?:#[0-9a-f]{32}|@\d+)(?:\s*,\s*(?:#[0-9a-f]{32}|@\d+))*)\]\s*$/;
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
function contentTokens(text) {
    const out = new Set();
    for (const match of text.toLowerCase().matchAll(CONTENT_TOKEN)) {
        if (!STOP_WORDS.has(match[0]))
            out.add(match[0]);
    }
    return out;
}
function sharedTokenCount(a, b) {
    let shared = 0;
    for (const token of a)
        if (b.has(token))
            shared++;
    return shared;
}
/**
 * Split a model's answer into the lines the citation gate keeps.
 *
 * A kept line keeps its body and gets its marks rewritten to the canonical
 * form, so a downstream writer stores one citation shape. Blank lines are
 * skipped without counting as drops; every other rejected line is reported
 * with its reason.
 */
export function parseIdCitedLines(raw, resolve, minGrounding) {
    const lines = [];
    const sources = [];
    const sourceIds = new Set();
    const attempts = [];
    const attemptIds = new Set();
    const dropped = [];
    for (const rawLine of raw.split(/\r?\n/)) {
        const line = rawLine.replace(/^\s*(?:[-*\u2022]\s+)?/, '').trimEnd();
        if (!line.trim())
            continue;
        const group = TRAILING_MARK_GROUP.exec(line);
        if (!group) {
            dropped.push({ line, reason: 'no-marks' });
            continue;
        }
        const body = line.slice(0, group.index).trimEnd();
        const marks = group[1].split(',').map(mark => mark.trim());
        const hasExchangeMark = marks.some(mark => mark.startsWith('#'));
        if (!body || !hasExchangeMark) {
            dropped.push({ line, reason: 'no-marks' });
            continue;
        }
        const citedExchanges = [];
        const citedAttempts = [];
        let resolved = true;
        for (const mark of marks) {
            if (mark.startsWith('#')) {
                const found = resolve.exchange(mark.slice(1));
                if (!found) {
                    resolved = false;
                    break;
                }
                citedExchanges.push(found);
            }
            else {
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
        const bodyTokens = contentTokens(body);
        const grounded = citedExchanges.some(exchange => sharedTokenCount(bodyTokens, contentTokens(exchange.text)) >= minGrounding);
        if (!grounded) {
            dropped.push({ line, reason: 'ungrounded' });
            continue;
        }
        lines.push(`${body} [${marks.join(',')}]`);
        for (const exchange of citedExchanges) {
            if (sourceIds.has(exchange.ref.id))
                continue;
            sourceIds.add(exchange.ref.id);
            sources.push(exchange.ref);
        }
        for (const id of citedAttempts) {
            if (attemptIds.has(id))
                continue;
            attemptIds.add(id);
            attempts.push(id);
        }
    }
    return { lines, sources, attempts, dropped };
}
