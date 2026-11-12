import { SUMMARIZER_CONTEXT_MARKER } from './constants.js';
import { numberExchanges } from './digest-prompts.js';
import { redactEntryText } from './digest-validate.js';
import { assignUnitIds, fenceStep, parseTopicDoc, rewriteLinkSlugs, rewriteMarks, serializeTopicDoc, } from './topic-format.js';
/** The rules of the topic prompt. One rule per line. */
const TOPIC_RULES = [
    'Keep the topic documents of this project up to date with the conversation.',
    'Answer with zero or more blocks. Each block has one of these two forms:',
    '=== FILE <slug>',
    '<the complete new text of the document>',
    '=== END',
    '=== DELETE <slug>',
    'Rules:',
    '- Text outside the blocks does not matter.',
    '- If the conversation adds nothing, answer with the single word NOTHING.',
    '- Edit or delete only the documents shown in full.',
    '- Each document has one level-1 heading, and the heading is the first line.',
    '- Write plain paragraphs only. Do not write bullet lists, numbered lists or tables.',
    '- Each paragraph ends with its own footnote reference, such as [^1] or [^1][^2].',
    '- Each footnote label is used on one paragraph only. The first paragraph gets [^1], the next gets [^2], and so on. Never put the same label on two paragraphs.',
    '- Write each footnote definition on its own line, after the last paragraph, in this form: [^n]: Time: <time>; Sources: <refs>',
    '- In a footnote definition, Time is YYYY, YYYY-MM or YYYY-MM-DD. Sources are conversation numbers (or #ids already in the document) separated by commas. Write no period after the last source.',
    '- Each turn of the conversation starts with its number and its date.',
    '- Time is the date of the conversation turns that the footnote cites, unless the conversation states another time for the event.',
    '- Always end each document with a line that says === END.',
    '- A link has this form: [text](slug.md#^id).',
    '- Keep the ^id line of every paragraph that you keep.',
    '- A new paragraph has no ^id line.',
    '- Never drop a source that a document already cites.',
    '- A slug uses lowercase letters, digits and hyphens only.',
    '- Write no line that starts with ===, except in a block header.',
    'Example of one correct block:',
    '=== FILE example-topic',
    '# Example topic',
    '',
    'The build runs on a Linux runner. [^1]',
    '',
    'The team chose Postgres over MySQL. [^2]',
    '',
    '[^1]: Time: 2024-03-08; Sources: 2, 4',
    '[^2]: Time: 2024-03; Sources: 5',
    '=== END',
].join('\n');
const FILE_OPEN = /^=== FILE(?:\s+(.*))?$/;
const DELETE_OPEN = /^=== DELETE(?:\s+(.*))?$/;
const END_LINE = /^=== END\s*$/;
/**
 * Build the prompt of one session edit: the rules, the inventory of every document, the full text of
 * the documents that fit, and the numbered transcript.
 *
 * The function sorts the documents most recently updated first. The full text is shown for the documents
 * in that order, while their text lengths stay within `maxDocsChars`. The first document that does not fit
 * stops the cut. When the prompt is over `budgetChars`, the function drops the last shown document (the
 * oldest) and builds the prompt again, until it fits. With no document shown and the prompt still over the
 * budget, it shortens the transcript to the room left. Each inventory line is cut to 240 characters. The
 * function returns null when no exchange fits the transcript.
 *
 * @param input the exchanges, the documents and the limits
 * @returns the prompt, the mark numbers of the transcript, and the slug -> updatedAt map of the shown documents
 */
