/**
 * Grading a solver's answer against a task's truth (spec §4.4).
 *
 * The archive supplies the grade: a task is built from a held-out exchange with
 * a known address, so "did the solver find it" needs no rubric. Only `recall`
 * needs a model, and its score is reported, never used to keep or drop an edit.
 *
 * Everything here is pure except `gradeRecall`, which takes the judge as an
 * argument so a test can pass a fake and the caller decides which model runs.
 */
import type { TaskTruth } from './types.js';
/** One address a solver claims. */
export interface AnswerLocation {
    path: string;
    lineStart?: number;
    lineEnd?: number;
}
/** What `parseSolverAnswer` extracted from the model's answer text. */
export interface ParsedAnswer {
    path?: string;
    lineStart?: number;
    lineEnd?: number;
    project?: string;
    date?: string;
    outcome?: string;
    locations: AnswerLocation[];
}
/**
 * The verdict and the score of one graded answer.
 *
 * `passed` is the verdict. `score` lies from 0 to 1.
 */
export interface Grade {
    passed: boolean;
    score: number;
}
/**
 * Read the answer's address lines.
 *
 * The function is tolerant on purpose. The solver is a model.
 * A fenced markdown block with bold labels and Windows backslash paths is a normal shape.
 * A label line supplies a value for the location most recently opened by a `path:` line.
 * So both `path:` then `lines:` and `- path: x` / `- lines: 1-5` pairs work.
 */
export declare function parseSolverAnswer(text: string): ParsedAnswer;
/**
 * True when two paths name the same file, tolerating separators and Windows case.
 *
 * A solver answers with whatever shape it read: `C:\x\y.jsonl`, `c:/x/y.jsonl`,
 * or a POSIX path. `path.resolve` on its own is not enough, because a Windows path is not
 * absolute on Linux. A task's truth may have been generated on one platform and graded on the
 * other. So a drive-letter path is normalised lexically (separators, repeats, case) and never
 * resolved against the cwd.
 */
export declare function samePath(a: string, b: string): boolean;
/**
 * The `locate` grade.
 *
 * The grade is 1.0 when the path matches and the ranges overlap.
 * The grade is 0.5 when the path matches but the range does not.
 * The grade is also 0.5 when the answer names the right session by another path.
 * A session can be archived under a different relative name after a move.
 * In all other cases, the grade is 0.
 */
export declare function gradeLocate(truth: TaskTruth, answer: ParsedAnswer): Grade;
/**
 * The `when` grade: the project must match.
 * The answered UTC date must fall inside the session's date range, widened by one day on each side.
 * The widening absorbs a session that spans midnight and an answer given in local time.
 */
export declare function gradeWhen(truth: TaskTruth, answer: ParsedAnswer): Grade;
/** The `multi` grade: every truth address must be located. */
export declare function gradeMulti(truth: TaskTruth, answer: ParsedAnswer): Grade;
/** Read `<score>0.8</score>`, or a bare number, out of the judge's reply. */
export declare function parseJudgeScore(raw: string): number | null;
/**
 * The `recall` grade: the location first, then the judge.
 *
 * Location is a precondition. Once a solver has found the range, the solver can read that range.
 * So a high judge score on an unlocated answer would measure transcription.
 * Reported per run; never used to keep or drop an edit.
 */
export declare function gradeRecall(truth: TaskTruth, answer: ParsedAnswer, judge: (prompt: string) => Promise<string>, threshold?: number): Promise<Grade>;
