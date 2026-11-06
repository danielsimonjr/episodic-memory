import { redactSecrets } from './redact.js';
const TRAILING_MARKS = /\s*\[(\d+(?:\s*,\s*\d+)*)\]\s*$/;
/**
 * Keep the model lines that cite only known exchanges, and rewrite their marks.
 *
 * A kept line ends in a mark group such as `[3,5]`. Each number in the group must be a key of `marks`.
 * The function removes a leading bullet marker from each line and skips blank lines without counting them.
 * The function drops a line that has no mark group, that cites an unknown number, or that has no text before the group.
 * The function rewrites the mark group of a kept line to `[#<exchangeId>,#<exchangeId>]`.
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
        const ids = [];
        let ok = true;
        for (const n of m[1].split(',')) {
            const id = marks.get(Number(n.trim()));
            if (id === undefined) {
                ok = false;
                break;
            }
            ids.push(id);
        }
        if (!ok) {
            dropped++;
            continue;
        }
        const body = line.slice(0, m.index).trimEnd();
        if (!body) {
            dropped++;
            continue;
        }
        lines.push(`${body} [${ids.map(i => `#${i}`).join(',')}]`);
        for (const id of ids)
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
