import { describe, it, expect } from 'vitest';
import {
  solverSystemPrompt,
  bootstrapperSystemPrompt,
  bootstrapperBrief,
  mergeInstructionPrompt,
  diagnosePrompt,
  editBrief,
  splitPrompt,
  mergeEntriesPrompt,
  reflectPrompt,
  BOOTSTRAP_SKILL_SLUGS,
} from '../../src/learn/prompts.js';
import type { KnowledgeEntry, SourceRef } from '../../src/learn/types.js';

const HEX = 'b'.repeat(32);
const HEX2 = 'd'.repeat(32);
const SECRET = 'ghp_' + 'Z'.repeat(36);

function entry(over: Partial<KnowledgeEntry> = {}): KnowledgeEntry {
  return {
    id: `learned:instruction:proj-a:search-first:v1`,
    kind: 'instruction',
    project: 'proj-a',
    slug: 'search-first',
    version: 1,
    title: 'Search first',
    description: 'Search before reading',
    body: `mode text for release notes [#${HEX}]`,
    scope: 'proj-a release work',
    confidence: 'medium',
    trust: 'verified',
    sources: [],
    status: 'active',
    runId: 'run-1',
    createdAt: '2026-11-01T00:00:00.000Z',
    supersededBy: null,
    validation: null,
    heuristicIds: [],
    decisionId: null,
    procedureId: null,
    ...over,
  };
}

function source(over: Partial<SourceRef> = {}): SourceRef {
  return {
    id: HEX,
    path: '/archive/proj-a/s-0.jsonl',
    lineStart: 1,
    lineEnd: 9,
    sessionId: 'session-0',
    ...over,
  };
}

describe('solverSystemPrompt', () => {
  it('names the role and the answer format', () => {
    const prompt = solverSystemPrompt([], '');
    expect(prompt).toMatch(/solver/i);
    for (const label of ['path:', 'lines:', 'project:', 'date:', 'outcome:']) {
      expect(prompt).toContain(label);
    }
  });

  it('states the citation and honest-answer rules', () => {
    const prompt = solverSystemPrompt([], '');
    expect(prompt).toMatch(/cite|address/i);
    expect(prompt).toMatch(/do not guess|say so|no answer|not found/i);
    expect(prompt).toMatch(/read-only|read only|only the tools/i);
  });

  it('includes the instruction lines verbatim', () => {
    const prompt = solverSystemPrompt([entry()], '');
    expect(prompt).toContain(`mode text for release notes [#${HEX}]`);
  });

  it('includes the skills index', () => {
    const prompt = solverSystemPrompt([], 'navigation: map of the archive (medium, v1)');
    expect(prompt).toContain('navigation: map of the archive (medium, v1)');
    expect(prompt).toMatch(/skills/i);
  });

  it('omits a section it has nothing for rather than printing an empty one', () => {
    const prompt = solverSystemPrompt([], '');
    expect(prompt).not.toMatch(/Instructions:\s*\n\s*\n/);
  });

  it('is pure: the same input gives the same output', () => {
    const a = solverSystemPrompt([entry()], 'alpha: does a thing');
    const b = solverSystemPrompt([entry()], 'alpha: does a thing');
    expect(a).toBe(b);
  });

  it('never carries a planted secret', () => {
    const prompt = solverSystemPrompt([entry({ body: `a line [#${HEX}]` })], 'skill: thing');
    expect(prompt).not.toContain(SECRET);
  });

  it('states that the learned text is data, not instructions', () => {
    const prompt = solverSystemPrompt([entry()], 'alpha: does a thing');
    expect(prompt).toMatch(/data, not instructions|not instructions/i);
  });
});

