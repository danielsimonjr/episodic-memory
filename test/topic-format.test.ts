import { describe, it, expect } from 'vitest';
import {
  parseTopicDoc,
  serializeTopicDoc,
  assignUnitIds,
  UNIT_ID_PATTERN,
  isValidTime,
  footnoteStatements,
  rewriteMarks,
  rewriteLinkSlugs,
} from '../src/topic-format.js';

/** A canonical document: title, one section, one paragraph with two footnotes, then the definitions. */
const CANONICAL = [
  '# Work history',
  '',
  '## Employment',
  '',
  'Joined A in May.[^1] Moved to B in August to work on [Orion](project.md#^7c91e2ab).[^2]',
  '^4a8b10cd',
  '',
  '[^1]: Time: 2026-05; Sources: #ex-111',
  '[^2]: Time: 2026-08; Sources: #ex-222',
  '',
].join('\n');

const TWO_SECTIONS = [
  '# T',
  '',
  '## A',
  '',
  '### B',
  '',
  'P1 text.[^1]',
  '^11111111',
  '',
  '## C',
  '',
  'P2 text.[^2]',
  '^22222222',
  '',
  '[^1]: Time: 2026; Sources: #e1',
  '[^2]: Time: 2026-03; Sources: #e2, #e3',
  '',
].join('\n');

describe('parseTopicDoc', () => {
  it('reads the title and counts the level-one headings', () => {
    const doc = parseTopicDoc('work', CANONICAL);
    expect(doc.title).toBe('Work history');
    expect(doc.h1Count).toBe(1);
    expect(doc.titleFirst).toBe(true);
  });

  it('counts two level-one headings and flags a title that is not on the first line', () => {
    const two = parseTopicDoc('work', '# A\n\n# B\n');
    expect(two.h1Count).toBe(2);
    const late = parseTopicDoc('work', 'Intro.[^1]\n^aaaaaaaa\n\n# T\n');
    expect(late.titleFirst).toBe(false);
  });

  it('splits paragraphs at blank lines and keeps the identifier line out of the text', () => {
    const doc = parseTopicDoc(
      'work',
      '# T\n\n## S\n\nFirst.[^1]\n^aaaaaaaa\n\nSecond.[^1]\n^bbbbbbbb\n\n[^1]: Time: 2026; Sources: #e1\n'
    );
    expect(doc.units.map(u => u.text)).toEqual(['First.[^1]', 'Second.[^1]']);
    expect(doc.units.map(u => u.unitId)).toEqual(['aaaaaaaa', 'bbbbbbbb']);
  });

  it('builds the heading path from every heading above the paragraph', () => {
    const doc = parseTopicDoc('work', TWO_SECTIONS);
    expect(doc.units[0].path).toEqual(['T', 'A', 'B']);
    expect(doc.units[0].heading).toBe('T > A > B');
    expect(doc.units[1].path).toEqual(['T', 'C']);
    expect(doc.units[1].heading).toBe('T > C');
  });

  it('resolves footnotes and links for each paragraph', () => {
    const doc = parseTopicDoc('work', CANONICAL);
    const [unit] = doc.units;
    expect(unit.footnoteLabels).toEqual(['1', '2']);
    expect(unit.footnotes).toEqual([
      { label: '1', time: '2026-05', refs: ['#ex-111'] },
      { label: '2', time: '2026-08', refs: ['#ex-222'] },
    ]);
    expect(unit.links).toEqual([{ slug: 'project', unitId: '7c91e2ab' }]);
  });

  it('keeps every definition in document order', () => {
    const doc = parseTopicDoc('work', TWO_SECTIONS);
    expect(doc.definitions.map(d => d.label)).toEqual(['1', '2']);
    expect(doc.definitions[1].refs).toEqual(['#e2', '#e3']);
  });

  it('gives a paragraph with no identifier line a null unit id', () => {
    const doc = parseTopicDoc('work', '# T\n\n## S\n\nNo id here.[^1]\n\n[^1]: Time: 2026; Sources: #e1\n');
    expect(doc.units[0].unitId).toBeNull();
  });

  it('keeps an identifier that is not 8-hex as written, so the validator can reject it', () => {
    const doc = parseTopicDoc('work', '# T\n\n## S\n\nBad id.[^1]\n^4A8B10CD\n\n[^1]: Time: 2026; Sources: #e1\n');
    expect(doc.units[0].unitId).toBe('4A8B10CD');
  });

  it('reports a malformed definition and keeps it with an empty time and no refs', () => {
    const doc = parseTopicDoc('work', '# T\n\n## S\n\nText.[^1]\n^aaaaaaaa\n\n[^1]: Sources: #e1\n');
    expect(doc.errors).toHaveLength(1);
    expect(doc.errors[0]).toContain('work');
    expect(doc.errors[0]).toContain('line');
    expect(doc.definitions[0]).toEqual({ label: '1', time: '', refs: [] });
  });
});

