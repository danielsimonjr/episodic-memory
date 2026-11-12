import { isValidTime, parseTopicDoc, UNIT_ID_PATTERN, type TopicDoc } from './topic-format.js';

/** The form of a document slug. */
export const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** One staged block of a model answer: a new text for a document, or the removal of a document. */
export type TopicBlock = { kind: 'file'; slug: string; text: string } | { kind: 'delete'; slug: string };

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
  limits: { maxDocChars: number; maxDocs: number };
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
export function validateTopicEdit(input: TopicEditInput): string[] {
  const errors: string[] = [];
  const fail = (n: number, message: string): void => {
    errors.push(`check ${n}: ${message}`);
  };

  // Check 1 names a bad slug or a slug in two blocks. The other checks skip a bad slug.
  const valid: TopicBlock[] = [];
  const blockCount = new Map<string, number>();
  for (const block of input.blocks) {
    if (!SLUG_PATTERN.test(block.slug)) {
      fail(1, `${block.slug}: slug does not match the slug pattern`);
      continue;
    }
    valid.push(block);
    blockCount.set(block.slug, (blockCount.get(block.slug) ?? 0) + 1);
  }
  for (const [slug, count] of blockCount) {
    if (count > 1) fail(1, `${slug}: slug appears in ${count} blocks`);
  }

  // Checks 2 and 3 cover the DELETE targets and the documents that the prompt did not show.
  for (const block of valid) {
    if (block.kind === 'delete' && !input.before.has(block.slug)) {
      fail(2, `${block.slug}: DELETE names no existing document`);
    }
    if (input.before.has(block.slug) && !input.shown.has(block.slug)) {
      fail(3, `${block.slug}: the prompt did not show this document in full`);
    }
  }

  // The state after the edit: the untouched documents plus the written ones, less the deleted ones.
  const after = new Map<string, string>(input.before);
  const written = new Map<string, string>();
  for (const block of valid) {
    if (block.kind === 'file') {
      after.set(block.slug, block.text);
      written.set(block.slug, block.text);
    } else {
      after.delete(block.slug);
    }
  }
  const docs = new Map<string, TopicDoc>();
  for (const [slug, text] of after) docs.set(slug, parseTopicDoc(slug, text));

  for (const [slug, text] of written) {
    const doc = docs.get(slug)!;
    checkStructure(slug, doc, input, fail);
    if (text.length > input.limits.maxDocChars) {
      fail(10, `${slug}: document has ${text.length} characters, the limit is ${input.limits.maxDocChars}`);
    }
  }

  // Check 8: identifiers are 8-hex and unique in the project.
  const owners = new Map<string, string>();
  for (const [slug, doc] of docs) {
    for (const unit of doc.units) {
      if (unit.unitId === null) {
        fail(8, `${slug}: paragraph has no identifier`);
        continue;
      }
      if (!UNIT_ID_PATTERN.test(unit.unitId)) {
        fail(8, `${slug}: identifier "${unit.unitId}" is not 8 lowercase hex characters`);
        continue;
      }
      const first = owners.get(unit.unitId);
      if (first !== undefined) {
        fail(8, `${slug}: identifier "${unit.unitId}" is also used in ${first}`);
      } else {
        owners.set(unit.unitId, slug);
      }
    }
  }

  // Check 9: every link names a paragraph of the project by its identifier, and every .md link has
  // the link form. The slug part of a link can be stale after a regroup; prepare rewrites it.
  for (const [slug, doc] of docs) {
    for (const unit of doc.units) {
      for (const link of unit.links) {
        if (!owners.has(link.unitId)) fail(9, `${slug}: link to ${link.slug}.md#^${link.unitId} does not resolve`);
      }
      for (const target of unit.malformedLinks) {
        fail(9, `${slug}: link target "${target}" is not <slug>.md#^<unit id>`);
      }
    }
  }

  if (docs.size > input.limits.maxDocs) {
    fail(10, `(project): ${docs.size} documents, the limit is ${input.limits.maxDocs}`);
  }

  // Check 11: every exchange id cited before the edit is still cited after it.
  const citedAfter = new Set<string>();
  for (const doc of docs.values()) {
    for (const def of doc.definitions) {
      for (const ref of def.refs) if (ref.startsWith('#')) citedAfter.add(ref.slice(1));
    }
  }
  const citedBefore = new Map<string, string>();
  for (const [slug, text] of input.before) {
    for (const def of parseTopicDoc(slug, text).definitions) {
      for (const ref of def.refs) {
        if (ref.startsWith('#') && !citedBefore.has(ref.slice(1))) citedBefore.set(ref.slice(1), slug);
      }
    }
  }
  for (const [id, slug] of citedBefore) {
    if (!citedAfter.has(id)) fail(11, `${slug}: exchange id ${id} is no longer cited`);
  }

  return errors;
}