/** Every prompt a learning run builds, with the inputs a test can plant text in. */
function allPrompts(): Array<[string, string]> {
  const poisoned = entry({ title: SECRET, description: `see ${SECRET}`, body: `mode text for x [#${HEX}] ${SECRET}` });
  return [
    ['bootstrapperSystemPrompt', bootstrapperSystemPrompt()],
    [
      'bootstrapperBrief',
      bootstrapperBrief('proj-a', {
        exchanges: 120,
        sessions: 14,
        first: '2026-01-02',
        last: '2026-06-30',
      }),
    ],
    ['mergeInstructionPrompt', mergeInstructionPrompt([poisoned, entry({ slug: 'other' })])],
    [
      'diagnosePrompt',
      diagnosePrompt({
        project: 'proj-a',
        failed: [
          {
            taskId: 7,
            kind: 'locate',
            tier: 2,
            prompt: `Where was the cache decided? ${SECRET}`,
            answer: `path: /archive/proj-a/s-0.jsonl\nlines: 1-9`,
            trace: [
              { tool: 'mcp__episodic-learn__search', args: { query: 'cache' }, resultAddress: null, resultChars: 40 },
            ],
          },
        ],
        active: [poisoned],
        priorFailures: [{ context: 'paraphrase not matched', failure_mode: 'missed', root_cause: 'wrong mode' }],
        reflections: [entry({ kind: 'reflection', slug: 'r1', body: `a note [#${HEX}]` })],
        projectContext: `facts: ${SECRET}`,
      }),
    ],
    ['editBrief', editBrief({ project: 'proj-a', maxEdits: 3, targets: [7, 8] })],
    [
      'splitPrompt',
      splitPrompt({
        failed: [
          { taskId: 7, project: 'proj-a', kind: 'locate', answer: `wrong project ${SECRET}` },
          { taskId: 9, project: 'proj-b', kind: 'when', answer: 'wrong date' },
        ],
        categories: ['wrong project', 'right session wrong lines', 'paraphrase not matched'],
      }),
    ],
    [
      'mergeEntriesPrompt',
      mergeEntriesPrompt([
        entry({ slug: 'navigation', kind: 'skill', body: `first map [#${HEX}] ${SECRET}` }),
        entry({ slug: 'navigation', kind: 'skill', body: `second map [#${HEX2}]` }),
      ]),
    ],
    [
      'reflectPrompt',
      reflectPrompt({
        runId: 'run-1',
        project: 'proj-a',
        kept: ['learned:skill:proj-a:navigation:v1'],
        rejected: [{ slug: 'bad', reason: 'url' }],
        before: { passed: 1, total: 4 },
        after: { passed: 2, total: 4 },
        evidence: [{ attemptId: 12, taskId: 7, kind: 'locate', passed: false }],
        sources: [source()],
      }),
    ],
  ];
}

describe('the prompts a learning run builds', () => {
  it('all carry the citation, scope and confidence, no-URL no-command and mark rules', () => {
    for (const [name, prompt] of allPrompts()) {
      expect(prompt, name).toMatch(/cite|citation/i);
      expect(prompt, name).toMatch(/scope/i);
      expect(prompt, name).toMatch(/confidence/i);
      expect(prompt, name).toMatch(/url/i);
      expect(prompt, name).toMatch(/command/i);
      expect(prompt, name).toMatch(/mark/i);
    }
  });

  it('never carry a planted secret', () => {
    for (const [name, prompt] of allPrompts()) {
      expect(prompt, name).not.toContain(SECRET);
    }
  });

  it('each is pure: the same input gives the same output', () => {
    for (const [name, prompt] of allPrompts()) {
      const again = new Map(allPrompts()).get(name);
      expect(again, name).toBe(prompt);
    }
  });
});

describe('bootstrapperBrief', () => {
  it('names the project, the corpus span and the two skills to propose', () => {
    const brief = bootstrapperBrief('proj-a', {
      exchanges: 120,
      sessions: 14,
      first: '2026-01-02',
      last: '2026-06-30',
    });
    expect(brief).toContain('proj-a');
    expect(brief).toContain('120');
    expect(brief).toContain('14');
    expect(brief).toContain('2026-01-02');
    expect(brief).toContain('2026-06-30');
    for (const slug of BOOTSTRAP_SKILL_SLUGS) expect(brief).toContain(slug);
  });
});

describe('mergeInstructionPrompt', () => {
  it('numbers the candidates and asks for one global instruction in the template grammar', () => {
    const prompt = mergeInstructionPrompt([entry(), entry({ slug: 'other', body: `terms for x: a, b [#${HEX2}]` })]);
    expect(prompt).toMatch(/\[1\]/);
    expect(prompt).toMatch(/\[2\]/);
    expect(prompt).toMatch(/project <key>:|mode (vector\|text\|both)|terms for|period|absent:/);
    expect(prompt).toMatch(/global/i);
  });
});

describe('splitPrompt', () => {
  it('lists the failed task ids and the category names', () => {
    const prompt = splitPrompt({
      failed: [
        { taskId: 7, project: 'proj-a', kind: 'locate', answer: 'wrong project' },
        { taskId: 9, project: 'proj-b', kind: 'when', answer: 'wrong date' },
      ],
      categories: ['wrong project', 'paraphrase not matched'],
    });
    expect(prompt).toContain('7');
    expect(prompt).toContain('9');
    expect(prompt).toContain('wrong project');
    expect(prompt).toContain('paraphrase not matched');
  });
});

describe('reflectPrompt', () => {
  it('lists attempt ids and exchange marks to copy', () => {
    const prompt = reflectPrompt({
      runId: 'run-1',
      project: 'proj-a',
      kept: ['learned:skill:proj-a:navigation:v1'],
      rejected: [{ slug: 'bad', reason: 'url' }],
      before: { passed: 1, total: 4 },
      after: { passed: 2, total: 4 },
      evidence: [{ attemptId: 12, taskId: 7, kind: 'locate', passed: false }],
      sources: [source()],
    });
    expect(prompt).toContain('[@12]');
    expect(prompt).toContain(`[#${HEX}]`);
  });
});