describe('serializeTopicDoc', () => {
  it('writes a canonical document back byte for byte', () => {
    expect(serializeTopicDoc(parseTopicDoc('work', CANONICAL))).toBe(CANONICAL);
  });

  it('writes the same text again after a second parse of loose input', () => {
    const loose = '# T\n## S\nP text.[^1]\n^aaaaaaaa\n[^1]: Time: 2026; Sources: #e1\n';
    const once = serializeTopicDoc(parseTopicDoc('work', loose));
    const twice = serializeTopicDoc(parseTopicDoc('work', once));
    expect(twice).toBe(once);
  });

  it('omits the identifier line of a paragraph that has no identifier', () => {
    const doc = parseTopicDoc('work', '# T\n\n## S\n\nNo id.[^1]\n\n[^1]: Time: 2026; Sources: #e1\n');
    expect(serializeTopicDoc(doc)).not.toMatch(/^\^/m);
  });

  it('keeps a heading that has no paragraph below it', () => {
    const doc = parseTopicDoc('work', '# T\n\n## Empty\n\n## Full\n\nP.[^1]\n^aaaaaaaa\n\n[^1]: Time: 2026; Sources: #e1\n');
    expect(serializeTopicDoc(doc)).toContain('## Empty');
    expect(serializeTopicDoc(doc)).toContain('## Full');
  });

  it('keeps the heading levels and the order of the input, so a second parse sees the same structure', () => {
    const inputs = [
      // No level-one heading: check 4 must still fail after a round trip.
      '## S\n\nP.[^1]\n^aaaaaaaa\n\n[^1]: Time: 2026; Sources: #e1\n',
      // The level-one heading is second: check 4 must still fail after a round trip.
      '## Intro\n\n# T\n\n## S\n\nP.[^1]\n^aaaaaaaa\n\n[^1]: Time: 2026; Sources: #e1\n',
      // Two level-one headings: check 4 must still fail after a round trip.
      '# A\n\n# A\n\nP.[^1]\n^aaaaaaaa\n\n[^1]: Time: 2026; Sources: #e1\n',
    ];
    for (const text of inputs) {
      const first = parseTopicDoc('work', text);
      const second = parseTopicDoc('work', serializeTopicDoc(first));
      expect(second.h1Count).toBe(first.h1Count);
      expect(second.titleFirst).toBe(first.titleFirst);
      expect(second.units.map(u => u.heading)).toEqual(first.units.map(u => u.heading));
      expect(serializeTopicDoc(second)).toBe(serializeTopicDoc(first));
    }
    expect(parseTopicDoc('work', inputs[0]).h1Count).toBe(0);
    expect(parseTopicDoc('work', inputs[1]).titleFirst).toBe(false);
    expect(parseTopicDoc('work', inputs[2]).h1Count).toBe(2);
  });
});

describe('assignUnitIds', () => {
  const NEW_PARA = '# T\n\n## S\n\nA new paragraph.[^1]\n\n[^1]: Time: 2026; Sources: #e1\n';

  it('gives a new paragraph an 8-hex lowercase identifier', () => {
    const out = assignUnitIds('proj', 'work', parseTopicDoc('work', NEW_PARA), new Set());
    expect(out.units[0].unitId).toMatch(UNIT_ID_PATTERN);
  });

  it('is deterministic for the same project, slug and text', () => {
    const a = assignUnitIds('proj', 'work', parseTopicDoc('work', NEW_PARA), new Set());
    const b = assignUnitIds('proj', 'work', parseTopicDoc('work', NEW_PARA), new Set());
    expect(a.units[0].unitId).toBe(b.units[0].unitId);
  });

  it('gives a different identifier in another project', () => {
    const a = assignUnitIds('proj', 'work', parseTopicDoc('work', NEW_PARA), new Set());
    const b = assignUnitIds('other', 'work', parseTopicDoc('work', NEW_PARA), new Set());
    expect(a.units[0].unitId).not.toBe(b.units[0].unitId);
  });

  it('keeps an identifier that the model gave', () => {
    const doc = parseTopicDoc('work', CANONICAL);
    const out = assignUnitIds('proj', 'work', doc, new Set());
    expect(out.units[0].unitId).toBe('4a8b10cd');
  });

  it('does not change the input document', () => {
    const doc = parseTopicDoc('work', NEW_PARA);
    assignUnitIds('proj', 'work', doc, new Set());
    expect(doc.units[0].unitId).toBeNull();
  });

  it('gives two identical new paragraphs in one document two different identifiers', () => {
    const twin = '# T\n\n## S\n\nSame text.[^1]\n\nSame text.[^1]\n\n[^1]: Time: 2026; Sources: #e1\n';
    const out = assignUnitIds('proj', 'work', parseTopicDoc('work', twin), new Set());
    expect(out.units[0].unitId).not.toBe(out.units[1].unitId);
  });

  it('moves to a new identifier when the hashed one is taken, and stays 8-hex', () => {
    const first = assignUnitIds('proj', 'work', parseTopicDoc('work', NEW_PARA), new Set()).units[0].unitId!;
    const moved = assignUnitIds('proj', 'work', parseTopicDoc('work', NEW_PARA), new Set([first])).units[0].unitId!;
    expect(moved).not.toBe(first);
    expect(moved).toMatch(UNIT_ID_PATTERN);
    const again = assignUnitIds('proj', 'work', parseTopicDoc('work', NEW_PARA), new Set([first])).units[0].unitId;
    expect(again).toBe(moved);
  });
});

