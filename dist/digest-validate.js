import { redactSecrets } from './redact.js';
const TRAILING_MARKS = /\s*\[(\d+(?:\s*,\s*\d+)*)\]\s*$/;
/**
 * Keep only model lines that end in a mark group such as `[3,5]` where every mark names a real
 * exchange. A line with no group, or with any unknown mark, is dropped whole.
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
/** Always redact digest text. Unlike maybeRedactSecrets this ignores the opt-in env: the digest is injected into new sessions. */
export function redactEntryText(text) {
    return redactSecrets(text);
}
