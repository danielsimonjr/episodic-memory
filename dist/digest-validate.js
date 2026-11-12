import { redactSecrets } from './redact.js';
const TRAILING_MARKS = /\s*\[(\d+(?:\s*,\s*\d+)*)\]\s*$/;
/**
 * A run of mark groups inside the line, such as `[1]` or `[2][3]`. No word character and no `]` comes before
 * the run, so `argv[1]` and `matrix[i][1]` are not marks. A `(` after the run makes the run a link, not a mark.
 */
const INNER_MARK_RUN = /(?<![\w\]])(?:\[\d+(?:\s*,\s*\d+)*\])+(?!\()/g;
/** One mark group of a run. */
const MARK_GROUP = /\[(\d+(?:\s*,\s*\d+)*)\]/g;
/** Map the numbers of one mark group to exchange ids. Return null when one number is not a key of `marks`. */
function markIds(group, marks) {
    const ids = [];
    for (const n of group.split(',')) {
        const id = marks.get(Number(n.trim()));
        if (id === undefined)
            return null;
        ids.push(id);
    }
    return ids;
}
/** Write a list of exchange ids in the stable mark form `[#<exchangeId>,#<exchangeId>]`. */
function stableMark(ids) {
    return `[${ids.map(i => `#${i}`).join(',')}]`;
}
/**
 * Keep the model lines that cite only known exchanges, and rewrite their marks.
 *
 * A kept line ends in a mark group such as `[3,5]`. Each number in the group must be a key of `marks`.
 * A line can also hold mark groups before its end, one for each statement. No word character and no `]` comes
 * before such a group. Each number in these groups must also be a key of `marks`. The function therefore reads a
 * number in brackets after a space as a mark: `the index [0]` drops the line when 0 is not a key of `marks`.
 * The function removes a leading bullet marker from each line and skips blank lines without counting them.
 * The function drops a line with no mark group.
 * The function also drops a line that cites an unknown number, and a line with no text before the group.
 * The function rewrites each mark group of a kept line to `[#<exchangeId>,#<exchangeId>]`.
 *
 * @param raw the model output. Each line holds one statement.
 * @param marks maps each mark number to the exchange id that the number names
 */
export function parseCitedLines(raw, marks) {
    const lines = [];
    const sources = [];
    let dropped = 0;
    for (const rawLine of raw.split(/\r?\n/)) {
        const line = rawLine.replace(/^\s*(?:[-*•]\s+)?/, '').trimEnd();
        if (!line.trim())
            continue;
        const m = TRAILING_MARKS.exec(line);
        if (!m) {
            dropped++;
            continue;
        }
        const ids = markIds(m[1], marks);
        if (!ids) {
            dropped++;
            continue;
        }
        // A line can hold several statements, each with its own mark group. Rewrite the inner groups too.
        const cited = [];
        let unknown = false;
        const body = line
            .slice(0, m.index)
            .trimEnd()
            .replace(INNER_MARK_RUN, run => run.replace(MARK_GROUP, (group, numbers) => {
            const inner = markIds(numbers, marks);
            if (!inner) {
                unknown = true;
                return group;
            }
            cited.push(...inner);
            return stableMark(inner);
        }));
        if (unknown || !body) {
            dropped++;
            continue;
        }
        lines.push(`${body} ${stableMark(ids)}`);
        for (const id of [...cited, ...ids])
            if (!sources.includes(id))
                sources.push(id);
    }
    return { lines, sources, dropped };
}
/**
 * Redact the secrets in digest text. The function always redacts.
 *
 * Unlike maybeRedactSecrets, the function does not check the EPISODIC_MEMORY_REDACT_SECRETS setting,
 * because digest text reaches new sessions.
 */
export function redactEntryText(text) {
    return redactSecrets(text);
}