describe('review fixes: fences, refs, links, times, statements', () => {
  const FENCED = [
    '# T', '', '## S', '', '```sh', '# install deps', '', '[^9]: x', '```', '',
    'P.[^1]', '^aaaaaaaa', '', '[^1]: Time: 2026; Sources: #e1', '',
  ].join('\n');

  it('keeps a fenced block verbatim and out of the structure', () => {
    const doc = parseTopicDoc('t', FENCED);
    expect(doc.h1Count).toBe(1);
    expect(doc.units).toHaveLength(1);
    expect(doc.definitions.map(d => d.label)).toEqual(['1']);
    expect(doc.errors).toEqual([]);
    expect(doc.outline.filter(i => i.kind === 'code')).toHaveLength(1);
    expect(serializeTopicDoc(doc)).toBe(FENCED);
  });

  it('handles tilde fences, indented openers, longer fences and unterminated fences', () => {
    const tilde = parseTopicDoc('t', '# T\n\n~~~\n# x\n~~~\n');
    expect(tilde.h1Count).toBe(1);
    const indented = parseTopicDoc('t', '# T\n\n   ```\n# x\n   ```\n');
    expect(indented.h1Count).toBe(1);
    const long = parseTopicDoc('t', '# T\n\n````\n```\n# x\n````\n');
    expect(long.h1Count).toBe(1);
    const open = parseTopicDoc('t', '# T\n\n```\n# x\n\n[^1]: y\n');
    expect(open.h1Count).toBe(1);
    expect(open.definitions).toEqual([]);
  });

  it('keeps every footnote reference with repeats', () => {
    const doc = parseTopicDoc('t', '# T\n\nJoined A.[^1] Left B.[^1]\n^aaaaaaaa\n\n[^1]: Time: 2026; Sources: #e1\n');
    expect(doc.units[0].footnoteRefs).toEqual(['1', '1']);
    expect(doc.units[0].footnoteLabels).toEqual(['1']);
  });

  it('reads a reference followed by a colon inside a paragraph', () => {
    const doc = parseTopicDoc('t', '# T\n\nJoined A[^1]: then moved.\n^aaaaaaaa\n');
    expect(doc.units[0].footnoteRefs).toEqual(['1']);
  });

  it('lists .md link targets that are not slug.md#^id', () => {
    const doc = parseTopicDoc('t', '# T\n\nSee [x](project.md#7c91e2ab) and [y](project.md) and [z](https://e.com/a.md) and [w](p.md#^7c91e2ab).\n^aaaaaaaa\n');
    expect(doc.units[0].malformedLinks).toEqual(['project.md#7c91e2ab', 'project.md']);
    expect(doc.units[0].links).toEqual([{ slug: 'p', unitId: '7c91e2ab' }]);
  });

  it('checks times with the explicit leap rule', () => {
    expect(isValidTime('0000-02-29')).toBe(true);
    expect(isValidTime('2000-02-29')).toBe(true);
    expect(isValidTime('1900-02-29')).toBe(false);
    expect(isValidTime('2026-8')).toBe(false);
  });

  it('gives each label of a two-footnote paragraph its statement', () => {
    const text = 'Joined A in May.[^1] Moved to B in August to work on [Orion](project.md#^7c91e2ab).[^2]';
    expect([...footnoteStatements(text)]).toEqual([
      ['1', 'Joined A in May.'],
      ['2', 'Moved to B in August to work on [Orion](project.md#^7c91e2ab).'],
    ]);
  });
});

