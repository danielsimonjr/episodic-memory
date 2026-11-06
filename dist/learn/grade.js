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
import path from 'path';
import { redactSecrets } from '../redact.js';
/**
 * Strip markdown decoration from a value: backticks, bold markers, list bullets
 * and a trailing period. Paths keep their backslashes, which is the whole point
 * of doing this in one place.
 */
function cleanValue(raw) {
    let value = raw.trim();
    value = value.replace(/^[*_`\s]+/, '').replace(/[*_`\s]+$/, '');
    value = value.replace(/^[`"']+/, '').replace(/[`"']+$/, '');
    return value.trim();
}
function labelledValues(text, label) {
    // `file:` is a common synonym for `path:`.
    const names = label === 'path' ? 'path|file' : label;
    const pattern = new RegExp(`^[\\s>*+\\-|]*(?:\\*\\*|__)?(?:${names})(?:\\*\\*|__)?\\s*[:=]\\s*(.*)$`, 'gim');
    const out = [];
    let match;
    while ((match = pattern.exec(text)) !== null)
        out.push(cleanValue(match[1]));
    return out;
}
/** `12`, `12-18`, `12..18`, `12 to 18`, `12–18`. */
function parseRange(value) {
    const numbers = value.match(/\d+/g);
    if (!numbers || numbers.length === 0)
        return {};
    const lineStart = Number(numbers[0]);
    const lineEnd = numbers.length > 1 ? Number(numbers[1]) : lineStart;
    if (!Number.isFinite(lineStart))
        return {};
    return { lineStart, lineEnd: Number.isFinite(lineEnd) ? lineEnd : lineStart };
}
/**
 * Read the answer's address lines.
 *
 * Tolerant on purpose: the solver is a model, and a fenced markdown block with
 * bold labels and Windows backslash paths is a normal shape. A label line
 * supplies a value for the location most recently opened by a `path:` line, so
 * both `path:` then `lines:` and `- path: x` / `- lines: 1-5` pairs work.
 */
export function parseSolverAnswer(text) {
    const answer = { locations: [] };
    if (typeof text !== 'string' || !text.trim())
        return answer;
    const paths = labelledValues(text, 'path');
    const ranges = labelledValues(text, 'lines');
    const projects = labelledValues(text, 'project');
    const dates = labelledValues(text, 'date');
    const outcomes = labelledValues(text, 'outcome');
    for (let i = 0; i < paths.length; i++) {
        const location = { path: paths[i] };
        const range = ranges[i] !== undefined ? parseRange(ranges[i]) : {};
        if (range.lineStart !== undefined) {
            location.lineStart = range.lineStart;
            location.lineEnd = range.lineEnd;
        }
        answer.locations.push(location);
    }
    const first = answer.locations[0];
    if (first) {
        answer.path = first.path;
        if (first.lineStart !== undefined) {
            answer.lineStart = first.lineStart;
            answer.lineEnd = first.lineEnd;
        }
    }
    if (projects[0])
        answer.project = projects[0];
    if (dates[0]) {
        const iso = dates[0].match(/\d{4}-\d{2}-\d{2}/);
        answer.date = iso ? iso[0] : dates[0];
    }
    if (outcomes[0])
        answer.outcome = outcomes[0];
    return answer;
}
/** A Windows path, wherever this code runs: `C:\x` or `c:/x`. */
function isWindowsShaped(candidate) {
    return /^[A-Za-z]:[\\/]/.test(candidate) || /^\\\\/.test(candidate);
}
/** Fold separators, collapse repeats and (on Windows) case, without touching the disk. */
function normalizeWindowsPath(candidate) {
    return candidate
        .replace(/\\/g, '/')
        .replace(/\/{2,}/g, '/')
        .replace(/\/+$/, '')
        .toLowerCase();
}
/**
 * True when two paths name the same file, tolerating separators and Windows case.
 *
 * A solver answers with whatever shape it read: `C:\x\y.jsonl`, `c:/x/y.jsonl`,
 * or a POSIX path. `path.resolve` on its own is not enough, because a Windows
 * path is not absolute on Linux — and a task's truth may have been generated on
 * one platform and graded on the other. So a drive-letter path is normalised
 * lexically (separators, repeats, case) and never resolved against the cwd.
 */
export function samePath(a, b) {
    if (!a || !b)
        return false;
    if (isWindowsShaped(a) || isWindowsShaped(b)) {
        return normalizeWindowsPath(a) === normalizeWindowsPath(b);
    }
    const left = path.resolve(a);
    const right = path.resolve(b);
    if (left === right)
        return true;
    return process.platform === 'win32' && left.toLowerCase() === right.toLowerCase();
}
/** The session a path belongs to: its basename without the `.jsonl` extension. */
function sessionOf(filePath) {
    return path.basename(filePath).replace(/\.jsonl$/i, '');
}
function refsOf(truth) {
    return Array.isArray(truth?.exchanges) ? truth.exchanges : [];
}
/** True when an answer location matches one truth address (path, and range if known). */
function locates(ref, location) {
    if (!samePath(ref.path, location.path))
        return false;
    if (location.lineStart === undefined)
        return true;
    const start = location.lineStart;
    const end = location.lineEnd ?? location.lineStart;
    return Math.max(ref.lineStart, start) <= Math.min(ref.lineEnd, end);
}
/**
 * The `locate` grade.
 *
 * 1.0 when the path matches and the ranges overlap; 0.5 when the path matches
 * but the range does not, or when the answer names the right session by another
 * path (a session can be archived under a different relative name after a move);
 * 0 otherwise.
 */
export function gradeLocate(truth, answer) {
    const refs = refsOf(truth);
    const locations = answer.locations.length > 0 ? answer.locations : [];
    if (refs.length === 0 || locations.length === 0)
        return { passed: false, score: 0 };
    let best = 0;
    for (const ref of refs) {
        for (const location of locations) {
            if (!samePath(ref.path, location.path)) {
                if (ref.sessionId && sessionOf(location.path) === ref.sessionId) {
                    best = Math.max(best, 0.5);
                }
                continue;
            }
            best = Math.max(best, locates(ref, location) && location.lineStart !== undefined ? 1 : 0.5);
            // A matching path with no range at all still earns the session credit.
            if (location.lineStart === undefined)
                best = Math.max(best, 0.5);
        }
    }
    return { passed: best === 1, score: best };
}
function utcDateOf(raw) {
    const match = raw.match(/^\d{4}-\d{2}-\d{2}$/);
    if (!match)
        return null;
    const parsed = new Date(`${raw}T00:00:00.000Z`);
    return Number.isNaN(parsed.getTime()) ? null : raw;
}
function shiftDate(date, days) {
    const parsed = new Date(`${date}T00:00:00.000Z`);
    parsed.setUTCDate(parsed.getUTCDate() + days);
    return parsed.toISOString().slice(0, 10);
}
/**
 * The `when` grade: the project must match, and the answered UTC date must land
 * inside the session's date range widened by one day on each side. The widening
 * absorbs a session that spans midnight and an answer given in local time.
 */
export function gradeWhen(truth, answer) {
    const range = truth?.sessionDateRange;
    if (!answer.date || !Array.isArray(range) || range.length !== 2) {
        return { passed: false, score: 0 };
    }
    const date = utcDateOf(answer.date);
    const from = utcDateOf(range[0]);
    const to = utcDateOf(range[1]);
    if (!date || !from || !to)
        return { passed: false, score: 0 };
    if (answer.project !== undefined && answer.project !== truth.project) {
        // A project answer that is present and wrong fails; an absent one is not a
        // contradiction (the prompt asks for it, but a missing line is a locate fail).
        return { passed: false, score: 0 };
    }
    if (answer.project === undefined)
        return { passed: false, score: 0 };
    const lower = shiftDate(from, -1);
    const upper = shiftDate(to, 1);
    const passed = date >= lower && date <= upper;
    return { passed, score: passed ? 1 : 0 };
}
/** The `multi` grade: every truth address must be located. */
export function gradeMulti(truth, answer) {
    const refs = refsOf(truth);
    if (refs.length === 0)
        return { passed: false, score: 0 };
    let found = 0;
    for (const ref of refs) {
        const hit = answer.locations.some(location => locates(ref, location));
        if (hit)
            found += 1;
    }
    const score = found / refs.length;
    return { passed: found === refs.length, score };
}
function judgePrompt(truth, answer) {
    return [
        'You grade a retrieval answer against the conversation it should have found.',
        '',
        'The solver located a range in the archive and stated an outcome. Score how well the stated',
        'outcome matches what the assistant actually concluded.',
        '',
        'Actual conclusion:',
        redactSecrets(truth.assistantMessage),
        '',
        'Stated outcome:',
        redactSecrets(answer.outcome ?? '(none given)'),
        '',
        'Answer one number from 0 to 1 inside <score></score> tags and nothing else on that line.',
        '1 means the stated outcome matches the conclusion; 0 means it does not.',
    ].join('\n');
}
/** Read `<score>0.8</score>`, or a bare number, out of the judge's reply. */
export function parseJudgeScore(raw) {
    if (typeof raw !== 'string')
        return null;
    const tagged = raw.match(/<score>\s*([0-9]*\.?[0-9]+)\s*<\/score>/i);
    const candidate = tagged ? tagged[1] : (raw.match(/\b([01](?:\.\d+)?)\b/) || [])[1];
    if (!candidate)
        return null;
    const value = Number(candidate);
    if (!Number.isFinite(value))
        return null;
    return Math.max(0, Math.min(1, value));
}
/**
 * The `recall` grade: the location first, then the judge.
 *
 * Location is a precondition: once a solver has found the range it can read it,
 * so a high judge score on an unlocated answer would measure transcription.
 * Reported per run; never used to keep or drop an edit.
 */
export async function gradeRecall(truth, answer, judge, threshold = 0.7) {
    const location = gradeLocate(truth, answer);
    if (!location.passed)
        return { passed: false, score: 0 };
    const raw = await judge(judgePrompt(truth, answer));
    const score = parseJudgeScore(raw);
    if (score === null)
        return { passed: false, score: 0 };
    return { passed: score >= threshold, score };
}
