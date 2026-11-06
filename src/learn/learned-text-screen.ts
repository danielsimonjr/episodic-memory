/**
 * The injection screen for learned text.
 *
 * A model that has just read untrusted archive content writes the learned text.
 * The plugin then injects this text into every future session, exports it to disk, and
 * gives it to later learners. Every field of every kind therefore passes this
 * screen before storage and again on the way out.
 *
 * The screen is a barrier, not a proof: approval mode and the grounding check
 * stand behind it. Its reason strings are the names of the patterns below, so a
 * `learn report` line can say which rule fired.
 *
 * Imports only `../redact.js`, keeping the digest hook's fast path intact.
 */

import { redactSecrets } from '../redact.js';

/**
 * The module declares `ScreenKind` locally rather than importing it from `./types.js`.
 * The module is on the digest hook's fast path and must import nothing but
 * `../redact.js`. A type import would still be a compile-time edge to the shared
 * type module.
 */
export type ScreenKind = 'instruction' | 'skill' | 'reflection';

/**
 * Options for screenLearnedText. The template check runs only when `kind` is `instruction` and `field` is `body`.
 */
export interface ScreenOptions {
  /** The kind of the learned text. */
  kind?: ScreenKind;
  /** The name of the field that the text fills. */
  field?: string;
}

/**
 * The outcome of a screen. `ok` is true when the text passes. Otherwise `reason` names the rule that rejected the text.
 */
export type ScreenResult = { ok: true } | { ok: false; reason: string };

const ZERO_WIDTH = /[\u200b-\u200f\u2060\ufeff\u180e]/g;
const BIDI_OVERRIDES = /[\u202a-\u202e\u2066-\u2069\u061c]/g;
// Newlines and tabs are structure, not disguise: the instruction template is
// checked line by line.
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g;

/**
 * Normalise text before any pattern runs. NFKC folds fullwidth and other
 * compatibility forms into ASCII. The function then removes the invisible characters
 * that an attacker uses to split a keyword.
 */
export function normalizeForScreen(text: string): string {
  if (!text) return text;
  return text
    .normalize('NFKC')
    .replace(ZERO_WIDTH, '')
    .replace(BIDI_OVERRIDES, '')
    .replace(/\r\n?/g, '\n')
    .replace(CONTROL, '');
}

