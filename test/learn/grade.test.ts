import { describe, it, expect, vi } from 'vitest';
import {
  parseSolverAnswer,
  samePath,
  gradeLocate,
  gradeWhen,
  gradeMulti,
  gradeRecall,
} from '../../src/learn/grade.js';
import type { SourceRef, TaskTruth } from '../../src/learn/types.js';

const HEX_A = 'a'.repeat(32);
const HEX_B = 'b'.repeat(32);

const WIN_PATH = 'C:\\Users\\danie\\archive\\proj\\s1.jsonl';

function ref(over: Partial<SourceRef> = {}): SourceRef {
  return {
    id: HEX_A,
    path: WIN_PATH,
    lineStart: 10,
    lineEnd: 20,
    sessionId: 's1',
    ...over,
  };
}

function truth(over: Partial<TaskTruth> = {}): TaskTruth {
  return {
    exchanges: [ref()],
    sessionDateRange: ['2026-03-04', '2026-03-06'],
    project: 'proj-a',
    assistantMessage: 'We chose sqlite for the cache and dropped redis.',
    ...over,
  };
}

describe('parseSolverAnswer', () => {
  it('reads a markdown answer with backslash paths', () => {
    const answer = parseSolverAnswer(
      [
        'Here is what I found:',
        '',
        '```',
        '**path:** `C:\\Users\\danie\\archive\\proj\\s1.jsonl`',
        '**lines:** 12-18',
        '**project:** proj-a',
        '```',
      ].join('\n')
    );

    expect(answer.path).toBe(WIN_PATH);
    expect(answer.lineStart).toBe(12);
    expect(answer.lineEnd).toBe(18);
    expect(answer.project).toBe('proj-a');
    expect(answer.locations).toEqual([
      { path: WIN_PATH, lineStart: 12, lineEnd: 18 },
    ]);
  });

  it('reads a plain answer and a single line number', () => {
    const answer = parseSolverAnswer('path: /a/b.jsonl\nlines: 42\nproject: proj-a');
    expect(answer.path).toBe('/a/b.jsonl');
    expect(answer.lineStart).toBe(42);
    expect(answer.lineEnd).toBe(42);
  });

  it('reads several locations from one answer', () => {
    const answer = parseSolverAnswer(
      ['- path: /a/one.jsonl', '- lines: 1-5', '- path: /a/two.jsonl', '- lines: 9-12'].join('\n')
    );
    expect(answer.locations).toEqual([
      { path: '/a/one.jsonl', lineStart: 1, lineEnd: 5 },
      { path: '/a/two.jsonl', lineStart: 9, lineEnd: 12 },
    ]);
    expect(answer.path).toBe('/a/one.jsonl');
  });

  it('reads the date, outcome and tolerant separators', () => {
    const answer = parseSolverAnswer(['date = 2026-03-05', 'outcome: switched to sqlite'].join('\n'));
    expect(answer.date).toBe('2026-03-05');
    expect(answer.outcome).toBe('switched to sqlite');
  });

  it('returns an empty answer for text with no address', () => {
    const answer = parseSolverAnswer('I could not find it.');
    expect(answer.path).toBeUndefined();
    expect(answer.locations).toEqual([]);
  });
});

describe('samePath', () => {
  it('treats mixed separators as the same path', () => {
    expect(samePath('C:\\Users\\danie\\a.jsonl', 'C:/Users/danie/a.jsonl')).toBe(true);
  });

  it('folds case for Windows-shaped paths (drive letter) on every platform', () => {
    expect(samePath('C:\\Repo\\A.jsonl', 'c:/repo/a.jsonl')).toBe(true);
  });

  it('keeps POSIX paths case-sensitive off Windows', () => {
    expect(samePath('/a/B.jsonl', '/a/b.jsonl')).toBe(process.platform === 'win32');
  });

  it('is false for a relative and an absolute path that differ', () => {
    expect(samePath('/a/b.jsonl', '/a/c/d.jsonl')).toBe(false);
  });
});

