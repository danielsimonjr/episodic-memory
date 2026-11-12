import { createHash } from 'node:crypto';

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
export type TopicOutlineItem =
  | { kind: 'heading'; level: number; name: string }
  | { kind: 'code'; lines: string[] }
  | { kind: 'unit'; index: number };

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

/** The form of a unit identifier: eight lowercase hex characters. */
export const UNIT_ID_PATTERN = /^[0-9a-f]{8}$/;

const HEADING_LINE = /^(#{1,6})\s+(.+?)\s*$/;
const DEFINITION_LINE = /^\[\^([^\]\s]+)\]:\s*(.*)$/;
const DEFINITION_BODY = /^Time:\s*([^;]*?)\s*;\s*Sources:\s*(.*?)\s*$/;
const ID_LINE = /^\^(\S+)\s*$/;
/** A footnote reference in paragraph text. Use it only with `matchAll`, so `lastIndex` never leaks. */
const REFERENCE = /\[\^([^\]\s]+)\]/g;
const LINK = /\[[^\]]*\]\(([^()\s#]+)\.md#\^([^()\s]*)\)/g;
const MD_TARGET = /\]\(([^()\s]*\.md(?:#[^()\s]*)?)\)/g;
const WELL_FORMED_TARGET = /^[^()\s#]+\.md#\^[^()\s]*$/;
const URL_SCHEME = /^[a-z][a-z0-9+.-]*:/i;
const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})/;

type Item =
  | { kind: 'heading'; level: number; name: string }
  | { kind: 'code'; lines: string[] }
  | { kind: 'definition'; line: number; label: string; body: string }
  | { kind: 'paragraph'; lines: string[] };

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
export function parseTopicDoc(slug: string, text: string): TopicDoc {
  const items = scanItems(text);
  const stack: { level: number; name: string }[] = [];
  const pending: Array<Omit<TopicUnit, 'footnotes'>> = [];
  const outline: TopicOutlineItem[] = [];
  const definitions: TopicFootnote[] = [];
  const errors: string[] = [];
  let title = '';
  let h1Count = 0;
  let titleFirst = false;

  items.forEach((item, index) => {
    if (index === 0) titleFirst = item.kind === 'heading' && item.level === 1;
    if (item.kind === 'heading') {
      if (item.level === 1) {
        h1Count++;
        if (h1Count === 1) title = item.name;
      }
      while (stack.length > 0 && stack[stack.length - 1].level >= item.level) stack.pop();
      stack.push({ level: item.level, name: item.name });
      outline.push({ kind: 'heading', level: item.level, name: item.name });
    } else if (item.kind === 'code') {
      outline.push({ kind: 'code', lines: item.lines });
    } else if (item.kind === 'definition') {
      const body = DEFINITION_BODY.exec(item.body);
      if (!body) {
        errors.push(`${slug}: line ${item.line}: footnote [^${item.label}] does not match "Time: <time>; Sources: <refs>"`);
      }
      if (definitions.some(d => d.label === item.label)) {
        errors.push(`${slug}: line ${item.line}: footnote [^${item.label}] is defined more than once`);
      }
      definitions.push({
        label: item.label,
        time: body ? body[1] : '',
        refs: body ? splitRefs(body[2]) : [],
      });
    } else {
      outline.push({ kind: 'unit', index: pending.length });
      pending.push(paragraphUnit(item.lines, stack.map(f => f.name)));
    }
  });

  const units: TopicUnit[] = pending.map(unit => ({
    ...unit,
    footnotes: unit.footnoteLabels.flatMap(label => {
      const def = definitions.find(d => d.label === label);
      return def ? [{ label: def.label, time: def.time, refs: [...def.refs] }] : [];
    }),
  }));
  return { title, h1Count, titleFirst, outline, units, definitions, errors };
}

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
export function serializeTopicDoc(doc: TopicDoc): string {
  const blocks: string[][] = [];
  for (const item of doc.outline) {
    if (item.kind === 'heading') {
      blocks.push([`${'#'.repeat(item.level)} ${item.name}`]);
    } else if (item.kind === 'code') {
      blocks.push(item.lines);
    } else {
      const unit = doc.units[item.index];
      const para = [unit.text];
      if (unit.unitId !== null) para.push(`^${unit.unitId}`);
      blocks.push(para);
    }
  }
  if (doc.definitions.length > 0) {
    blocks.push(doc.definitions.map(d => `[^${d.label}]: Time: ${d.time}; Sources: ${d.refs.join(', ')}`));
  }
  return blocks.map(b => b.join('\n')).join('\n\n') + '\n';
}

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
export function assignUnitIds(
  project: string,
  slug: string,
  doc: TopicDoc,
  takenIds: ReadonlySet<string>
): TopicDoc {
  const taken = new Set(takenIds);
  for (const unit of doc.units) if (unit.unitId !== null) taken.add(unit.unitId);
  const units = doc.units.map(unit => {
    if (unit.unitId !== null) return unit;
    let counter = 0;
    let id = hashUnitId(project, slug, unit.text, counter);
    while (taken.has(id)) {
      counter++;
      id = hashUnitId(project, slug, unit.text, counter);
    }
    taken.add(id);
    return { ...unit, unitId: id };
  });
  return { ...doc, units };
}

/**
 * Split the text into headings, code blocks, definitions and paragraphs, in order.
 *
 * A fence opens on a line with at most 3 leading spaces and 3 or more backticks or tildes. It closes
 * on a line of the same character that is at least as long. An unterminated fence runs to the end.
 */
function scanItems(text: string): Item[] {
  const items: Item[] = [];
  let open: string[] = [];
  const flush = (): void => {
    if (open.length > 0) {
      items.push({ kind: 'paragraph', lines: open });
      open = [];
    }
  };
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const fence = FENCE_OPEN.exec(raw);
    if (fence) {
      flush();
      const char = fence[1][0];
      const length = fence[1].length;
      const code = [raw];
      while (i + 1 < lines.length) {
        i++;
        code.push(lines[i]);
        const close = /^ {0,3}(`{3,}|~{3,})\s*$/.exec(lines[i]);
        if (close && close[1][0] === char && close[1].length >= length) break;
      }
      // An unterminated fence runs to the end; drop the empty string that the final newline leaves.
      if (i === lines.length - 1 && code.length > 1 && code[code.length - 1] === '') code.pop();
      items.push({ kind: 'code', lines: code });
      continue;
    }
    if (raw.trim() === '') {
      flush();
      continue;
    }
    const heading = HEADING_LINE.exec(raw);
    if (heading) {
      flush();
      items.push({ kind: 'heading', level: heading[1].length, name: heading[2] });
      continue;
    }
    const definition = DEFINITION_LINE.exec(raw);
    if (definition) {
      flush();
      items.push({ kind: 'definition', line: i + 1, label: definition[1], body: definition[2] });
      continue;
    }
    open.push(raw);
  }
  flush();
  return items;
}

/** Build the unit of one paragraph, without its footnote definitions. */
function paragraphUnit(lines: string[], path: string[]): Omit<TopicUnit, 'footnotes'> {
  let unitId: string | null = null;
  let textLines = lines;
  if (lines.length > 1) {
    const id = ID_LINE.exec(lines[lines.length - 1]);
    if (id) {
      unitId = id[1];
      textLines = lines.slice(0, -1);
    }
  }
  const text = textLines.join('\n');
  const footnoteRefs = [...text.matchAll(REFERENCE)].map(m => m[1]);
  return {
    unitId,
    heading: path.join(' > '),
    path,
    text,
    footnoteRefs,
    footnoteLabels: [...new Set(footnoteRefs)],
    links: [...text.matchAll(LINK)].map(m => ({ slug: m[1], unitId: m[2] })),
    malformedLinks: [...text.matchAll(MD_TARGET)]
      .map(m => m[1])
      .filter(target => !WELL_FORMED_TARGET.test(target) && !URL_SCHEME.test(target)),
  };
}

/**
 * Tell whether a time is a real `YYYY`, `YYYY-MM` or `YYYY-MM-DD`.
 *
 * The day check uses the Gregorian leap rule for every year, the years 0000 to 0099 included.
 *
 * @param time the time text
 */
export function isValidTime(time: string): boolean {
  const m = /^(\d{4})(?:-(\d{2})(?:-(\d{2}))?)?$/.exec(time);
  if (!m) return false;
  if (m[2] === undefined) return true;
  const month = Number(m[2]);
  if (month < 1 || month > 12) return false;
  if (m[3] === undefined) return true;
  const year = Number(m[1]);
  const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  const lastDay = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
  const day = Number(m[3]);
  return day >= 1 && day <= lastDay;
}

/**
 * Give each footnote label of a paragraph the statement that it supports.
 *
 * The statement is the text from the end of the previous reference (or the start of the paragraph)
 * to the first reference of the label. The function returns the whole paragraph when that text is empty.
 *
 * @param text the paragraph text
 */
export function footnoteStatements(text: string): Map<string, string> {
  const out = new Map<string, string>();
  let start = 0;
  for (const m of text.matchAll(REFERENCE)) {
    const index = m.index ?? 0;
    if (!out.has(m[1])) out.set(m[1], text.slice(start, index).trim() || text.trim());
    start = index + m[0].length;
  }
  return out;
}

/** Split the raw Sources text into trimmed, non-empty refs. */
function splitRefs(sources: string): string[] {
  return sources
    .split(',')
    .map(part => part.trim())
    .filter(part => part.length > 0);
}

/** Hash the project, slug and text, with a counter after the first attempt. */
function hashUnitId(project: string, slug: string, text: string, counter: number): string {
  const parts = counter === 0 ? [project, slug, text] : [project, slug, text, String(counter)];
  return createHash('sha1').update(parts.join('\u0000')).digest('hex').slice(0, 8);
}