describe('rewriteMarks', () => {
  const DOC = (sources: string, extra = ''): string =>
    `# T\n\nP.[^1]\n^aaaaaaaa\n\n[^1]: Time: 2026; Sources: ${sources}\n${extra}`;

  it('rewrites a known mark number to the exchange id', () => {
    const marks = new Map([[3, 'ex-333']]);
    expect(rewriteMarks(DOC('3'), marks)).toBe(DOC('#ex-333'));
  });

  it('keeps an unknown mark number as written, so the validator can reject it', () => {
    const marks = new Map([[3, 'ex-333']]);
    expect(rewriteMarks(DOC('9'), marks)).toBe(DOC('9'));
  });

  it('keeps a ref that already starts with #', () => {
    const marks = new Map([[3, 'ex-333']]);
    expect(rewriteMarks(DOC('#ex-111'), marks)).toBe(DOC('#ex-111'));
  });

  it('rewrites only the bare number in a mixed list and keeps the separators', () => {
    const marks = new Map([[3, 'ex-333']]);
    expect(rewriteMarks(DOC('#ex-1, 3'), marks)).toBe(DOC('#ex-1, #ex-333'));
    expect(rewriteMarks(DOC('3,#ex-1'), marks)).toBe(DOC('#ex-333,#ex-1'));
  });

  it('keeps the label as written and rewrites the ref of the same number', () => {
    const marks = new Map([[3, 'ex-333']]);
    const text = '# T\n\nP.[^3]\n^aaaaaaaa\n\n[^3]: Time: 2026; Sources: 3\n';
    expect(rewriteMarks(text, marks)).toBe('# T\n\nP.[^3]\n^aaaaaaaa\n\n[^3]: Time: 2026; Sources: #ex-333\n');
  });

  it('leaves a definition inside a fenced block untouched', () => {
    const marks = new Map([[3, 'ex-333']]);
    const text = '# T\n\n```\n[^1]: Time: 2026; Sources: 3\n```\n';
    expect(rewriteMarks(text, marks)).toBe(text);
  });

  it('leaves the paragraph text untouched', () => {
    const marks = new Map([[3, 'ex-333']]);
    const text = '# T\n\nSee 3 cases and [^3] here.[^1]\n^aaaaaaaa\n\n[^1]: Time: 2026; Sources: 3\n';
    expect(rewriteMarks(text, marks)).toBe(
      '# T\n\nSee 3 cases and [^3] here.[^1]\n^aaaaaaaa\n\n[^1]: Time: 2026; Sources: #ex-333\n'
    );
  });

  it('leaves a malformed definition with no Time untouched', () => {
    const marks = new Map([[3, 'ex-333']]);
    const text = '# T\n\nP.[^1]\n^aaaaaaaa\n\n[^1]: Sources: 3\n';
    expect(rewriteMarks(text, marks)).toBe(text);
  });

  it('keeps the carriage returns of a CRLF text', () => {
    const marks = new Map([[3, 'ex-333']]);
    const text = '# T\r\n\r\nP.[^1]\r\n^aaaaaaaa\r\n\r\n[^1]: Time: 2026; Sources: 3\r\n';
    expect(rewriteMarks(text, marks)).toBe(
      '# T\r\n\r\nP.[^1]\r\n^aaaaaaaa\r\n\r\n[^1]: Time: 2026; Sources: #ex-333\r\n'
    );
  });
});

describe('rewriteLinkSlugs', () => {
  it('rewrites the slug of a link whose unit moved to another document', () => {
    const map = new Map([['7c91e2ab', 'new-doc']]);
    expect(rewriteLinkSlugs('See [X](old.md#^7c91e2ab).', map)).toBe('See [X](new-doc.md#^7c91e2ab).');
  });

  it('rewrites every link of one paragraph', () => {
    const map = new Map([
      ['7c91e2ab', 'one'],
      ['11223344', 'two'],
    ]);
    expect(rewriteLinkSlugs('[A](x.md#^7c91e2ab) and [B](y.md#^11223344)', map)).toBe(
      '[A](one.md#^7c91e2ab) and [B](two.md#^11223344)'
    );
  });

  it('keeps a link whose unit id is unknown', () => {
    const map = new Map([['7c91e2ab', 'new-doc']]);
    expect(rewriteLinkSlugs('[X](old.md#^deadbeef)', map)).toBe('[X](old.md#^deadbeef)');
  });

  it('leaves a link inside a fenced block untouched', () => {
    const map = new Map([['7c91e2ab', 'new-doc']]);
    const text = '# T\n\n```\n[X](old.md#^7c91e2ab)\n```\n';
    expect(rewriteLinkSlugs(text, map)).toBe(text);
  });

  it('leaves a link in a heading untouched, because a heading is not paragraph text', () => {
    const map = new Map([['7c91e2ab', 'new-doc']]);
    const text = '# T\n\n## See [X](old.md#^7c91e2ab)\n';
    expect(rewriteLinkSlugs(text, map)).toBe(text);
  });
});