/** A mark group at the end of a line, in either citation form. */
const TRAILING_MARKS = /\[(?:#|@)[^\]]*\]\s*$/;

/** A multi-word phrase, tolerant of the separators a slug or a disguise uses. */
function words(...parts: string[]): RegExp {
  return new RegExp(`\\b${parts.join('[\\s_-]+')}\\b`, 'i');
}

interface Rule {
  name: string;
  re: RegExp;
}

/**
 * Ordered: the first rule that a line trips gives the line its reason. Authority
 * framing comes before the shell words, because "always run X before" is the
 * shape worth naming. The foreign `mcp__` rule is last, so the screen never mistakes a plugin name
 * for one.
 */
const RULES: Rule[] = [
  {
    name: 'override-instructions',
    re: /\b(?:ignore|disregard|forget|override|replace)\b[^.]{0,40}?\b(?:instructions?|directions?|rules?)\b/i,
  },
  { name: 'new-instructions', re: /\bnew\s+(?:instructions?|rules?|system\s+prompt)\b/i },
  { name: 'system-prompt', re: words('system', 'prompt') },
  { name: 'you-are-now', re: words('you', 'are', 'now') },
  {
    name: 'authority-framing',
    re: /\b(?:standing|permanent|binding)[\s_-]+(?:rule|instruction|order)\b|\balways\s+(?:do|run|call|use|execute|check)\b[^.]{0,40}\bbefore\b|\bfrom\s+now\s+on\b/i,
  },
  {
    name: 'user-authority',
    re: /\bthe\s+user\s+(?:wants|requires|insists|demands|expects)\b/i,
  },
  { name: 'shell-command', re: /\brun\b|\bexecutes?\b|\bexec\b/i },
  { name: 'shell-command', re: /\bcurl\b|\bwget\b|\bbash\b|\bsh\s+-c\b|powershell|\bcmd\.exe\b/i },
  { name: 'shell-command', re: /\brm\s+-rf\b|\bBash\(|\bWrite\(|\bEdit\(|`/ },
  {
    name: 'file-write',
    re: /\b(?:write|writes|save|saves|create|creates|append|overwrite)\s+(?:to|into|it|a\s+file|the\s+file)\b/i,
  },
  { name: 'file-write', re: /\bcreate\s+file\b/i },
  {
    name: 'file-write',
    re: /(?:\/[A-Za-z0-9_.-]+){2,}[^.]{0,60}?\b(?:write|save|create|append|overwrite|delete|remove)\b/i,
  },
  {
    name: 'url',
    re: /https?:\/\/|\bwww\.|\bhxxps?|\b\w+\s+dot\s+(?:com|net|org|io|dev|ai|co)\b/i,
  },
  { name: 'email', re: /[\w.+-]+@[\w-]+\.[A-Za-z]{2,}/ },
  { name: 'base64-blob', re: /[A-Za-z0-9+/]{40,}={0,2}/ },
  {
    name: 'credential-request',
    re: /\b(?:ask|asks|request|requests|send|sends|paste|pastes|provide|provides|enter|type)\b[^.]{0,40}?\b(?:token|password|passphrase|api[- ]?key|credentials?|secret)\b/i,
  },
  {
    name: 'credential-request',
    re: /\b(?:token|password|passphrase|api[- ]?key|credentials?)\b[^.]{0,40}?\b(?:ask|send|paste|provide|enter)\b/i,
  },
  {
    // "call the github tool", "invoke the notebook tool", "use the foo tool".
    // The screen removes allowlisted phrases first, so "use the search tool" stays.
    name: 'tool-invocation',
    re: /\b(?:call|calls|invoke|invokes|use|uses)\s+the\s+(?:\S+\s+){1,4}?tool\b/i,
  },
  // A space (or other gap) after `mcp__` is still a foreign tool name:
  // `mcp__ github__create_issue` must not slip past the tight form below.
  { name: 'foreign-mcp-name', re: /\bmcp__\s+\S+/i },
  { name: 'foreign-mcp-name', re: /\bmcp__(?!episodic-)[a-z0-9_-]+/i },
];

/**
 * The exact phrases the plugin itself prints. The screen removes these phrases before
 * the rule set runs, so the screen never reads the plugin's own vocabulary as a tool
 * invocation. The screen rejects everything else that looks like one.
 */
const ALLOWLISTED_TOOL_PHRASES = [
  'episodic-memory skills tool',
  'skills tool',
  'digest tool',
  'search tool',
  'read tool',
];

function stripAllowlisted(text: string): string {
  let out = text;
  for (const phrase of ALLOWLISTED_TOOL_PHRASES) {
    const literal = phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    out = out.replace(new RegExp(literal, 'gi'), ' ');
  }
  return out;
}

const INSTRUCTION_TEMPLATES = [
  /^project\s+[A-Za-z0-9._-]+:\s*\S/,
  /^mode\s+(?:vector|text|both)\s+for\s+\S/,
  /^terms\s+for\s+.+:\s*\S/,
  /^period\s+\d{4}-\d{2}\.\.\d{4}-\d{2}:\s*\S/,
  /^absent:\s*\S/,
];

function matchesTemplate(line: string): boolean {
  if (!TRAILING_MARKS.test(line)) return false;
  const body = line.replace(TRAILING_MARKS, '').trimEnd();
  return INSTRUCTION_TEMPLATES.some(re => re.test(body));
}

function screenLine(line: string): ScreenResult {
  const ruled = stripAllowlisted(line);
  for (const rule of RULES) {
    if (rule.re.test(ruled)) return { ok: false, reason: rule.name };
  }
  // The redaction patterns are the last barrier: text they would change is text
  // that carries something the plugin must never store or emit.
  if (redactSecrets(line) !== line) return { ok: false, reason: 'secret-like-text' };
  return { ok: true };
}

/**
 * Screen one field of learned text.
 *
 * Every field passes the same pattern set, case-insensitively, on the
 * normalised text. With `kind: 'instruction'` and `field: 'body'`, each line must
 * also match one of the template forms. The template forms stop an instruction from
 * smuggling free prose into the always-loaded block.
 */
export function screenLearnedText(text: string, opts: ScreenOptions = {}): ScreenResult {
  const normalized = normalizeForScreen(text);
  if (!normalized.trim()) return { ok: true };

  const whole = screenLine(normalized);
  if (!whole.ok) return whole;

  if (opts.kind === 'instruction' && opts.field === 'body') {
    for (const line of normalized.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      if (!matchesTemplate(trimmed)) return { ok: false, reason: 'instruction-template' };
    }
  }

  return { ok: true };
}
