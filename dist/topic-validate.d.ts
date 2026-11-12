/** The form of a document slug. */
export declare const SLUG_PATTERN: RegExp;
/** The reserved slug of the example block in the topic prompt. A document never uses the reserved slug. Check 1 rejects a FILE block with the reserved slug. */
export declare const EXAMPLE_SLUG = "example-topic";
/** One staged block of a model answer: a new text for a document, or the removal of a document. */
export type TopicBlock = {
    kind: 'file';
    slug: string;
    text: string;
} | {
    kind: 'delete';
    slug: string;
};
/** The inputs of one validation. */
export interface TopicEditInput {
    /** The stored text of each document before the edit, by slug. */
    before: ReadonlyMap<string, string>;
    /** The prepared blocks of the answer, in answer order. */
    blocks: readonly TopicBlock[];
    /** The slugs whose full text was in the prompt. */
    shown: ReadonlySet<string>;
    /** Tell whether an exchange id exists in the project. The id has no `#`. */
    exchangeExists: (id: string) => boolean;
    /** The size limits of the project. */
    limits: {
        maxDocChars: number;
        maxDocs: number;
    };
}
/**
 * Check one staged edit against the project state after the edit.
 *
 * The function returns one line for each failed item. Each line starts with `check <n>:`, the number of
 * the check in the design, then the slug and the item. An empty list accepts the edit. The function
 * does not change its input and does not write anything.
 *
 * Checks 4 to 7 and the size of each document run on the documents that the edit writes. Checks 8
 * to 11 run on every document of the project after the edit.
 *
 * @param input the prior state, the staged blocks and the limits
 */
export declare function validateTopicEdit(input: TopicEditInput): string[];
