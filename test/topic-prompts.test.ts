import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { numberExchanges, buildSessionPrompt } from '../src/digest-prompts.js';
import type { ConversationExchange } from '../src/types.js';
import { SUMMARIZER_CONTEXT_MARKER } from '../src/constants.js';
import { parseTopicDoc, assignUnitIds, UNIT_ID_PATTERN } from '../src/topic-format.js';
import { buildTopicPrompt, parseTopicAnswer, prepareTopicEdit, type TopicPromptDoc } from '../src/topic-prompts.js';

function ex(id: string, user: string, agent = 'ok'): ConversationExchange {
  return {
    id,
    project: 'p',
    timestamp: '2026-10-08T09:00:00.000Z',
    userMessage: user,
    assistantMessage: agent,
    archivePath: '/a.jsonl',
    lineStart: 1,
    lineEnd: 2,
  };
}

const sha = (s: string): string => createHash('sha256').update(s).digest('hex');

const SECRET = 'key sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGH';

/** Golden case 1: a message over 1500 characters, and a planted secret. */
const CLIP_CASE: ConversationExchange[] = [
  ex('3f2a9c0e7b1d4a6f8e5c2b9d0a1f3e7c', 'u'.repeat(1600) + ' tail', `agent says ${SECRET}`),
  ex('0b1c2d3e4f5061728394a5b6c7d8e9fa', 'second user line', 'second agent line'),
];

/**
 * Golden case 2: twenty exchanges that are too big for the 48000 cap, then one small exchange.
 * The small one must still fit after the big ones are skipped, which leaves a gap in the numbering.
 */
const CAP_CASE: ConversationExchange[] = [];
for (let i = 1; i <= 20; i++) CAP_CASE.push(ex(`id-${i}`, 'u'.repeat(1600), 'a'.repeat(1600)));
CAP_CASE.push(ex('id-21', 'short user', 'short agent'));

describe('numberExchanges: byte-identical to the pre-refactor buildSessionPrompt loop', () => {
  // The expected values were captured from the buildSessionPrompt of commit 8690bce, before the refactor.
  it('gives the golden blocks text for the clip and redaction case', () => {
    const { text, marks } = numberExchanges(CLIP_CASE, 48000);
    expect(text.length).toBe(1607);
    expect(sha(text)).toBe('c225a1c55a9fee45c74367529f48dbaff829afe392e74ac83311354cfe4c952d');
    expect(text).toContain(`${'u'.repeat(1500)}...`);
    expect(text).not.toContain('sk-ant-api03');
    expect([...marks.entries()]).toEqual([
      [1, '3f2a9c0e7b1d4a6f8e5c2b9d0a1f3e7c'],
      [2, '0b1c2d3e4f5061728394a5b6c7d8e9fa'],
    ]);
  });

  it('skips an oversize exchange, keeps the next small one, and gives the golden marks at the default cap', () => {
    const { text, marks } = numberExchanges(CAP_CASE, 48000);
    expect(text.length).toBe(45507);
    expect(sha(text)).toBe('a97b5e873bced52a86b54d6e565aa5420b321ada9f30c928620f5f4fbb1f9a34');
    const numbers = [...marks.keys()];
    expect(numbers).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 21]);
    expect(marks.get(21)).toBe('id-21');
  });

  it('keeps only the first block when the cap fits exactly one block', () => {
    const one = '[1] User: x\n[1] Agent: y'.length;
    const { marks } = numberExchanges([ex('a', 'x', 'y'), ex('b', 'x', 'y')], one);
    expect([...marks.entries()]).toEqual([[1, 'a']]);
  });

  it('gives an empty text and no marks when no exchange fits', () => {
    const { text, marks } = numberExchanges([ex('a', 'x', 'y')], 0);
    expect(text).toBe('');
    expect(marks.size).toBe(0);
  });
});

describe('buildSessionPrompt: the default prompt stays byte-identical', () => {
  it('gives the golden prompt for the clip and redaction case', () => {
    const { prompt, marks } = buildSessionPrompt(CLIP_CASE);
    expect(prompt.length).toBe(2158);
    expect(sha(prompt)).toBe('ea28e48d3068edd074e01640b6749f4cb2f04c4b138d0f8402b38cb62634246e');
    expect(marks.size).toBe(2);
  });

  it('gives the golden prompt for the cap case', () => {
    const { prompt, marks } = buildSessionPrompt(CAP_CASE);
    expect(prompt.length).toBe(46058);
    expect(sha(prompt)).toBe('714ca1fbe20d413f2791836b4fd6fe3a1552f543391edb32a8b26bdf08c05e7a');
    expect(marks.size).toBe(16);
  });
});

