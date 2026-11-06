import { hideCitedLines, listActiveEntries } from './digest-db.js';
/** The default digest character limit. `digestMaxChars` uses the default value when the environment value is not a positive integer. */
export const DEFAULT_DIGEST_MAX_CHARS = 6000;
const HEADER = 'Digest of earlier sessions in this project. Each line ends with [#id] marks naming its source exchanges.\n' +
    'To see a source, call the episodic-memory digest tool with expand set to the id, then read the returned path and lines.\n';
/** The archive project key for a working directory: every non-alphanumeric character becomes a hyphen. */
export function projectKeyFromCwd(cwd) {
    return cwd.replace(/[^A-Za-z0-9]/g, '-');
}
/**
 * Returns the digest character limit from the `EPISODIC_MEMORY_DIGEST_MAX_CHARS` environment variable.
 *
 * Returns DEFAULT_DIGEST_MAX_CHARS when the variable is unset or is not a positive integer.
 */
export function digestMaxChars() {
    const n = Number(process.env.EPISODIC_MEMORY_DIGEST_MAX_CHARS);
    return Number.isInteger(n) && n > 0 ? n : DEFAULT_DIGEST_MAX_CHARS;
}
function label(e) {
    if (e.handoff)
        return 'Handoff note';
    const day = e.periodStart.slice(0, 10);
    return e.tier === 'session' ? `Session ${day}` : e.tier === 'day' ? `Day ${day}` : `Week of ${day}`;
}
/**
 * The digest for one project, within maxChars. Order: handoff notes first, then newest entries first.
 * Stops before the first entry that does not fit, so the oldest entries drop first and the text ends on a
 * whole entry. Returns an empty string when nothing fits.
 *
 * `opts.hideExchangeIds` drops every line citing one of those ids, and then
 * drops an entry whose lines are all gone. The learn solver passes a task's
 * source exchange ids here so the digest cannot hand back its answer.
 */
export function buildDigestText(db, project, maxChars, opts = {}) {
    const hide = opts.hideExchangeIds;
    const entries = listActiveEntries(db, project);
    const handoffs = entries.filter(e => e.handoff);
    const rest = entries.filter(e => !e.handoff).sort((a, b) => (a.periodEnd < b.periodEnd ? 1 : a.periodEnd > b.periodEnd ? -1 : b.id - a.id));
    let out = HEADER + '\n';
    let added = 0;
    for (const e of [...handoffs, ...rest]) {
        const visible = hideCitedLines(e.text.trim(), hide);
        if (!visible.trim())
            continue;
        const b = `## ${label(e)}\n${visible}\n\n`;
        if (out.length + b.length > maxChars)
            break;
        out += b;
        added++;
    }
    return added === 0 ? '' : out;
}
