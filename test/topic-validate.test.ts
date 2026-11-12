import { describe, it, expect } from 'vitest';
import { validateTopicEdit, type TopicEditInput } from '../src/topic-validate.js';

/** One paragraph, one definition, one exchange id. */
const WORK = '# Work history\n\n## Employment\n\nJoined A in May.[^1]\n^4a8b10cd\n\n[^1]: Time: 2026-05; Sources: #ex-111\n';

/** One paragraph with an identifier. */
const PROJECT = '# Project\n\n## Orion\n\nOrion is the work on B.[^1]\n^7c91e2ab\n\n[^1]: Time: 2026-08-14; Sources: #ex-222\n';

/** WORK with a link to the paragraph of PROJECT. */
const WORK_LINKED =
  '# Work history\n\n## Employment\n\nJoined A in May.[^1]\n^4a8b10cd\n\n' +
  'Moved to B to work on [Orion](project.md#^7c91e2ab).[^2]\n^5e6f7a8b\n\n' +
  '[^1]: Time: 2026-05; Sources: #ex-111\n[^2]: Time: 2026-08; Sources: #ex-222\n';

/** A new document with its own paragraph and a new identifier. */
const TRIP = '# Trip\n\n## Japan\n\nWent to J.[^1]\n^11223344\n\n[^1]: Time: 2025-04-02; Sources: #ex-333\n';

/** Build the default input: the work and project documents, both shown, work is edited with its own text. */
function input(over: Partial<TopicEditInput> = {}): TopicEditInput {
  return {
    before: new Map([
      ['work', WORK],
      ['project', PROJECT],
    ]),
    blocks: [{ kind: 'file', slug: 'work', text: WORK }],
    shown: new Set(['work', 'project']),
    validMarks: new Set([1, 2, 3]),
    exchangeExists: id => id === 'ex-111' || id === 'ex-222' || id === 'ex-333',
    limits: { maxDocChars: 8000, maxDocs: 50 },
    ...over,
  };
}

/** The errors whose line starts with a given check number. */
function check(errors: string[], n: number): string[] {
  return errors.filter(e => e.startsWith(`check ${n}:`));
}

describe('validateTopicEdit: a passing edit', () => {
  it('accepts an unchanged document', () => {
    expect(validateTopicEdit(input())).toEqual([]);
  });

  it('accepts a new document', () => {
    const out = validateTopicEdit(input({ blocks: [{ kind: 'file', slug: 'trip', text: TRIP }], shown: new Set() }));
    expect(out).toEqual([]);
  });

  it('accepts a link to a paragraph that resolves', () => {
    const out = validateTopicEdit(
      input({
        before: new Map([
          ['work', WORK_LINKED],
          ['project', PROJECT],
        ]),
        blocks: [{ kind: 'file', slug: 'work', text: WORK_LINKED }],
      })
    );
    expect(out).toEqual([]);
  });

  it('accepts a merge that moves both paragraphs and keeps every citation', () => {
    const merged =
      '# Work history\n\n## Employment\n\nJoined A in May.[^1]\n^4a8b10cd\n\n' +
      'Orion is the work on B.[^2]\n^7c91e2ab\n\n' +
      '[^1]: Time: 2026-05; Sources: #ex-111\n[^2]: Time: 2026-08-14; Sources: #ex-222\n';
    const out = validateTopicEdit(
      input({
        blocks: [
          { kind: 'file', slug: 'work', text: merged },
          { kind: 'delete', slug: 'project' },
        ],
      })
    );
    expect(out).toEqual([]);
  });
});

describe('check 1: slug pattern and one block per slug', () => {
  it('names a slug that does not match the pattern', () => {
    const out = validateTopicEdit(input({ blocks: [{ kind: 'file', slug: 'Bad_Slug', text: TRIP }], shown: new Set() }));
    expect(out).toHaveLength(1);
    expect(out[0]).toMatch(/^check 1: Bad_Slug:/);
  });

  it('names a slug that appears in two blocks', () => {
    const out = validateTopicEdit(
      input({
        blocks: [
          { kind: 'file', slug: 'work', text: WORK },
          { kind: 'file', slug: 'work', text: WORK },
        ],
      })
    );
    expect(check(out, 1)).toEqual(['check 1: work: slug appears in 2 blocks']);
  });
});