const EXCHANGE_ID = '3f2a9c0e7b1d4a6f8e5c2b9d0a1f3e7c';
const EXCH = [ex(EXCHANGE_ID, 'first user line', 'first agent line')];

/** A document whose text has exactly `length` characters. */
function doc(slug: string, length: number, updatedAt = '2026-11-10T10:00:00.000Z', headings = ['Intro']): TopicPromptDoc {
  return { slug, title: slug.toUpperCase(), headings, text: 'a'.repeat(length), updatedAt };
}

const DOC_A: TopicPromptDoc = {
  slug: 'alpha',
  title: 'Alpha',
  headings: ['Intro', 'Plan'],
  text: '# Alpha\n\n## Intro\n\nP.[^1]\n^11111111\n\n[^1]: Time: 2026; Sources: #ex-1\n',
  updatedAt: '2026-11-10T10:00:00.000Z',
};

describe('buildTopicPrompt', () => {
  const input = (docs: TopicPromptDoc[], maxDocsChars: number, budgetChars: number, maxTranscriptChars = 48000) => ({
    exchanges: EXCH,
    docs,
    maxTranscriptChars,
    maxDocsChars,
    budgetChars,
  });

  it('holds the marker, the rules, the inventory, the shown documents and the conversation, in order', () => {
    const result = buildTopicPrompt(input([DOC_A], 100000, 1000000));
    expect(result).not.toBeNull();
    const prompt = result!.prompt;
    expect(prompt.startsWith(`${SUMMARIZER_CONTEXT_MARKER}.`)).toBe(true);
    expect(prompt).toContain('=== FILE <slug>');
    expect(prompt).toContain('=== DELETE <slug>');
    const positions = ['Inventory:', 'Documents shown in full:', 'Conversation:'].map(s => prompt.indexOf(s));
    expect(positions.every(p => p >= 0)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
  });

  it('writes one inventory line per document with its title and headings, shown or not', () => {
    const beta = doc('beta', 500, '2026-11-09T10:00:00.000Z', ['Only']);
    const result = buildTopicPrompt(input([DOC_A, beta], DOC_A.text.length, 1000000));
    expect(result).not.toBeNull();
    expect(result!.prompt).toContain('- alpha: Alpha | Intro / Plan\n');
    expect(result!.prompt).toContain('- beta: BETA | Only\n');
    expect([...result!.shown.keys()]).toEqual(['alpha']);
  });

  it('writes a shown document as a FILE block with the text and END, with the same form as an answer block', () => {
    const result = buildTopicPrompt(input([DOC_A], 100000, 1000000));
    expect(result!.prompt).toContain(`=== FILE alpha\n${DOC_A.text}=== END`);
    const noNewline: TopicPromptDoc = { ...DOC_A, slug: 'beta', text: '# Beta' };
    const second = buildTopicPrompt(input([noNewline], 100000, 1000000));
    expect(second!.prompt).toContain('=== FILE beta\n# Beta\n=== END');
  });

  it('shows documents in the given order while they fit, and stops at the first one that does not fit', () => {
    const a = doc('a', 100);
    const b = doc('b', 80);
    const c = doc('c', 5);
    // a (100) fits, b makes 180 which is over 160, so c is not shown even though it would fit.
    expect([...buildTopicPrompt(input([a, b, c], 160, 1000000))!.shown.keys()]).toEqual(['a']);
    // Exactly 185 characters: a, b and c all fit.
    expect([...buildTopicPrompt(input([a, b, c], 185, 1000000))!.shown.keys()]).toEqual(['a', 'b', 'c']);
    // 184 characters: c does not fit.
    expect([...buildTopicPrompt(input([a, b, c], 184, 1000000))!.shown.keys()]).toEqual(['a', 'b']);
  });

  it('drops the oldest shown document when the prompt is over budget', () => {
    const a = doc('a', 100);
    const b = doc('b', 80);
    const c = doc('c', 5);
    const all = buildTopicPrompt(input([a, b, c], 100000, 1000000))!;
    expect([...all.shown.keys()]).toEqual(['a', 'b', 'c']);
    const dropped = buildTopicPrompt(input([a, b, c], 100000, all.prompt.length - 1))!;
    expect([...dropped.shown.keys()]).toEqual(['a', 'b']);
    expect(dropped.prompt.length).toBeLessThanOrEqual(all.prompt.length - 1);
  });

  it('drops documents until the prompt fits, and the result equals the prompt with only the first document shown', () => {
    const a = doc('a', 100);
    const b = doc('b', 80);
    const c = doc('c', 5);
    const onlyA = buildTopicPrompt(input([a, b, c], 100, 1000000))!;
    expect([...onlyA.shown.keys()]).toEqual(['a']);
    const fitted = buildTopicPrompt(input([a, b, c], 100000, onlyA.prompt.length))!;
    expect([...fitted.shown.keys()]).toEqual(['a']);
    expect(fitted.prompt).toBe(onlyA.prompt);
  });

  it('shortens the transcript when the prompt is over budget with no shown document', () => {
    const many = Array.from({ length: 40 }, (_, i) => ex(`m${i}`, `question ${i} `.repeat(5), `answer ${i} `.repeat(5)));
    const full = buildTopicPrompt({ exchanges: many, docs: [], maxTranscriptChars: 100000, maxDocsChars: 0, budgetChars: 1000000 })!;
    const budget = Math.floor(full.prompt.length / 2);
    const short = buildTopicPrompt({ exchanges: many, docs: [], maxTranscriptChars: 100000, maxDocsChars: 0, budgetChars: budget })!;
    expect(short.prompt.length).toBeLessThanOrEqual(budget);
    expect(short.marks.size).toBeGreaterThan(0);
    expect(short.marks.size).toBeLessThan(full.marks.size);
  });

  it('cuts each inventory line to 240 characters', () => {
    const wide = { ...doc('wide', 10), headings: Array.from({ length: 40 }, (_, i) => `Heading number ${i}`) };
    const result = buildTopicPrompt(input([wide], 0, 1000000))!;
    const line = result.prompt.split('\n').find(l => l.startsWith('- wide: '))!;
    expect(line.length).toBe(240);
    expect(line.endsWith('…')).toBe(true);
  });

  it('returns null only when no exchange fits', () => {
    expect(buildTopicPrompt(input([], 0, 1000000, 10))).toBeNull();
  });

  it('returns null when the prompt is over budget with no shown document', () => {
    expect(buildTopicPrompt(input([DOC_A], 100000, 10))).toBeNull();
  });

  it('returns a prompt with no shown document when no document fits maxDocsChars', () => {
    const result = buildTopicPrompt(input([doc('a', 100)], 0, 1000000));
    expect(result).not.toBeNull();
    expect(result!.shown.size).toBe(0);
  });

  it('maps each shown slug to its updatedAt', () => {
    const result = buildTopicPrompt(input([DOC_A, doc('b', 5, '2026-11-01T00:00:00.000Z')], 100000, 1000000));
    expect(result!.shown.get('alpha')).toBe(DOC_A.updatedAt);
    expect(result!.shown.get('b')).toBe('2026-11-01T00:00:00.000Z');
  });

  it('numbers the transcript and maps the marks, and the transcript cap reaches numberExchanges', () => {
    const result = buildTopicPrompt(input([], 100000, 1000000));
    expect([...result!.marks.entries()]).toEqual([[1, EXCHANGE_ID]]);
    expect(result!.prompt).toContain('[1] 2026-10-08 User: first user line');
    // A transcript cap that holds no exchange gives no prompt: the model is never asked about nothing.
    expect(buildTopicPrompt(input([], 100000, 1000000, 0))).toBeNull();
  });

  it('never returns a prompt above the budget, and fits once the budget is large enough', () => {
    const docs = [doc('a', 300), doc('b', 200), doc('c', 50)];
    const full = buildTopicPrompt(input(docs, 100000, 1000000))!.prompt.length;
    expect(buildTopicPrompt(input(docs, 100000, 0))).toBeNull();
    expect(buildTopicPrompt(input(docs, 100000, full))!.prompt.length).toBe(full);
    let seenFit = false;
    for (let budget = 0; budget <= full + 50; budget += 37) {
      const result = buildTopicPrompt(input(docs, 100000, budget));
      if (seenFit) expect(result).not.toBeNull();
      if (result !== null) {
        seenFit = true;
        expect(result.prompt.length).toBeLessThanOrEqual(budget);
      }
    }
    expect(seenFit).toBe(true);
  });

  it('shows the most recently updated documents first, whatever the input order', () => {
    const older = { ...doc('older', 10), updatedAt: '2026-01-01T00:00:00.000Z' };
    const newer = { ...doc('newer', 10), updatedAt: '2026-02-01T00:00:00.000Z' };
    const result = buildTopicPrompt(input([older, newer], 15, 1000000))!;
    expect([...result.shown.keys()]).toEqual(['newer']);
  });

  it('drops the oldest shown document first under the budget, whatever the input order', () => {
    const older = { ...doc('older', 200), updatedAt: '2026-01-01T00:00:00.000Z' };
    const newer = { ...doc('newer', 200), updatedAt: '2026-02-01T00:00:00.000Z' };
    const both = buildTopicPrompt(input([older, newer], 100000, 1000000))!.prompt.length;
    const result = buildTopicPrompt(input([older, newer], 100000, both - 1))!;
    expect([...result.shown.keys()]).toEqual(['newer']);
  });

  it('asks for the word NOTHING when the conversation adds nothing', () => {
    expect(buildTopicPrompt(input([], 0, 1000000))!.prompt).toContain('- If the conversation adds nothing, answer with the single word NOTHING.');
    expect(parseTopicAnswer('NOTHING')).toEqual({ blocks: [], errors: [] });
  });

  it('tells the model to write no line that starts with ===', () => {
    expect(buildTopicPrompt(input([], 0, 1000000))!.prompt).toContain('- Write no line that starts with ===, except in a block header.');
  });
});

describe('parseTopicAnswer: fences', () => {
  it('keeps an END line inside a fence as text', () => {
    const answer = '=== FILE a\n# A\n\n```\n=== END\n```\n\nKept.[^1]\n=== END';
    expect(parseTopicAnswer(answer)).toEqual({
      blocks: [{ kind: 'file', slug: 'a', text: '# A\n\n```\n=== END\n```\n\nKept.[^1]\n' }],
      errors: [],
    });
  });

  it('keeps FILE and DELETE lines inside a tilde fence as text', () => {
    const answer = '=== FILE a\n~~~\n=== FILE x\n=== DELETE y\n~~~\n=== END';
    expect(parseTopicAnswer(answer)).toEqual({
      blocks: [{ kind: 'file', slug: 'a', text: '~~~\n=== FILE x\n=== DELETE y\n~~~\n' }],
      errors: [],
    });
  });

  it('does not close a four-backtick fence on three backticks', () => {
    const answer = '=== FILE a\n````\n```\n=== END\n````\n=== END';
    expect(parseTopicAnswer(answer)).toEqual({
      blocks: [{ kind: 'file', slug: 'a', text: '````\n```\n=== END\n````\n' }],
      errors: [],
    });
  });

  it('reports a block whose fence never closes', () => {
    expect(parseTopicAnswer('=== FILE a\n```\n=== END\n')).toEqual({
      blocks: [],
      errors: ['unterminated FILE block for a'],
    });
  });
});

describe('parseTopicAnswer', () => {
  it('reads a FILE block: the lines up to END, joined, with a final newline', () => {
    const answer = '=== FILE alpha\n# Alpha\n\nP.\n=== END\n';
    expect(parseTopicAnswer(answer)).toEqual({
      blocks: [{ kind: 'file', slug: 'alpha', text: '# Alpha\n\nP.\n' }],
      errors: [],
    });
  });

  it('reads a DELETE block', () => {
    expect(parseTopicAnswer('=== DELETE beta\n')).toEqual({
      blocks: [{ kind: 'delete', slug: 'beta' }],
      errors: [],
    });
  });

  it('gives no blocks and no errors for an empty answer', () => {
    expect(parseTopicAnswer('')).toEqual({ blocks: [], errors: [] });
  });

  it('ignores text outside the blocks', () => {
    const answer = 'Here is the update.\n=== FILE a\n# A\n=== END\nThanks, done.\n';
    expect(parseTopicAnswer(answer)).toEqual({
      blocks: [{ kind: 'file', slug: 'a', text: '# A\n' }],
      errors: [],
    });
  });

  it('keeps the text lines of a block, even ones that look like junk, and allows trailing spaces on END', () => {
    const answer = '=== FILE a\nNote: keep me\n=== END   \n';
    expect(parseTopicAnswer(answer).blocks).toEqual([{ kind: 'file', slug: 'a', text: 'Note: keep me\n' }]);
  });

  it('reports an unterminated FILE block and drops it', () => {
    expect(parseTopicAnswer('=== FILE alpha\n# Alpha\n')).toEqual({
      blocks: [],
      errors: ['unterminated FILE block for alpha'],
    });
  });

  it('reports a FILE block that another FILE line interrupts, then reads the new block', () => {
    expect(parseTopicAnswer('=== FILE a\nx\n=== FILE b\ny\n=== END\n')).toEqual({
      blocks: [{ kind: 'file', slug: 'b', text: 'y\n' }],
      errors: ['unterminated FILE block for a'],
    });
  });

  it('reports a FILE block that a DELETE line interrupts, then reads the delete', () => {
    expect(parseTopicAnswer('=== FILE a\nx\n=== DELETE b\n')).toEqual({
      blocks: [{ kind: 'delete', slug: 'b' }],
      errors: ['unterminated FILE block for a'],
    });
  });

  it('reads a CRLF answer', () => {
    expect(parseTopicAnswer('=== FILE a\r\n# A\r\nP.\r\n=== END\r\n')).toEqual({
      blocks: [{ kind: 'file', slug: 'a', text: '# A\nP.\n' }],
      errors: [],
    });
  });

  it('trims the slug', () => {
    expect(parseTopicAnswer('=== DELETE   alpha  \n').blocks).toEqual([{ kind: 'delete', slug: 'alpha' }]);
  });
});

describe('prepareTopicEdit: review fixes', () => {
  const run = (text: string) =>
    prepareTopicEdit({ project: 'proj', blocks: [{ kind: 'file', slug: 'a', text }], marks: new Map([[3, 'ex-3']]), before: new Map() });

  it('keeps the prose on the line after a Bearer line', () => {
    const out = run('# A\n\nAuth header is Bearer\nPlain words follow.[^1]\n^22222222\n\n[^1]: Time: 2026; Sources: 3\n');
    expect(out).toEqual([
      {
        kind: 'file',
        slug: 'a',
        text: '# A\n\nAuth header is Bearer\nPlain words follow.[^1]\n^22222222\n\n[^1]: Time: 2026; Sources: #ex-3\n',
      },
    ]);
  });

  it('keeps the text of a block with a malformed definition as the model wrote it', () => {
    expect(run('# A\n\nText.[^1]\n\n[^1]: Sources: 3\n')).toEqual([
      { kind: 'file', slug: 'a', text: '# A\n\nText.[^1]\n\n[^1]: Sources: 3\n' },
    ]);
  });

  it('keeps a secret-shaped link target and still redacts a secret in the prose', () => {
    const secret = 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGH';
    const out = run(`# A\n\nSee [u](sk-beta-notes-for-the-project.md#^deadbeef) and ${secret}.[^1]\n^11111111\n\n[^1]: Time: 2026; Sources: 3\n`);
    expect(out).toEqual([
      {
        kind: 'file',
        slug: 'a',
        text: '# A\n\nSee [u](sk-beta-notes-for-the-project.md#^deadbeef) and [redacted].[^1]\n^11111111\n\n[^1]: Time: 2026; Sources: #ex-3\n',
      },
    ]);
  });
});

describe('prepareTopicEdit', () => {
  const ALPHA_BEFORE = '# Alpha\n\n## S\n\nA1.[^1]\n^11111111\n\n[^1]: Time: 2026; Sources: #ex-1\n';
  const BETA_BEFORE = '# Beta\n\n## S\n\nB1.[^1]\n^22222222\n\n[^1]: Time: 2026; Sources: #ex-2\n';
  const SECRET_TOKEN = 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGH';

  it('rewrites marks, redacts, gives a new paragraph an id, and rewrites the link slug after a move', () => {
    const before = new Map([
      ['alpha', ALPHA_BEFORE],
      ['beta', BETA_BEFORE],
    ]);
    const alphaText =
      '# Alpha\n\n## S\n\nA1.[^1]\n^11111111\n\n' +
      'B1 moved here.[^2]\n^22222222\n\n' +
      `New fact, ${SECRET_TOKEN}.[^3]\n\n` +
      'See [b](beta.md#^22222222) and [gone](old.md#^deadbeef).[^4]\n\n' +
      '[^1]: Time: 2026; Sources: #ex-1\n[^2]: Time: 2026; Sources: #ex-2\n' +
      '[^3]: Time: 2026-05; Sources: 3\n[^4]: Time: 2026-05; Sources: #ex-2\n';
    const betaText = '# Beta\n\n## S\n\nB0 left.[^1]\n\n[^1]: Time: 2026-06; Sources: #ex-2\n';
    const out = prepareTopicEdit({
      project: 'proj',
      blocks: [
        { kind: 'file', slug: 'alpha', text: alphaText },
        { kind: 'file', slug: 'beta', text: betaText },
      ],
      marks: new Map([[3, EXCHANGE_ID]]),
      before,
    });
    expect(out.map(b => b.kind)).toEqual(['file', 'file']);
    const alpha = out[0];
    if (alpha.kind !== 'file') throw new Error('expected a file block');
    const docA = parseTopicDoc('alpha', alpha.text);
    expect(docA.definitions.find(d => d.label === '3')?.refs).toEqual([`#${EXCHANGE_ID}`]);
    expect(alpha.text).not.toContain('sk-ant-api03');
    expect(alpha.text).toContain('^11111111');
    const fresh = docA.units.find(u => u.text.startsWith('New fact'));
    expect(fresh?.unitId).toMatch(UNIT_ID_PATTERN);
    const linking = docA.units.find(u => u.text.startsWith('See'));
    expect(linking?.links).toEqual([
      { slug: 'alpha', unitId: '22222222' },
      { slug: 'old', unitId: 'deadbeef' },
    ]);
    const beta = out[1];
    if (beta.kind !== 'file') throw new Error('expected a file block');
    expect(parseTopicDoc('beta', beta.text).units[0].unitId).toMatch(UNIT_ID_PATTERN);
    // The whole prepared text. The new ids are the first 8 hex of SHA-1(project NUL slug NUL text).
    expect(out).toEqual([
      {
        kind: 'file',
        slug: 'alpha',
        text:
          '# Alpha\n\n## S\n\nA1.[^1]\n^11111111\n\nB1 moved here.[^2]\n^22222222\n\n' +
          'New fact, [redacted].[^3]\n^10074df3\n\n' +
          'See [b](alpha.md#^22222222) and [gone](old.md#^deadbeef).[^4]\n^b64566f6\n\n' +
          '[^1]: Time: 2026; Sources: #ex-1\n[^2]: Time: 2026; Sources: #ex-2\n' +
          `[^3]: Time: 2026-05; Sources: #${EXCHANGE_ID}\n[^4]: Time: 2026-05; Sources: #ex-2\n`,
      },
      { kind: 'file', slug: 'beta', text: '# Beta\n\n## S\n\nB0 left.[^1]\n^401f2979\n\n[^1]: Time: 2026-06; Sources: #ex-2\n' },
    ]);
  });

  it('passes a DELETE block through in its order and keeps the other blocks', () => {
    const out = prepareTopicEdit({
      project: 'proj',
      blocks: [
        { kind: 'delete', slug: 'beta' },
        { kind: 'file', slug: 'alpha', text: ALPHA_BEFORE },
      ],
      marks: new Map(),
      before: new Map([
        ['alpha', ALPHA_BEFORE],
        ['beta', BETA_BEFORE],
      ]),
    });
    expect(out[0]).toEqual({ kind: 'delete', slug: 'beta' });
    expect(out[1].kind).toBe('file');
    expect(out.length).toBe(2);
  });

  it('keeps an unknown link id as written', () => {
    const out = prepareTopicEdit({
      project: 'proj',
      blocks: [{ kind: 'file', slug: 'alpha', text: '# Alpha\n\n## S\n\nSee [x](gone.md#^deadbeef).[^1]\n^11111111\n\n[^1]: Time: 2026; Sources: #ex-1\n' }],
      marks: new Map(),
      before: new Map([['alpha', ALPHA_BEFORE]]),
    });
    const alpha = out[0];
    if (alpha.kind !== 'file') throw new Error('expected a file block');
    expect(alpha.text).toContain('[x](gone.md#^deadbeef)');
  });

  it('does not give a new paragraph an id that an untouched document already uses', () => {
    const freshText = '# Alpha\n\n## S\n\nFresh paragraph.[^1]\n\n[^1]: Time: 2026; Sources: #ex-1\n';
    // The id that the paragraph would get with no other id taken.
    const hashed = assignUnitIds('proj', 'alpha', parseTopicDoc('alpha', freshText), new Set()).units[0].unitId!;
    const betaUsesIt = `# Beta\n\n## S\n\nB1.[^1]\n^${hashed}\n\n[^1]: Time: 2026; Sources: #ex-2\n`;
    const out = prepareTopicEdit({
      project: 'proj',
      blocks: [{ kind: 'file', slug: 'alpha', text: freshText }],
      marks: new Map(),
      before: new Map([
        ['alpha', ALPHA_BEFORE],
        ['beta', betaUsesIt],
      ]),
    });
    const alpha = out[0];
    if (alpha.kind !== 'file') throw new Error('expected a file block');
    const id = parseTopicDoc('alpha', alpha.text).units[0].unitId;
    expect(id).toMatch(UNIT_ID_PATTERN);
    expect(id).not.toBe(hashed);
  });

  it('gives a new paragraph of an earlier block an id that a later block keeps explicitly', () => {
    // alpha gets a new paragraph, whose hashed id is `hashed`. beta keeps `hashed` explicitly, so alpha must not take it.
    const alphaNew = '# Alpha\n\n## S\n\nFresh alpha.[^1]\n\n[^1]: Time: 2026; Sources: #ex-1\n';
    const hashed = assignUnitIds('proj', 'alpha', parseTopicDoc('alpha', alphaNew), new Set()).units[0].unitId!;
    const betaKeeps = `# Beta\n\n## S\n\nKept beta.[^1]\n^${hashed}\n\n[^1]: Time: 2026; Sources: #ex-2\n`;
    const out = prepareTopicEdit({
      project: 'proj',
      blocks: [
        { kind: 'file', slug: 'alpha', text: alphaNew },
        { kind: 'file', slug: 'beta', text: betaKeeps },
      ],
      marks: new Map(),
      before: new Map([['alpha', ALPHA_BEFORE]]),
    });
    const alpha = out[0];
    if (alpha.kind !== 'file') throw new Error('expected a file block');
    const id = parseTopicDoc('alpha', alpha.text).units[0].unitId;
    expect(id).toMatch(UNIT_ID_PATTERN);
    expect(id).not.toBe(hashed);
  });

  it('gives a new paragraph of a later block an id that an earlier block keeps explicitly', () => {
    // alpha keeps `hashed` explicitly. beta gets a new paragraph, whose hashed id is `hashed`, so beta must not take it.
    const betaNew = '# Beta\n\n## S\n\nFresh beta.[^1]\n\n[^1]: Time: 2026; Sources: #ex-2\n';
    const hashed = assignUnitIds('proj', 'beta', parseTopicDoc('beta', betaNew), new Set()).units[0].unitId!;
    const alphaKeeps = `# Alpha\n\n## S\n\nKept alpha.[^1]\n^${hashed}\n\n[^1]: Time: 2026; Sources: #ex-1\n`;
    const out = prepareTopicEdit({
      project: 'proj',
      blocks: [
        { kind: 'file', slug: 'alpha', text: alphaKeeps },
        { kind: 'file', slug: 'beta', text: betaNew },
      ],
      marks: new Map(),
      before: new Map([['alpha', ALPHA_BEFORE]]),
    });
    const beta = out[1];
    if (beta.kind !== 'file') throw new Error('expected a file block');
    const id = parseTopicDoc('beta', beta.text).units[0].unitId;
    expect(id).toMatch(UNIT_ID_PATTERN);
    expect(id).not.toBe(hashed);
  });

  it('keeps the exchange id that a source already cites, after redaction', () => {
    const out = prepareTopicEdit({
      project: 'proj',
      blocks: [
        {
          kind: 'file',
          slug: 'alpha',
          text: `# Alpha\n\n## S\n\nOld cite.[^1]\n^11111111\n\n[^1]: Time: 2026; Sources: #${EXCHANGE_ID}\n`,
        },
      ],
      marks: new Map(),
      before: new Map([['alpha', ALPHA_BEFORE]]),
    });
    const alpha = out[0];
    if (alpha.kind !== 'file') throw new Error('expected a file block');
    expect(parseTopicDoc('alpha', alpha.text).definitions[0].refs).toEqual([`#${EXCHANGE_ID}`]);
  });
});

describe('numberExchanges: dated', () => {
  const late = { ...ex('b', 'second'), timestamp: '2026-06-27T03:41:57.989Z' };

  it('puts the UTC date of each exchange on its User line', () => {
    const { text, marks } = numberExchanges([ex('a', 'first'), late], 48000, { dated: true });
    expect(text).toBe('[1] 2026-10-08 User: first\n[1] Agent: ok\n\n[2] 2026-06-27 User: second\n[2] Agent: ok');
    expect([...marks.entries()]).toEqual([[1, 'a'], [2, 'b']]);
  });

  it('counts the date in the cap', () => {
    const one = '[1] 2026-10-08 User: first\n[1] Agent: ok'.length;
    expect(numberExchanges([ex('a', 'first'), late], one, { dated: true }).marks.size).toBe(1);
    expect(numberExchanges([ex('a', 'first'), late], one - 1, { dated: true }).marks.size).toBe(0);
  });

  it('keeps the undated form without the option', () => {
    expect(numberExchanges([ex('a', 'first')], 48000).text).toBe('[1] User: first\n[1] Agent: ok');
  });
});

describe('buildTopicPrompt: the rules', () => {
  const prompt = (): string =>
    buildTopicPrompt({ exchanges: EXCH, docs: [], maxTranscriptChars: 48000, maxDocsChars: 0, budgetChars: 1000000 })!.prompt;

  it('shows the date of each conversation turn and says what Time means', () => {
    expect(prompt()).toContain('[1] 2026-10-08 User: first user line');
    expect(prompt()).toContain('- Time is the date of the conversation turns that the footnote cites, unless the conversation states another time for the event.');
  });

  it('asks for plain paragraphs, one label per paragraph, no period after a source and an END line', () => {
    const p = prompt();
    expect(p).toContain('- Write plain paragraphs only. Do not write bullet lists, numbered lists or tables.');
    expect(p).toContain('Never put the same label on two paragraphs.');
    expect(p).toContain('Write no period after the last source.');
    expect(p).toContain('- Always end each document with a line that says === END.');
  });

  it('gives an example block that parses as a valid document', () => {
    const p = prompt();
    const start = p.indexOf('Example of one correct block:');
    expect(start).toBeGreaterThan(0);
    const example = p.slice(start, p.indexOf('=== END', start) + '=== END'.length);
    const parsed = parseTopicAnswer(example);
    expect(parsed.errors).toEqual([]);
    expect(parsed.blocks).toHaveLength(1);
    const block = parsed.blocks[0];
    if (block.kind !== 'file') throw new Error('expected a file block');
    const docParsed = parseTopicDoc(block.slug, block.text);
    expect(docParsed.errors).toEqual([]);
    expect(docParsed.definitions.length).toBeGreaterThan(1);
  });

  it('gives no concrete date outside the example block', () => {
    const p = prompt();
    const rules = p.slice(0, p.indexOf('Example of one correct block:'));
    expect(rules).not.toMatch(/\d{4}-\d{2}-\d{2}/);
  });
});

describe('numberExchanges: the cap bounds the whole text', () => {
  it('never returns a text longer than the cap, separators included', () => {
    const exchanges = Array.from({ length: 30 }, (_, i) => ex(`id-${i}`, 'u'.repeat(40 + (i % 7) * 13), 'a'.repeat(30)));
    for (const cap of [0, 1, 50, 99, 100, 101, 250, 1098, 1500, 2999, 100000]) {
      expect(numberExchanges(exchanges, cap).text.length).toBeLessThanOrEqual(cap);
    }
  });

  it('keeps nine 100-character blocks out of a 1098 cap when their separators do not fit', () => {
    const exchanges = Array.from({ length: 9 }, (_, i) => ex(`id-${i}`, 'u'.repeat(30), 'a'.repeat(100 - 30 - '[1] User: \n[1] Agent: '.length)));
    const out = numberExchanges(exchanges, 1098);
    expect(out.text.length).toBeLessThanOrEqual(1098);
  });
});
