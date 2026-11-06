/**
 * The injection screen for learned text.
 *
 * Learned text is written by a model that read untrusted archive content, and
 * it is injected into every future session, exported to disk, and fed to every
 * later learner. This module is the barrier: it normalises the text first
 * (NFKC, control/zero-width/bidi characters removed) so a disguised payload
 * cannot slip past, then rejects a named list of shapes. The reason is the
 * name of the pattern that matched, so `learn report` can say why.
 *
 * It is a barrier, not a proof. Approval and grounding stand behind it.
 *
 * Imports nothing but the secret redactor, so the digest hook may use it.
 */
import { redactSecrets } from '../redact.js';
/** Strip the characters an attacker uses to split a payload past a regex. */
const INVISIBLE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u00AD\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]/g;
/** NFKC, then drop control, zero-width and bidi-override characters. */
export function normalizeForScreen(text) {
    return text.normalize('NFKC').replace(INVISIBLE, '');
}
const OVERRIDE = [
    {
        name: 'override',
        test: text => /\b(?:ignore|disregard|override)\b[^\n]{0,80}\b(?:instructions?|prompts?|system)\b/i.test(text) ||
            /\byou are now\b/i.test(text) ||
            /\bnew instructions?\b/i.test(text) ||
            /\b(?:replace|overwrite)\s+(?:the\s+)?system prompt\b/i.test(text),
    },
];
const AUTHORITY = [
    { name: 'authority', test: text => (/\bstanding rule\b/i.test(text)) },
    {
        name: 'authority',
        test: text => /\balways\s+(?:do|run|call)\b[^\n]{0,60}\bbefore\b/i.test(text),
    },
    { name: 'authority', test: text => /\bthe user\s+(?:wants|requires|insists)\b/i.test(text) },
];
/** `mcp__episodic-*` is this plugin; every other `mcp__` name is a lever. */
const MCP_NAME = [
    {
        name: 'mcp-name',
        test: text => {
            for (const match of text.matchAll(/\bmcp__[A-Za-z0-9_-]+/g)) {
                if (!match[0].startsWith('mcp__episodic-'))
                    return true;
            }
            return false;
        },
    },
];
/** The exact phrases the plugin itself prints are allowed; other invocations are not. */
const SHELL = [
    {
        name: 'shell',
        test: text => {
            let stripped = text;
            for (const allowed of [
                'episodic-memory skills tool',
                'skills tool',
                'digest tool',
                'search tool',
                'read tool',
            ]) {
                stripped = stripped.split(allowed).join(' ');
            }
            if (/```/.test(stripped))
                return true;
            if (/\bBash\(|\bWrite\(|\bEdit\(/.test(stripped))
                return true;
            if (/\brm\s+-rf\b/i.test(stripped))
                return true;
            return /\b(?:run|execute|curl|wget|bash|powershell)\b/i.test(stripped);
        },
    },
];
const FILE_WRITE = [
    {
        name: 'file-write',
        test: text => /\b(?:write|save|create)\s+(?:to|into)\b/i.test(text) ||
            /\bcreate\s+file\b/i.test(text) ||
            /\b(?:write|save|append|overwrite|delete|remove|move|copy|chmod|touch)\b[^\n]{0,40}(?:^|\s)(?:\/|~\/|[A-Za-z]:\\)/i.test(text) ||
            /(?:^|\s)(?:\/|~\/|[A-Za-z]:\\)[^\n]{0,40}\b(?:write|save|append|overwrite|delete|remove|chmod)\b/i.test(text),
    },
];
const URL_RULE = [
    {
        name: 'url',
        test: text => /https?:\/\//i.test(text) ||
            /\bwww\./i.test(text) ||
            /\bhxxp/i.test(text) ||
            /\b\w+\s+dot\s+(?:com|net|org|io|dev|ai)\b/i.test(text),
    },
];
const EMAIL = [
    { name: 'email', test: text => /\b[\w.+-]+@[\w-]+\.[\w.-]+\b/.test(text) },
];
const BASE64 = [
    { name: 'base64', test: text => /[A-Za-z0-9+/]{40,}={0,2}/.test(text) },
];
const CREDENTIALS = [
    {
        name: 'credentials',
        test: text => /\b(?:token|password|passphrase|passcode|api[-\s]?key|secret)\b[^\n]{0,40}\b(?:ask|provide|paste|send|share|reveal|give)\b/i.test(text) ||
            /\b(?:ask|provide|paste|send|share|reveal|give)\b[^\n]{0,40}\b(?:token|password|passphrase|passcode|api[-\s]?key|secret)\b/i.test(text),
    },
];
const SECRET = [{ name: 'secret', test: text => redactSecrets(text) !== text }];
/** Order matters: an authority phrase such as "always run X before Y" is authority, not shell. */
const RULES = [
    ...OVERRIDE,
    ...AUTHORITY,
    ...MCP_NAME,
    ...SHELL,
    ...FILE_WRITE,
    ...URL_RULE,
    ...EMAIL,
    ...BASE64,
    ...CREDENTIALS,
    ...SECRET,
];
/** The trailing citation marks an instruction line ends with. */
const TRAILING_MARKS = /\s*\[((?:#[0-9a-f]{32}|@\d+)(?:\s*,\s*(?:#[0-9a-f]{32}|@\d+))*)\]\s*$/;
/**
 * The template grammar an instruction line must match (spec §7 rule 6).
 * Instructions are always loaded, so free prose is not allowed in them.
 */
const INSTRUCTION_TEMPLATES = [
    /^project\s+[\w*.-]+:\s+\S/,
    /^mode\s+(?:vector|text|both)\s+for\s+\S/i,
    /^terms\s+for\s+[^:]+:\s+\S/i,
    /^period\s+\d{4}-\d{2}\.\.\d{4}-\d{2}:\s+\S/,
    /^absent:\s+\S/i,
];
/**
 * Screen one field of a learned entry. `text` is normalised here, so callers
 * pass the raw value.
 */
export function screenLearnedText(text, opts = {}) {
    const normalized = normalizeForScreen(text ?? '');
    for (const rule of RULES) {
        if (rule.test(normalized))
            return { ok: false, reason: rule.name };
    }
    if (opts.kind === 'instruction' && opts.field === 'body') {
        for (const rawLine of normalized.split(/\r?\n/)) {
            const line = rawLine.trim();
            if (!line)
                continue;
            const withoutMarks = line.replace(TRAILING_MARKS, '').trim();
            if (!INSTRUCTION_TEMPLATES.some(template => template.test(withoutMarks))) {
                return { ok: false, reason: 'template' };
            }
        }
    }
    return { ok: true };
}
