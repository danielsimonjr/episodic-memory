import { SUMMARIZER_CONTEXT_MARKER } from './constants.js';
import { redactEntryText } from './digest-validate.js';
/** Per-exchange character cap, and a cap on the whole transcript, so one huge session cannot flood the prompt. */
const MAX_EXCHANGE_CHARS = 1500;
const MAX_PROMPT_CHARS = 48000;
const RULES = `Write the facts that a future session would need to continue this work.
Rules:
- One fact per line, plain text, no preamble, no headings.
- End every line with the numbers of the sources it comes from in square brackets, like [3] or [3,5].
- A line without source numbers is discarded. Never invent a source number.
- State decisions, causes, current state and open problems. Skip chatter and anything you are unsure of.`;
function clip(text, max) {
    return text.length > max ? `${text.slice(0, max)}...` : text;
}
/**
 * Number the exchanges of one session and build their transcript block.
 *
 * Each exchange adds two lines, one for its user message and one for its assistant message. Both lines carry the exchange number. Secret-shaped tokens are replaced with `[redacted]`. After redaction, a message longer than 1500 characters keeps its first 1500 characters and ends with `...`.
 *
 * An exchange is skipped when its lines would take the total past `maxChars`. The loop goes on to the next exchange, so a later small exchange can still fit. Skipped exchanges leave gaps in the numbering. The blocks are joined by a blank line.
 *
 * With `dated`, the user line also carries the UTC date of the exchange (`[1] 2026-06-26 User: ...`). Each
 * footnote of a topic document states a time. Therefore, the topic prompt needs the date. The cap counts the date.
 *
 * @param exchanges the exchanges, oldest first
 * @param maxChars the cap on the length of the returned text, the blank lines between blocks included
 * @param opts `dated` adds the date of each exchange to its user line
 * @returns the transcript text and the mark number -> exchange id map
 */
export function numberExchanges(exchanges, maxChars, opts = {}) {
    const marks = new Map();
    const blocks = [];
    let used = 0;
    exchanges.forEach((e, i) => {
        const n = i + 1;
        const date = opts.dated ? `${e.timestamp.slice(0, 10)} ` : '';
        const block = `[${n}] ${date}User: ${clip(redactEntryText(e.userMessage), MAX_EXCHANGE_CHARS)}\n` +
            `[${n}] Agent: ${clip(redactEntryText(e.assistantMessage), MAX_EXCHANGE_CHARS)}`;
        // The blank line between two blocks counts too, so the cap bounds the whole text.
        const cost = block.length + (blocks.length > 0 ? 2 : 0);
        if (used + cost > maxChars)
            return;
        used += cost;
        marks.set(n, e.id);
        blocks.push(block);
    });
    return { text: blocks.join('\n\n'), marks };
}
/**
 * Build the summarizer prompt for the exchanges of one session.
 *
 * The transcript comes from `numberExchanges`. The transcript cap defaults to 48000 characters.
 *
 * @param exchanges the exchanges, oldest first
 * @param maxChars the cap on the transcript text, 48000 by default
 */
export function buildSessionPrompt(exchanges, maxChars = MAX_PROMPT_CHARS) {
    const { text, marks } = numberExchanges(exchanges, maxChars);
    const prompt = `${SUMMARIZER_CONTEXT_MARKER}.\n\n${RULES}\n\nConversation:\n\n${text}\n`;
    return { prompt, marks };
}
/**
 * Build the summarizer prompt that merges the digest notes of one day or one week.
 *
 * A note can end with a source mark, such as `[#id,#id]`. A note can also hold a source mark before its end, one for
 * each statement. The function renumbers each source mark from 1 in order of first use.
 * `marks` maps each new number to its original id. Blank lines are dropped.
 * A note without a source mark keeps its text and gets no number.
 */
export function buildCompressPrompt(entries, tier) {
    const marks = new Map();
    const numberOf = new Map();
    const lines = [];
    for (const e of entries) {
        for (const raw of e.text.split('\n')) {
            if (!raw.trim())
                continue;
            const rewritten = raw.replace(/\[((?:#[^,\]\s]+)(?:,#[^,\]\s]+)*)\]/g, (_m, group) => {
                const nums = group.split(',').map(tok => {
                    const id = tok.slice(1);
                    let n = numberOf.get(id);
                    if (n === undefined) {
                        n = numberOf.size + 1;
                        numberOf.set(id, n);
                        marks.set(n, id);
                    }
                    return n;
                });
                return `[${nums.join(',')}]`;
            });
            lines.push(rewritten);
        }
    }
    const span = tier === 'day' ? 'one day' : 'one week';
    const prompt = `${SUMMARIZER_CONTEXT_MARKER}.\n\n` +
        `Merge these notes from ${span} of work into fewer, shorter lines. Keep the facts a future session needs; drop repeats and superseded states.\n` +
        `${RULES}\n\nNotes:\n\n${lines.join('\n')}\n`;
    return { prompt, marks };
}
