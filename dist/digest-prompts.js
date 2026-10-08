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
export function buildSessionPrompt(exchanges) {
    const marks = new Map();
    const blocks = [];
    let used = 0;
    exchanges.forEach((e, i) => {
        const n = i + 1;
        const block = `[${n}] User: ${clip(redactEntryText(e.userMessage), MAX_EXCHANGE_CHARS)}\n` +
            `[${n}] Agent: ${clip(redactEntryText(e.assistantMessage), MAX_EXCHANGE_CHARS)}`;
        if (used + block.length > MAX_PROMPT_CHARS)
            return;
        used += block.length;
        marks.set(n, e.id);
        blocks.push(block);
    });
    const prompt = `${SUMMARIZER_CONTEXT_MARKER}.\n\n${RULES}\n\nConversation:\n\n${blocks.join('\n\n')}\n`;
    return { prompt, marks };
}
export function buildCompressPrompt(entries, tier) {
    const marks = new Map();
    const numberOf = new Map();
    const lines = [];
    for (const e of entries) {
        for (const raw of e.text.split('\n')) {
            if (!raw.trim())
                continue;
            const rewritten = raw.replace(/\[((?:#[^,\]\s]+)(?:,#[^,\]\s]+)*)\]\s*$/, (_m, group) => {
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