describe('check 2: a DELETE names an existing document', () => {
  it('fails for a missing document', () => {
    const out = validateTopicEdit(input({ blocks: [{ kind: 'delete', slug: 'missing' }], shown: new Set() }));
    expect(check(out, 2)).toHaveLength(1);
    expect(check(out, 2)[0]).toContain('missing');
  });

  it('passes for an existing shown document', () => {
    const out = validateTopicEdit(input({ blocks: [{ kind: 'delete', slug: 'project' }] }));
    expect(check(out, 2)).toEqual([]);
  });
});

describe('check 3: the model edits only the documents it read', () => {
  it('fails when a FILE replaces a document that was not shown', () => {
    const out = validateTopicEdit(input({ shown: new Set() }));
    expect(check(out, 3)).toHaveLength(1);
    expect(check(out, 3)[0]).toContain('work');
  });

  it('fails when a DELETE removes a document that was not shown', () => {
    const out = validateTopicEdit(input({ blocks: [{ kind: 'delete', slug: 'project' }], shown: new Set(['work']) }));
    expect(check(out, 3)).toHaveLength(1);
    expect(check(out, 3)[0]).toContain('project');
  });

  it('passes for a new document that was never shown', () => {
    const out = validateTopicEdit(input({ blocks: [{ kind: 'file', slug: 'trip', text: TRIP }], shown: new Set() }));
    expect(check(out, 3)).toEqual([]);
  });
});

describe('check 4: one level-one heading on the first non-blank line', () => {
  it('fails with two level-one headings', () => {
    const text = '# A\n\n# B\n\n## S\n\nP.[^1]\n^aaaaaaaa\n\n[^1]: Time: 2026; Sources: #ex-111\n';
    const out = validateTopicEdit(input({ blocks: [{ kind: 'file', slug: 'work', text }] }));
    expect(check(out, 4)).toEqual(['check 4: work: found 2 level-1 headings, want 1']);
  });

  it('fails with no level-one heading', () => {
    const text = '## S\n\nP.[^1]\n^aaaaaaaa\n\n[^1]: Time: 2026; Sources: #ex-111\n';
    const out = validateTopicEdit(input({ blocks: [{ kind: 'file', slug: 'work', text }] }));
    expect(check(out, 4)).toEqual(['check 4: work: found 0 level-1 headings, want 1']);
  });

  it('fails when the level-one heading is not the first line', () => {
    const text = 'Intro.[^1]\n^aaaaaaaa\n\n# T\n\n## S\n\nP.[^1]\n^bbbbbbbb\n\n[^1]: Time: 2026; Sources: #ex-111\n';
    const out = validateTopicEdit(input({ blocks: [{ kind: 'file', slug: 'work', text }] }));
    expect(check(out, 4)).toEqual(['check 4: work: the level-1 heading is not the first line']);
  });
});

describe('check 5: footnote references and definitions pair up', () => {
  it('fails for a paragraph with no footnote reference', () => {
    const text = '# T\n\n## S\n\nNo citation here.\n^aaaaaaaa\n';
    const out = validateTopicEdit(input({ blocks: [{ kind: 'file', slug: 'work', text }] }));
    expect(check(out, 5)).toHaveLength(1);
    expect(check(out, 5)[0]).toContain('no footnote reference');
  });

  it('fails for a reference with no definition', () => {
    const text = '# T\n\n## S\n\nCited.[^9]\n^aaaaaaaa\n';
    const out = validateTopicEdit(input({ blocks: [{ kind: 'file', slug: 'work', text }] }));
    expect(check(out, 5)).toEqual(['check 5: work: footnote [^9] has no definition']);
  });

  it('fails for a definition that no paragraph references', () => {
    const text = WORK + '[^7]: Time: 2026-05; Sources: #ex-111\n';
    const out = validateTopicEdit(input({ blocks: [{ kind: 'file', slug: 'work', text }] }));
    expect(check(out, 5)).toEqual(['check 5: work: footnote [^7] is not referenced']);
  });

  it('fails for a malformed definition', () => {
    const text = '# T\n\n## S\n\nCited.[^1]\n^aaaaaaaa\n\n[^1]: Sources: #ex-111\n';
    const out = validateTopicEdit(input({ blocks: [{ kind: 'file', slug: 'work', text }] }));
    expect(check(out, 5).some(e => e.includes('does not match'))).toBe(true);
  });
});

