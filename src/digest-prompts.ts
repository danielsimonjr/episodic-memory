import { SUMMARIZER_CONTEXT_MARKER } from './constants.js';
import type { ConversationExchange } from './types.js';
import type { DigestEntry } from './digest-db.js';
import { redactEntryText } from './digest-validate.js';

/** Per-exchange character cap, and a cap on the whole transcript, so one huge session cannot flood the prompt. */
const MAX_EXCHANGE_CHARS = 1500;
const MAX_PROMPT_CHARS = 48000;

/**
 * A summarizer prompt, with the numbers that the prompt uses.
 *
 * `marks` maps each number in `prompt` to the exchange id that the number stands for.
 */
export interface BuiltPrompt {
  prompt: string;
  /** Mark number used in the prompt -> exchange id. */
  marks: Map<number, string>;
}

const RULES = `Write the facts that a future session would need to continue this work.
Rules:
- One fact per line, plain text, no preamble, no headings.
- End every line with the numbers of the sources it comes from in square brackets, like [3] or [3,5].
- A line without source numbers is discarded. Never invent a source number.
- State decisions, causes, current state and open problems. Skip chatter and anything you are unsure of.`;

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}...` : text;
}

/**
 * Build the summarizer prompt for the exchanges of one session.
 *
 * Each exchange adds two lines, one for its user message and one for its assistant message. Both lines carry the exchange number. Secret-shaped tokens are replaced with `[redacted]`. After redaction, a message longer than 1500 characters keeps its first 1500 characters and ends with `...`.
 *
 * An exchange is skipped when its lines would take the total past 48000 characters. Skipped exchanges leave gaps in the numbering.
 */
export function buildSessionPrompt(exchanges: ConversationExchange[]): BuiltPrompt {
  const marks = new Map<number, string>();
  const blocks: string[] = [];
  let used = 0;
  exchanges.forEach((e, i) => {
    const n = i + 1;
    const block =
      `[${n}] User: ${clip(redactEntryText(e.userMessage), MAX_EXCHANGE_CHARS)}\n` +
      `[${n}] Agent: ${clip(redactEntryText(e.assistantMessage), MAX_EXCHANGE_CHARS)}`;
    if (used + block.length > MAX_PROMPT_CHARS) return;
    used += block.length;
    marks.set(n, e.id);
    blocks.push(block);
  });
  const prompt = `${SUMMARIZER_CONTEXT_MARKER}.\n\n${RULES}\n\nConversation:\n\n${blocks.join('\n\n')}\n`;
  return { prompt, marks };
}

/**
 * Build the summarizer prompt that merges the digest notes of one day or one week.
 *
 * A note can end with a source mark, such as `[#id,#id]`. The function renumbers each source mark from 1 in order of first use.
 * `marks` maps each new number to its original id. Blank lines are dropped.
 * A note without a trailing mark keeps its text and gets no number.
 */
export function buildCompressPrompt(entries: DigestEntry[], tier: 'day' | 'week'): BuiltPrompt {
  const marks = new Map<number, string>();
  const numberOf = new Map<string, number>();
  const lines: string[] = [];
  for (const e of entries) {
    for (const raw of e.text.split('\n')) {
      if (!raw.trim()) continue;
      const rewritten = raw.replace(/\[((?:#[^,\]\s]+)(?:,#[^,\]\s]+)*)\]\s*$/, (_m, group: string) => {
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
  const prompt =
    `${SUMMARIZER_CONTEXT_MARKER}.\n\n` +
    `Merge these notes from ${span} of work into fewer, shorter lines. Keep the facts a future session needs; drop repeats and superseded states.\n` +
    `${RULES}\n\nNotes:\n\n${lines.join('\n')}\n`;
  return { prompt, marks };
}