describe('gradeLocate', () => {
  it('scores 1.0 when the path matches with mixed slashes and the ranges overlap', () => {
    const result = gradeLocate(
      truth(),
      parseSolverAnswer('path: c:/users/DANIE/archive/proj/s1.jsonl\nlines: 15-25')
    );
    expect(result).toEqual({ passed: true, score: 1 });
  });

  it('scores 0.5 when the path matches but the range does not overlap', () => {
    const result = gradeLocate(truth(), parseSolverAnswer(`path: ${WIN_PATH}\nlines: 100-120`));
    expect(result).toEqual({ passed: false, score: 0.5 });
  });

  it('scores 0 for a different file', () => {
    const result = gradeLocate(truth(), parseSolverAnswer('path: /other/session.jsonl\nlines: 1-5'));
    expect(result).toEqual({ passed: false, score: 0 });
  });

  it('scores 0 when the answer gives no path', () => {
    expect(gradeLocate(truth(), parseSolverAnswer('no idea')).score).toBe(0);
  });

  it('accepts any of the truth exchanges', () => {
    const t = truth({
      exchanges: [ref(), ref({ id: HEX_B, path: '/a/second.jsonl', lineStart: 1, lineEnd: 9 })],
    });
    expect(gradeLocate(t, parseSolverAnswer('path: /a/second.jsonl\nlines: 3-4')).score).toBe(1);
  });
});

describe('gradeWhen', () => {
  it('passes a date inside the session range', () => {
    const result = gradeWhen(truth(), parseSolverAnswer('date: 2026-03-05\nproject: proj-a'));
    expect(result.passed).toBe(true);
    expect(result.score).toBe(1);
  });

  it('passes one day outside either edge of the range', () => {
    expect(gradeWhen(truth(), parseSolverAnswer('date: 2026-03-03\nproject: proj-a')).passed).toBe(
      true
    );
    expect(gradeWhen(truth(), parseSolverAnswer('date: 2026-03-07\nproject: proj-a')).passed).toBe(
      true
    );
  });

  it('fails two days outside the widened range', () => {
    expect(gradeWhen(truth(), parseSolverAnswer('date: 2026-03-08\nproject: proj-a')).passed).toBe(
      false
    );
    expect(gradeWhen(truth(), parseSolverAnswer('date: 2026-03-02\nproject: proj-a')).passed).toBe(
      false
    );
  });

  it('fails when the project differs even with a correct date', () => {
    expect(gradeWhen(truth(), parseSolverAnswer('date: 2026-03-05\nproject: proj-b')).passed).toBe(
      false
    );
  });

  it('fails when the answer carries no date', () => {
    expect(gradeWhen(truth(), parseSolverAnswer('project: proj-a')).passed).toBe(false);
  });
});

describe('gradeMulti', () => {
  const multiTruth = truth({
    exchanges: [
      ref(),
      ref({ id: HEX_B, path: 'C:/Users/danie/archive/proj/s2.jsonl', lineStart: 3, lineEnd: 8 }),
    ],
  });

  it('passes only when every address is located', () => {
    const both = parseSolverAnswer(
      [
        `path: ${WIN_PATH}`,
        'lines: 11-12',
        'path: c:/users/danie/archive/proj/s2.jsonl',
        'lines: 4-6',
      ].join('\n')
    );
    const one = parseSolverAnswer(`path: ${WIN_PATH}\nlines: 11-12`);

    expect(gradeMulti(multiTruth, both)).toEqual({ passed: true, score: 1 });
    expect(gradeMulti(multiTruth, one)).toEqual({ passed: false, score: 0.5 });
  });
});

describe('gradeRecall', () => {
  const located = parseSolverAnswer(`path: ${WIN_PATH}\nlines: 12-18\noutcome: chose sqlite`);

  it('fails when the location fails even with a high judge score', async () => {
    const judge = vi.fn(async () => '<score>1.0</score>');
    const result = await gradeRecall(
      truth(),
      parseSolverAnswer('path: /nope/x.jsonl\nlines: 1-2\noutcome: chose sqlite'),
      judge
    );
    expect(result.passed).toBe(false);
    expect(result.score).toBe(0);
  });

  it('passes when the location passes and the judge reaches the threshold', async () => {
    const judge = vi.fn(async () => 'The answer is close. <score>0.8</score>');
    const result = await gradeRecall(truth(), located, judge);
    expect(judge).toHaveBeenCalledTimes(1);
    expect(result.passed).toBe(true);
    expect(result.score).toBeCloseTo(0.8);
  });

  it('fails when the judge scores below the threshold', async () => {
    const judge = vi.fn(async () => '<score>0.4</score>');
    const result = await gradeRecall(truth(), located, judge);
    expect(result.passed).toBe(false);
  });

  it('asks the judge to compare the outcome with the redacted assistant message', async () => {
    const judge = vi.fn(async () => '<score>0.9</score>');
    await gradeRecall(truth(), located, judge);
    const prompt = judge.mock.calls[0][0] as unknown as string;
    expect(prompt).toContain('chose sqlite');
    expect(prompt).toContain('We chose sqlite for the cache');
    expect(prompt.toLowerCase()).toContain('<score>');
  });
});
