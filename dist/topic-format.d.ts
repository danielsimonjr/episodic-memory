import { UNIT_ID_PATTERN, isValidTime } from './topic-time.js';
export { UNIT_ID_PATTERN, isValidTime };
/** A footnote definition: the label, the event time and the refs that support the statement. */
export interface TopicFootnote {
    label: string;
    /** The raw time text. The validator checks its form. */
    time: string;
    /** Raw refs: a mark number such as `3`, or an exchange id such as `#ex-111`. */
    refs: string[];
}
/** A link from a paragraph to a paragraph of a document. */
export interface TopicLink {
    /** The slug of the target document. */
    slug: string;
    /** The raw identifier of the target paragraph. */
    unitId: string;
}
/** One paragraph of a document. */
export interface TopicUnit {
    /** The identifier as written, or null when the paragraph has none. */
    unitId: string | null;
    /** The heading path joined by ` > `. An empty string means no heading. */
    heading: string;
    /** The heading names from the outermost heading to the innermost. */
    path: string[];
    /** The paragraph text, without the identifier line. */
    text: string;
    /** Every footnote reference in the text, in order, with repeats. */
    footnoteRefs: string[];
    /** The labels of the footnote references in the text, in order, without repeats. */
    footnoteLabels: string[];
    /** The definitions of the labels in `footnoteLabels` that have a definition. */
    footnotes: TopicFootnote[];
    /** The links in the text, in order. */
    links: TopicLink[];
    /** The `.md` link targets that do not have the form `<slug>.md#^<unit id>`, in order. */
    malformedLinks: string[];
}
/**
 * One step of the outline: a heading as written, a fenced code block kept verbatim,
 * or a paragraph by its index in `units`.
 */
export type TopicOutlineItem = {
    kind: 'heading';
    level: number;
    name: string;
} | {
    kind: 'code';
    lines: string[];
} | {
    kind: 'unit';
    index: number;
};
/** A parsed document. */
export interface TopicDoc {
    /** The text of the first level-one heading, or an empty string. */
    title: string;
    /** The number of level-one headings in the document. */
    h1Count: number;
    /** True when the first non-blank line is a level-one heading. */
    titleFirst: boolean;
    /** The headings and paragraphs in document order. The serializer walks this list. */
    outline: TopicOutlineItem[];
    /** The paragraphs in document order. */
    units: TopicUnit[];
    /** Every footnote definition in document order. */
    definitions: TopicFootnote[];
    /** Malformed definitions and repeated labels, one message each. */
    errors: string[];
}
/**
 * Parse the text of one document into its title, paragraphs and footnote definitions.
 *
 * A paragraph is a run of text lines between blank lines, headings and definitions. The last line
 * of a paragraph is its identifier when the paragraph has more than one line and that line is `^<id>`.
 * The heading path holds every heading above the paragraph, the title included.
 * The function keeps malformed data. It records a malformed definition in `errors` and keeps it.
 *
 * @param slug the slug of the document. Error messages start with it.
 * @param text the Markdown text of the document
 */
export declare function parseTopicDoc(slug: string, text: string): TopicDoc;
/**
 * Write a document in the canonical layout.
 *
 * The function walks the outline. It writes each heading at its parsed level, and each paragraph
 * with its identifier line, in the order of the input. It writes a fenced code block verbatim. Every
 * definition follows, in definition order. Blocks are separated by one blank line. The output keeps the heading levels, the order and the
 * count of level-one headings, so a second parse gives the same structure. A malformed definition
 * is written with an empty time and no refs, and the checks still reject it.
 *
 * @param doc the document to write
 */
export declare function serializeTopicDoc(doc: TopicDoc): string;
/**
 * Give each paragraph without an identifier a new one, and return the new document.
 *
 * The identifier is the first 8 hex characters of the SHA-1 of the project, slug and text, joined by
 * NUL. When that identifier is taken, the function hashes the same input with a counter (1, 2, ...)
 * until it finds a free identifier. Each identifier that the function assigns joins the taken set,
 * so two identical paragraphs in one document get two identifiers. The function keeps every identifier
 * that the document already has. The input document does not change.
 *
 * @param project the project key
 * @param slug the slug of the document
 * @param doc the parsed document
 * @param takenIds the identifiers that other paragraphs of the project already use
 */
export declare function assignUnitIds(project: string, slug: string, doc: TopicDoc, takenIds: ReadonlySet<string>): TopicDoc;
/**
 * Give each footnote label of a paragraph the statement that it supports.
 *
 * The statement is the text from the end of the previous reference (or the start of the paragraph)
 * to the first reference of the label. The function returns the whole paragraph when that text is empty.
 *
 * @param text the paragraph text
 */
export declare function footnoteStatements(text: string): Map<string, string>;
/**
 * Rewrite each footnote ref that is a bare mark number to the exchange id that the number stands for.
 *
 * Only the Sources part of a footnote definition is rewritten. A definition that does not have the
 * `Time: ...; Sources: ...` form is kept. A number that is not in `marks` stays as written, so the
 * validator rejects it. A ref that starts with `#` is kept. Text outside definitions and fenced code is kept.
 *
 * @param text the Markdown text of a document, with `\n` or `\r\n` line ends
 * @param marks the mark number -> exchange id map of the prompt
 */
export declare function rewriteMarks(text: string, marks: ReadonlyMap<number, string>): string;
/**
 * Rewrite the slug part of each link in paragraph text to the slug of the document that holds the unit now.
 *
 * A link is `[text](<slug>.md#^<id>)`. The function changes it only when `slugOfUnit` has `<id>`. Fenced
 * code, headings and footnote definitions are not paragraph text, so they are kept as written.
 *
 * @param text the Markdown text of a document, with `\n` or `\r\n` line ends
 * @param slugOfUnit the unit identifier -> slug map of the project after the edit
 */
export declare function rewriteLinkSlugs(text: string, slugOfUnit: ReadonlyMap<string, string>): string;
/** The open fence of a line-by-line walk: its character and length, or null outside a fence. */
export type FenceState = {
    char: string;
    length: number;
} | null;
/**
 * Advance a fence walk by one line, with the same rule as the document parser.
 *
 * Outside a fence, a line with at most 3 leading spaces and 3 or more backticks or tildes opens one.
 * Inside a fence, a line of the same character, at least as long and with nothing after it, closes it.
 *
 * @param state the state before the line
 * @param line the line, without its line end
 * @returns the state after the line
 */
export declare function fenceStep(state: FenceState, line: string): FenceState;