export function buildTopicPrompt(input) {
    const { text: transcript, marks } = numberExchanges(input.exchanges, input.maxTranscriptChars, { dated: true });
    if (marks.size === 0)
        return null;
    // Most recently updated first, whatever the caller's order. The sort is stable for equal times.
    const docs = [...input.docs].sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0));
    const inventory = docs.map(d => cutLine(`- ${d.slug}: ${d.title} | ${d.headings.join(' / ')}`, INVENTORY_LINE_CHARS));
    const candidates = [];
    let used = 0;
    for (const doc of docs) {
        if (used + doc.text.length > input.maxDocsChars)
            break;
        used += doc.text.length;
        candidates.push(doc);
    }
    for (let count = candidates.length;; count--) {
        const shown = candidates.slice(0, count);
        const prompt = renderTopicPrompt(inventory, shown, transcript);
        if (prompt.length <= input.budgetChars) {
            return {
                prompt,
                marks,
                shown: new Map(shown.map(doc => [doc.slug, doc.updatedAt])),
            };
        }
        if (count === 0)
            break;
    }
    // Nothing shown and still over budget: shorten the transcript to the room left.
    const room = input.budgetChars - renderTopicPrompt(inventory, [], '').length;
    const short = numberExchanges(input.exchanges, Math.max(0, Math.min(input.maxTranscriptChars, room)), { dated: true });
    if (short.marks.size === 0)
        return null;
    return { prompt: renderTopicPrompt(inventory, [], short.text), marks: short.marks, shown: new Map() };
}
/** The longest inventory line. A longer line ends with an ellipsis. */
const INVENTORY_LINE_CHARS = 240;
function cutLine(line, max) {
    return line.length > max ? `${line.slice(0, max - 1)}\u2026` : line;
}
/** Write the prompt sections, in order. A shown document has the form of an answer block. */
function renderTopicPrompt(inventory, shown, transcript) {
    const inventoryText = inventory.length > 0 ? inventory.join('\n') : '(none)';
    const shownText = shown.length > 0
        ? shown.map(doc => `=== FILE ${doc.slug}\n${documentBody(doc.text)}=== END`).join('\n\n')
        : '(none)';
    return ([
        `${SUMMARIZER_CONTEXT_MARKER}.`,
        TOPIC_RULES,
        `Inventory:\n${inventoryText}`,
        `Documents shown in full:\n${shownText}`,
        `Conversation:\n\n${transcript}`,
    ].join('\n\n') + '\n');
}
/** The text of a document with a final newline, or nothing for an empty document. */
function documentBody(text) {
    if (text === '')
        return '';
    return text.endsWith('\n') ? text : `${text}\n`;
}
/**
 * Read the blocks of a model answer.
 *
 * A `=== FILE <slug>` line opens a block. Its text is every line up to the next line that is `=== END`
 * (trailing spaces allowed), joined by `\n`, with a final `\n`. A `=== DELETE <slug>` line is a delete
 * block. Other lines outside the blocks are ignored. A FILE block that meets the end of the answer, or
 * another `=== FILE` or `=== DELETE` line before its `=== END`, adds an error and is dropped. The line that
 * meets it opens its own block. Inside a fenced code block of a FILE block, `===` lines are text; a fence
 * that is still open at the end of the answer leaves the block unterminated. The function does not
 * validate the slugs.
 *
 * @param answer the text of the model answer
 */
