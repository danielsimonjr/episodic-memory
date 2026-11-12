import type { ConversationExchange } from './types.js';
import type { TopicBlock } from './topic-validate.js';
/** One stored document, as the prompt needs it. */
export interface TopicPromptDoc {
    slug: string;
    title: string;
    headings: string[];
    text: string;
    updatedAt: string;
}
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
export declare function buildTopicPrompt(input: {
    exchanges: ConversationExchange[];
    docs: TopicPromptDoc[];
    maxTranscriptChars: number;
    maxDocsChars: number;
    budgetChars: number;
}): {
    prompt: string;
    marks: Map<number, string>;
    shown: Map<string, string>;
} | null;
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
export declare function parseTopicAnswer(answer: string): {
    blocks: TopicBlock[];
    errors: string[];
};
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
export declare function prepareTopicEdit(input: {
    project: string;
    blocks: TopicBlock[];
    marks: ReadonlyMap<number, string>;
    before: ReadonlyMap<string, string>;
}): TopicBlock[];