describe('check 6: footnote time is a real YYYY, YYYY-MM or YYYY-MM-DD', () => {
  it.each(['2026', '2026-05', '2026-05-31', '2024-02-29'])('accepts %s', time => {
    const text = WORK.replace('Time: 2026-05;', `Time: ${time};`);
    const out = validateTopicEdit(input({ blocks: [{ kind: 'file', slug: 'work', text }] }));
    expect(check(out, 6)).toEqual([]);
  });

  it.each(['26-05', '2026-5', '2026-13', '2026-00', '2026-02-30', '2025-02-29', '2026-04-31', 'May 2026'])(
    'rejects %s',
    time => {
      const text = WORK.replace('Time: 2026-05;', `Time: ${time};`);
      const out = validateTopicEdit(input({ blocks: [{ kind: 'file', slug: 'work', text }] }));
      expect(check(out, 6)).toHaveLength(1);
      expect(check(out, 6)[0]).toContain(time);
    }
  );
});

describe('check 7: every source ref resolves', () => {
  it('accepts a mark number of the prompt', () => {
    const text = WORK.replace('#ex-111', '3');
    const out = validateTopicEdit(input({ blocks: [{ kind: 'file', slug: 'work', text }] }));
    expect(check(out, 7)).toEqual([]);
  });

  it('fails for a mark number that the prompt did not give', () => {
    const text = WORK.replace('#ex-111', '9');
    const out = validateTopicEdit(input({ blocks: [{ kind: 'file', slug: 'work', text }] }));
    expect(check(out, 7)).toEqual(['check 7: work: footnote [^1] cites unknown mark 9']);
  });

  it('fails for an exchange id that the project does not hold', () => {
    const text = WORK.replace('#ex-111', '#ex-999');
    const out = validateTopicEdit(input({ blocks: [{ kind: 'file', slug: 'work', text }] }));
    expect(check(out, 7)).toEqual(['check 7: work: footnote [^1] cites unknown exchange id ex-999']);
  });

  it('fails for a ref that is neither a mark nor a # id', () => {
    const text = WORK.replace('#ex-111', 'ex-111');
    const out = validateTopicEdit(input({ blocks: [{ kind: 'file', slug: 'work', text }] }));
    expect(check(out, 7)).toHaveLength(1);
    expect(check(out, 7)[0]).toContain('malformed');
  });

  it('fails for a definition with no source', () => {
    const text = WORK.replace('Sources: #ex-111', 'Sources:');
    const out = validateTopicEdit(input({ blocks: [{ kind: 'file', slug: 'work', text }] }));
    expect(check(out, 7)).toEqual(['check 7: work: footnote [^1] has no source']);
  });
});