export function parseTopicAnswer(answer) {
    const blocks = [];
    const errors = [];
    let open = null;
    for (const line of answer.split(/\r?\n/)) {
        if (open !== null) {
            if (open.fence !== null) {
                open.lines.push(line);
                open.fence = fenceStep(open.fence, line);
                continue;
            }
            if (END_LINE.test(line)) {
                blocks.push({ kind: 'file', slug: open.slug, text: `${open.lines.join('\n')}\n` });
                open = null;
                continue;
            }
            if (!FILE_OPEN.test(line) && !DELETE_OPEN.test(line)) {
                open.lines.push(line);
                open.fence = fenceStep(null, line);
                continue;
            }
            errors.push(`unterminated FILE block for ${open.slug}`);
            open = null;
        }
        const file = FILE_OPEN.exec(line);
        if (file) {
            open = { slug: (file[1] ?? '').trim(), lines: [], fence: null };
            continue;
        }
        const remove = DELETE_OPEN.exec(line);
        if (remove)
            blocks.push({ kind: 'delete', slug: (remove[1] ?? '').trim() });
    }
    if (open !== null)
        errors.push(`unterminated FILE block for ${open.slug}`);
    return { blocks, errors };
}
/**
 * Prepare the FILE blocks of an answer for validation.
 *
 * For each FILE block, in order, the function rewrites the mark numbers to `#<exchange id>`, redacts the
 * secrets, and gives each new paragraph an identifier. An identifier that an untouched document uses, or
 * that another block of this edit uses, is never given to a new paragraph. The function then rewrites the
 * slug of each link to the document that holds the unit after the edit. DELETE blocks pass through. The
 * function does not validate the result.
 *
 * @param input the project, the answer blocks, the mark map of the prompt, and the stored text of each document before the edit
 */
export function prepareTopicEdit(input) {
    const { project, marks, before } = input;
    // A document that a block names, a FILE or a DELETE, is touched by the edit.
    const touched = new Set(input.blocks.map(block => block.slug));
    const untouched = [...before].filter(([slug]) => !touched.has(slug));
    const untouchedUnits = untouched.map(([slug, text]) => ({
        slug,
        units: parseTopicDoc(slug, text).units,
    }));
    // Every identifier that a kept document uses: the untouched documents and the explicit ids of each FILE block.
    const taken = new Set();
    for (const { units } of untouchedUnits) {
        for (const unit of units)
            if (unit.unitId !== null)
                taken.add(unit.unitId);
    }
    const rewritten = input.blocks.map(block => block.kind === 'file' ? { ...block, text: redactOutsideLinkTargets(rewriteMarks(block.text, marks)) } : block);
    for (const block of rewritten) {
        if (block.kind !== 'file')
            continue;
        for (const unit of parseTopicDoc(block.slug, block.text).units) {
            if (unit.unitId !== null)
                taken.add(unit.unitId);
        }
    }
    const prepared = [];
    for (const block of rewritten) {
        if (block.kind !== 'file') {
            prepared.push(block);
            continue;
        }
        const parsed = parseTopicDoc(block.slug, block.text);
        if (parsed.errors.length > 0) {
            // A malformed definition would lose its text in the canonical layout. Keep the model's text,
            // so validation rejects it and the retry message quotes what the model wrote.
            prepared.push(block);
            continue;
        }
        const doc = assignUnitIds(project, block.slug, parsed, taken);
        for (const unit of doc.units)
            if (unit.unitId !== null)
                taken.add(unit.unitId);
        prepared.push({ kind: 'file', slug: block.slug, text: serializeTopicDoc(doc) });
    }
    // The slug of each unit in the project after the edit: the untouched documents, then the prepared FILE blocks.
    const slugOfUnit = new Map();
    for (const { slug, units } of untouchedUnits) {
        for (const unit of units)
            if (unit.unitId !== null)
                slugOfUnit.set(unit.unitId, slug);
    }
    for (const block of prepared) {
        if (block.kind !== 'file')
            continue;
        for (const unit of parseTopicDoc(block.slug, block.text).units) {
            if (unit.unitId !== null)
                slugOfUnit.set(unit.unitId, block.slug);
        }
    }
    return prepared.map(block => block.kind === 'file' ? { ...block, text: rewriteLinkSlugs(block.text, slugOfUnit) } : block);
}
/** A Markdown link target, `](...)`, as one split part. */
const LINK_TARGET = /(\]\([^()\s]*\))/;
/** Redact the secrets of a text, but keep each link target as written, so a slug is never replaced. */
function redactOutsideLinkTargets(text) {
    return text
        .split(LINK_TARGET)
        .map((part, i) => (i % 2 === 1 ? part : redactEntryText(part)))
        .join('');
}