/** Run checks 4 to 7 on one written document. */
function checkStructure(
  slug: string,
  doc: TopicDoc,
  input: TopicEditInput,
  fail: (n: number, message: string) => void
): void {
  // Check 4: one level-one heading, on the first non-blank line.
  if (doc.h1Count !== 1) {
    fail(4, `${slug}: found ${doc.h1Count} level-1 headings, want 1`);
  } else if (!doc.titleFirst) {
    fail(4, `${slug}: the level-1 heading is not the first line`);
  }

  // Check 5: each paragraph cites a footnote, each label is referenced exactly once in the document,
  // each reference has a definition, and each definition is cited.
  for (const err of doc.errors) fail(5, err);
  const referenced = new Map<string, number>();
  for (const unit of doc.units) {
    if (unit.footnoteRefs.length === 0) {
      fail(5, `${slug}: paragraph "${snippet(unit.text)}" has no footnote reference`);
    }
    for (const label of unit.footnoteRefs) referenced.set(label, (referenced.get(label) ?? 0) + 1);
  }
  for (const [label, count] of referenced) {
    if (!doc.definitions.some(d => d.label === label)) fail(5, `${slug}: footnote [^${label}] has no definition`);
    if (count > 1) fail(5, `${slug}: footnote [^${label}] is referenced ${count} times, want 1`);
  }
  for (const def of doc.definitions) {
    if (!referenced.has(def.label)) fail(5, `${slug}: footnote [^${def.label}] is not referenced`);
  }

  // Check 6: each time is a real YYYY, YYYY-MM or YYYY-MM-DD.
  for (const def of doc.definitions) {
    if (!isValidTime(def.time)) {
      fail(6, `${slug}: footnote [^${def.label}] time "${def.time}" is not YYYY, YYYY-MM or YYYY-MM-DD`);
    }
  }

  // Check 7: each source is a # id that the project holds. Prepare has rewritten every valid mark,
  // so a bare number left here is a mark that the prompt did not give.
  for (const def of doc.definitions) {
    if (def.refs.length === 0) {
      fail(7, `${slug}: footnote [^${def.label}] has no source`);
      continue;
    }
    for (const ref of def.refs) {
      if (/^\d+$/.test(ref)) {
        fail(7, `${slug}: footnote [^${def.label}] cites mark ${ref}, which the prompt did not give`);
      } else if (/^#\S+$/.test(ref)) {
        const id = ref.slice(1);
        if (!input.exchangeExists(id)) fail(7, `${slug}: footnote [^${def.label}] cites unknown exchange id ${id}`);
      } else {
        fail(7, `${slug}: footnote [^${def.label}] has a malformed source "${ref}"`);
      }
    }
  }
}

/** Shorten the first line of a paragraph for an error message. */
function snippet(text: string): string {
  const first = text.split('\n')[0];
  return first.length > 40 ? `${first.slice(0, 40)}...` : first;
}