describe('check 8: paragraph identifiers are 8-hex and unique in the project', () => {
  it('fails for a paragraph with no identifier', () => {
    const text = '# T\n\n## S\n\nNo id.[^1]\n\n[^1]: Time: 2026; Sources: #ex-111\n';
    const out = validateTopicEdit(input({ blocks: [{ kind: 'file', slug: 'work', text }] }));
    expect(check(out, 8)).toEqual(['check 8: work: paragraph has no identifier']);
  });

  it('fails for an identifier that is not 8 lowercase hex characters', () => {
    const text = WORK.replace('^4a8b10cd', '^4A8B10CD');
    const out = validateTopicEdit(input({ blocks: [{ kind: 'file', slug: 'work', text }] }));
    expect(check(out, 8)).toEqual(['check 8: work: identifier "4A8B10CD" is not 8 lowercase hex characters']);
  });

  it('fails for an identifier that another paragraph of the project uses', () => {
    const trip = TRIP.replace('^11223344', '^7c91e2ab');
    const out = validateTopicEdit(input({ blocks: [{ kind: 'file', slug: 'trip', text: trip }], shown: new Set() }));
    expect(check(out, 8)).toEqual(['check 8: trip: identifier "7c91e2ab" is also used in project']);
  });
});

describe('check 9: every link resolves after the edit', () => {
  it('fails for a link to a paragraph that does not exist', () => {
    const text = WORK_LINKED.replace('^7c91e2ab', '^ffffffff');
    const out = validateTopicEdit(
      input({ before: new Map([['work', WORK_LINKED], ['project', PROJECT]]), blocks: [{ kind: 'file', slug: 'work', text }] })
    );
    expect(check(out, 9)).toEqual(['check 9: work: link to project.md#^ffffffff does not resolve']);
  });

  it('fails for a link to a document that does not exist', () => {
    const text = WORK_LINKED.replace('project.md', 'gone.md');
    const out = validateTopicEdit(
      input({ before: new Map([['work', WORK_LINKED], ['project', PROJECT]]), blocks: [{ kind: 'file', slug: 'work', text }] })
    );
    expect(check(out, 9)).toEqual(['check 9: work: link to gone.md#^7c91e2ab does not resolve']);
  });

  it('fails when a deleted document still has an inbound link from an untouched document', () => {
    const out = validateTopicEdit(
      input({
        before: new Map([['work', WORK_LINKED], ['project', PROJECT]]),
        blocks: [{ kind: 'delete', slug: 'project' }],
        shown: new Set(['project']),
      })
    );
    expect(check(out, 9)).toEqual(['check 9: work: link to project.md#^7c91e2ab does not resolve']);
  });
});

describe('check 10: size limits', () => {
  it('fails for a document longer than the character limit', () => {
    const out = validateTopicEdit(input({ limits: { maxDocChars: 50, maxDocs: 50 } }));
    expect(check(out, 10)).toEqual([`check 10: work: document has ${WORK.length} characters, the limit is 50`]);
  });

  it('fails when the project holds more documents than the limit', () => {
    const out = validateTopicEdit(
      input({ blocks: [{ kind: 'file', slug: 'trip', text: TRIP }], shown: new Set(), limits: { maxDocChars: 8000, maxDocs: 2 } })
    );
    expect(check(out, 10)).toEqual(['check 10: (project): 3 documents, the limit is 2']);
  });
});

describe('check 11: every cited exchange id stays cited', () => {
  it('fails when a rewrite drops a citation', () => {
    const merged = WORK.replace('#ex-111', '#ex-333');
    const out = validateTopicEdit(
      input({ blocks: [{ kind: 'file', slug: 'work', text: merged }], shown: new Set(['work']) })
    );
    expect(check(out, 11)).toEqual(['check 11: work: exchange id ex-111 is no longer cited']);
  });
});

describe('validateTopicEdit: a mixed edit', () => {
  it('lists one line for each failed check, in check order', () => {
    const work = WORK.replace('#ex-111', '9');
    const out = validateTopicEdit(
      input({
        blocks: [
          { kind: 'file', slug: 'work', text: work },
          { kind: 'file', slug: 'trip', text: TRIP.replace('^11223344', '') },
          { kind: 'delete', slug: 'missing' },
        ],
        shown: new Set(['work']),
      })
    );
    expect(out).toEqual([
      'check 2: missing: DELETE names no existing document',
      'check 7: work: footnote [^1] cites unknown mark 9',
      'check 8: trip: paragraph has no identifier',
      'check 11: work: exchange id ex-111 is no longer cited',
    ]);
  });
});
