/**
 * The coverage gate. It fails when the source or the --help output has an item that the registry
 * (`cases.ts`) does not list, and when the registry lists an item that no scan finds.
 *
 * Flags: every `--flag` / `-x` of each command's --help, and every quoted flag literal of the CLI
 * source. Env vars: five source forms, self-checked. MCP tools: the names of a real tools/list.
 */
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ENV_VARS, FLAGS, GUARD_ONLY_ENV, HARNESS_ONLY_ENV, MCP_TOOLS, UNCOVERED } from './cases.js';
import { McpClient, REPO_ROOT, assertRepoPreconditions, cliBin, makeSandbox, removeSandbox, runCli, type Sandbox } from './harness.js';
import { useIsolation } from './isolation.js';

useIsolation();

/**
 * The commands whose --help text the gate scans: every `case '<word>':` of the umbrella switch.
 * Derived, so a new command cannot escape the gate. The umbrella help names subcommands only.
 */
const HELP_COMMANDS = [...readFileSync(path.join(REPO_ROOT, 'cli', 'episodic-memory.js'), 'utf-8')
  .matchAll(/^\s*case '([a-z][a-z-]*)':/gm)].map((m) => m[1]);

const SRC_DIR = path.join(REPO_ROOT, 'src');
const CLI_DIR_SRC = path.join(REPO_ROOT, 'cli');
const SCRIPTS_DIR = path.join(REPO_ROOT, 'scripts');

let sb: Sandbox;
const helpText: Record<string, string> = {};

beforeAll(async () => {
  assertRepoPreconditions();
  sb = makeSandbox();
  for (const cmd of HELP_COMMANDS) {
    const result = await runCli(sb, cliBin('episodic-memory.js'), [cmd, '--help']);
    if (result.code !== 0) throw new Error(`${cmd} --help exited ${result.code}: ${result.stderr}`);
    helpText[cmd] = result.stdout;
  }
});

afterAll(() => {
  if (sb) removeSandbox(sb);
});

/** The files under `dir` whose path (relative, with `/`) passes `keep`. Recursive. */
function listFiles(dir: string, keep: (rel: string) => boolean): string[] {
  const out: string[] = [];
  const walk = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (keep(path.relative(dir, full).split(path.sep).join('/'))) out.push(full);
    }
  };
  walk(dir);
  return out;
}

/** The files of the CLI source that carry flags: src/*-cli.ts, src/learn/cli-main.ts, cli/*.js. */
function flagSourceFiles(): string[] {
  const srcCli = listFiles(SRC_DIR, (rel) => !rel.includes('/') && /-cli\.ts$/.test(rel));
  const learnMain = path.join(SRC_DIR, 'learn', 'cli-main.ts');
  const cliJs = listFiles(CLI_DIR_SRC, (rel) => !rel.includes('/') && rel.endsWith('.js'));
  return [...srcCli, learnMain, ...cliJs];
}

/** Flags and subcommand words that one help text names. The lookbehind skips hyphens inside words. */
export function helpFlags(text: string): string[] {
  const out = new Set<string>();
  for (const match of text.matchAll(/(?<![\w-])(--[a-z][a-z0-9-]*|-[a-zA-Z])(?![\w-])/g)) out.add(match[1]);
  return [...out];
}

/**
 * Each quoted flag literal of the CLI source, with the file it came from. The scan covers every
 * src .ts file and every cli .js file. A literal is a quoted `--name`, `--name=value` or `-x`.
 * A literal that is not a flag of this CLI is listed in NON_CLI_LITERALS with its reason.
 */
export function literalFlags(): Map<string, string> {
  const found = new Map<string, string>();
  for (const file of envSourceFiles()) {
    const text = readFileSync(file, 'utf-8');
    for (const match of text.matchAll(/(['"`])(--[a-z][a-z0-9-]*|-[a-zA-Z])(?:=[^'"`\n]*)?\1/g)) {
      const rel = path.relative(REPO_ROOT, file).split(path.sep).join('/');
      // A flag named in a comment is prose; only code literals count.
      const lineStart = text.lastIndexOf('\n', (match.index ?? 0) - 1) + 1;
      if (/^\s*(\/\/|\/\*|\*)/.test(text.slice(lineStart, match.index ?? 0))) continue;
      if (NON_CLI_LITERALS.some((e) => e.file === rel && e.literal === match[2])) continue;
      if (!found.has(match[2])) found.set(match[2], rel);
    }
  }
  return found;
}

/** Flag-shaped literals of the source that are not flags of this CLI. Each one names its file and reason. */
const NON_CLI_LITERALS: readonly { file: string; literal: string; reason: string }[] = [
  { file: 'cli/ensure-deps.js', literal: '--omit', reason: 'an npm argument (--omit=dev), not a flag of this CLI' },
];

/** Escape a string for use inside a RegExp. */
function escapeRe(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * True when `flag` is named by the help text of `cmd`: a `--flag` by exact match, a word by a token
 * test. A hyphen on either side makes a longer token, so `verify` does not match inside `--verify`.
 */
function helpNames(cmd: string, flag: string): boolean {
  if (flag.startsWith('-')) return helpFlags(helpText[cmd]).includes(flag);
  return new RegExp(`(?<![\\w-])${escapeRe(flag)}(?![\\w-])`).test(helpText[cmd]);
}

/** True when the registry lists `flag` for `cmd`, or lists it uncovered under `<cmd> <flag>`. */
function registeredForCommand(cmd: string, flag: string): boolean {
  return FLAGS.some((f) => f.command === cmd && f.flag === flag)
    || UNCOVERED.some((u) => u.kind === 'flag' && u.name === `${cmd} ${flag}`);
}

/** True when the registry lists a bare source literal, as a flag or as an uncovered name. */
function registeredBare(flag: string): boolean {
  return FLAGS.some((f) => f.flag === flag)
    || UNCOVERED.some((u) => u.kind === 'flag' && (u.name === flag || u.name.endsWith(` ${flag}`)));
}

describe('coverage gate: flags', () => {
  it('registers every flag of every --help text and every flag literal of the source', () => {
    const problems: string[] = [];
    for (const cmd of HELP_COMMANDS) {
      for (const flag of helpFlags(helpText[cmd])) {
        if (!registeredForCommand(cmd, flag)) problems.push(`${cmd} ${flag} is in --help but not registered`);
      }
    }
    for (const [literal, file] of literalFlags()) {
      if (!registeredBare(literal)) problems.push(`${literal} (literal in ${file}) is not registered`);
    }
    expect(problems).toEqual([]);
  });

  it('finds every registered flag in its scanner (no dead entries)', async () => {
    const literals = literalFlags();
    const problems: string[] = [];
    for (const entry of FLAGS) {
      if (!HELP_COMMANDS.includes(entry.command as (typeof HELP_COMMANDS)[number])) {
        problems.push(`FLAGS names an unknown command: ${entry.command}`);
      } else if (entry.flag === '--help' || entry.flag === '-h') {
        // Some help texts do not print their own --help. The command accepts the flag by exit code.
        const probe = await runCli(sb, cliBin('episodic-memory.js'), [entry.command, entry.flag]);
        if (probe.code !== 0 || probe.stdout.trim() === '') problems.push(`FLAGS ${entry.command} ${entry.flag} did not print help (exit ${probe.code})`);
      } else if (!helpNames(entry.command, entry.flag)) {
        problems.push(`FLAGS ${entry.command} ${entry.flag} is not in its --help text`);
      }
    }
    for (const entry of UNCOVERED) {
      if (entry.kind !== 'flag') continue;
      const [first, ...rest] = entry.name.split(' ');
      if (rest.length === 1 && HELP_COMMANDS.includes(first as (typeof HELP_COMMANDS)[number])) {
        if (!helpNames(first, rest[0])) problems.push(`UNCOVERED ${entry.name} is not in its --help text`);
      } else if (!literals.has(entry.name)) {
        problems.push(`UNCOVERED ${entry.name} is not a flag literal of the source`);
      }
    }
    expect(problems).toEqual([]);
  });
});

/**
 * The subcommand words of a command, read from its dispatch table in the source (not from a
 * list in this file). `helpWord` finds the words that the help text names as subcommands.
 */
const SUBCOMMAND_TABLES: readonly { cmd: string; file: string; table: RegExp; helpWord: RegExp; helpList?: RegExp }[] = [
  {
    cmd: 'index', file: 'src/index-cli.ts',
    table: /const COMMANDS = new Set\(\[([^\]]*)\]\)/,
    helpWord: /^ {2}([a-z][a-z-]+) {2,}\S/gm,
    // The help paragraph "The index-cli names also work: a, b ID, c." lists words in a comma list.
    helpList: /names also work: ([\s\S]*?) \(/g,
  },
  {
    cmd: 'learn', file: 'src/learn/cli-main.ts',
    table: /const IMPLEMENTED = new Set\(\[([\s\S]*?)\]\)/,
    helpWord: /^ {2}learn ([a-z][a-z-]*)\b/gm,
  },
];

/** The quoted words of a dispatch table. A missing table throws: the gate cannot guess the words. */
function sourceWords(file: string, table: RegExp): string[] {
  const match = table.exec(readFileSync(path.join(REPO_ROOT, file), 'utf-8'));
  if (!match) throw new Error(`no subcommand table in ${file}: the gate cannot derive its words`);
  return [...match[1].matchAll(/['"]([a-z][a-z0-9-]*)['"]/g)].map((m) => m[1]);
}

describe('coverage gate: subcommand words', () => {
  it('registers every dispatch word, and every help word is a dispatch word', () => {
    const problems: string[] = [];
    for (const { cmd, file, table, helpWord, helpList } of SUBCOMMAND_TABLES) {
      const words = sourceWords(file, table);
      if (words.length === 0) problems.push(`${file}: the subcommand table is empty`);
      const listed = helpList
        ? [...helpText[cmd].matchAll(helpList)].flatMap((m) => m[1].split(',').map((s) => s.trim().split(/\s+/)[0]))
        : [];
      for (const word of listed) {
        if (!words.includes(word)) problems.push(`${cmd} --help lists ${word} among its names, which ${file} does not dispatch`);
      }
      for (const word of words) {
        if (!registeredForCommand(cmd, word)) problems.push(`${cmd} ${word} is dispatched in ${file} but not registered`);
      }
      for (const m of helpText[cmd].matchAll(helpWord)) {
        if (!words.includes(m[1])) problems.push(`${cmd} --help names ${m[1]}, which ${file} does not dispatch`);
      }
      for (const entry of FLAGS) {
        if (entry.command === cmd && /^[a-z]/.test(entry.flag) && !words.includes(entry.flag)) {
          problems.push(`FLAGS ${cmd} ${entry.flag} is not dispatched in ${file} (dead entry)`);
        }
      }
    }
    expect(problems).toEqual([]);
  });
});

/**
 * The code of the case files that can exercise the product: comments and skipped cases removed.
 * Prose, a skipped case and a comment therefore count as no coverage.
 */
export function activeCaseText(files: readonly string[]): string {
  return files.map((file) => stripSkipped(stripComments(readFileSync(file, 'utf-8')))).join('\n');
}

/** The text without line and block comments. A comment marker inside a quoted string is kept. */
export function stripComments(text: string): string {
  return text.replace(/('(?:\\.|[^'\\\n])*'|"(?:\\.|[^"\\\n])*"|`(?:\\.|[^`\\])*`)|\/\*[\s\S]*?\*\/|\/\/[^\n]*/g,
    (match, quoted: string | undefined) => quoted ?? '');
}

/** The index just past the quoted string that opens at `start`, or -1 when it never closes. */
function skipQuoted(text: string, start: number): number {
  const quote = text[start];
  for (let i = start + 1; i < text.length; i++) {
    if (text[i] === '\\') { i++; continue; }
    if (text[i] === quote) return i + 1;
  }
  return -1;
}

/**
 * The index just past the `)` that closes a call whose arguments start at `from` (just past its
 * `(`). Quoted strings are skipped whole. The text length when the call never closes.
 */
function callEnd(text: string, from: number): number {
  let depth = 1;
  let i = from;
  while (i < text.length && depth > 0) {
    const ch = text[i];
    if (ch === "'" || ch === '"' || ch === '`') {
      const next = skipQuoted(text, i);
      if (next < 0) return text.length;
      i = next;
      continue;
    }
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    i++;
  }
  return i;
}

/** The opener of a skipped `it`, `test` or `describe` call, up to and including its `(`. */
const SKIP_OPENER = /\b(?:it|test|describe)\.skip(?:If\([^)]*\))?\(/g;

/** The text without each skipped `it`, `test` or `describe` call, matched by its brackets. */
export function stripSkipped(text: string): string {
  let out = '';
  let from = 0;
  for (const m of text.matchAll(SKIP_OPENER)) {
    if (m.index < from) continue;
    out += text.slice(from, m.index);
    from = callEnd(text, m.index + m[0].length);
  }
  return out + text.slice(from);
}

/** The case files of the suite, without this gate. */
function caseFiles(): string[] {
  return listFiles(path.join(REPO_ROOT, 'test', 'e2e'), (rel) => rel.endsWith('.test.ts') && rel !== 'coverage.test.ts');
}

/** True when `word` appears in `text` as a whole quoted string literal: an argv element, not prose or an identifier. */
export function quotesWord(text: string, word: string): boolean {
  return new RegExp(`['"\`]${escapeRe(word)}['"\`]`).test(text);
}

/** True when a case SETS `name`: a key of an object literal (an `env:` option) or a `process.env` write. */
export function setsEnvKey(text: string, name: string): boolean {
  const key = escapeRe(name);
  return new RegExp(`(?:[{,]\\s*|^\\s*)(?:\\[\\s*)?['"]?${key}['"]?(?:\\s*\\])?\\s*:`, 'm').test(text)
    || new RegExp(`process\\.env(?:\\.${key}\\b|\\[['"]${key}['"]\\])\\s*=(?!=)`).test(text);
}

describe('coverage gate: registry flags are exercised by a case', () => {
  // Registry membership is not coverage: a flag must be an argv literal of an active case.
  it('names every FLAGS entry as a quoted literal in an active case', () => {
    const text = activeCaseText(caseFiles());
    const missing = FLAGS.filter((entry) => !quotesWord(text, entry.flag)).map((entry) => `${entry.command} ${entry.flag}`);
    expect(missing).toEqual([]);
  });
});

describe('coverage gate: registry env vars are exercised by a case', () => {
  // A name in a guard table or a comment is not coverage: an active case must SET the variable.
  it('sets every env registry key in an active case', () => {
    const text = activeCaseText(caseFiles());
    const exempt = new Set<string>([...HARNESS_ONLY_ENV, ...GUARD_ONLY_ENV.map((g) => g.name)]);
    const missing = ENV_VARS.filter((name) => !exempt.has(name) && !setsEnvKey(text, name));
    expect(missing).toEqual([]);
  });

  it('names every guard-only variable in an active case, and lists only registry variables there', () => {
    const text = activeCaseText(caseFiles());
    const problems = GUARD_ONLY_ENV.flatMap((g) => [
      ...(ENV_VARS.includes(g.name) ? [] : [`GUARD_ONLY_ENV ${g.name} is not in ENV_VARS`]),
      ...(new RegExp(`(?<![\\w-])${escapeRe(g.name)}(?![\\w-])`).test(text) ? [] : [`GUARD_ONLY_ENV ${g.name} is named by no active case`]),
      ...(setsEnvKey(text, g.name) ? [`GUARD_ONLY_ENV ${g.name} is set by a case: move it out of the guard list`] : []),
    ]);
    expect(problems).toEqual([]);
  });
});

describe('coverage gate: registry MCP tools are exercised by a case', () => {
  it('calls every MCP tool in an active case', () => {
    const text = activeCaseText(caseFiles());
    const missing = MCP_TOOLS.filter((name) => !new RegExp(`\\.call\\(\\s*['"]${escapeRe(name)}['"]`).test(text));
    expect(missing).toEqual([]);
  });
});

/** One skipped case: its file, its title and its body text. */
interface SkippedCase { file: string; title: string; body: string }

/** Every skipped `it` or `test` of the case files, with the body read by its brackets. */
function skippedCases(): SkippedCase[] {
  const opener = /\b(?:it|test)\.skip(?:If\([^)]*\))?\(\s*'((?:\\.|[^'\\])*)'\s*,/g;
  return caseFiles().flatMap((file) => {
    const text = stripComments(readFileSync(file, 'utf-8'));
    const out: SkippedCase[] = [];
    for (const m of text.matchAll(opener)) {
      const bodyStart = m.index + m[0].length;
      out.push({ file: path.basename(file), title: m[1], body: text.slice(bodyStart, callEnd(text, bodyStart)) });
    }
    return out;
  });
}

describe('coverage gate: skipped cases', () => {
  it('gives every skipped case a pending title and a body that asserts', () => {
    const bad = skippedCases()
      .filter((s) => !/^(D\d+|harness) pending: /.test(s.title) || !/\bexpect\w*\(/.test(s.body))
      .map((s) => `${s.file}: ${s.title}`);
    expect(bad).toEqual([]);
  });

  it('lists every pending defect in UNCOVERED, and no defect row without a skipped case', () => {
    const idOf = (text: string): string | undefined => /^(D\d+) pending/.exec(text)?.[1];
    const inCases = new Set(skippedCases().map((s) => idOf(s.title)).filter((id): id is string => id !== undefined));
    const inRegistry = new Set(UNCOVERED.map((u) => idOf(u.reason)).filter((id): id is string => id !== undefined));
    expect([...inCases].filter((id) => !inRegistry.has(id)).sort()).toEqual([]);
    expect([...inRegistry].filter((id) => !inCases.has(id)).sort()).toEqual([]);
  });
});

/** The env scan reads every .ts file under src and every top-level .js file of cli. Tests and scripts are outside it. */
function envSourceFiles(): string[] {
  return [
    ...listFiles(SRC_DIR, (rel) => rel.endsWith('.ts')),
    ...listFiles(CLI_DIR_SRC, (rel) => rel.endsWith('.js')),
  ];
}

/** The result of one env scan: each name with its first file, and each dynamic read it could not name. */
export interface EnvScan {
  readonly names: Map<string, string>;
  readonly unresolved: string[];
}

/**
 * Find the env variables that the files read, by the five forms of PLAN.md:
 * 1. `process.env.NAME`   2. `env.NAME`   3. `env['NAME']`
 * 4. `env[CONST]` where `const CONST = 'NAME'` anywhere in the scanned files
 * 5. a literal name passed to envPositiveInt / envInt / envNumber, and to raw / count / amount
 *    in learn-config.ts (prefixed with EPISODIC_MEMORY_LEARN_).
 */
export function scanEnvVars(files: readonly string[]): EnvScan {
  const sources = files.map((file) => ({ file: path.relative(REPO_ROOT, file).split(path.sep).join('/'), text: readFileSync(file, 'utf-8') }));
  const constants = new Map<string, string>();
  for (const { text } of sources) {
    for (const m of text.matchAll(/\b(?:const|let|var)\s+([A-Za-z_]\w*)\s*(?::[^=\n]+)?=\s*['"]([A-Z][A-Z0-9_]*)['"]/g)) {
      constants.set(m[1], m[2]);
    }
  }
  const names = new Map<string, string>();
  const unresolved: string[] = [];
  const add = (name: string, file: string): void => {
    if (!names.has(name)) names.set(name, file);
  };
  for (const { file, text } of sources) {
    // Total over the token: every `process.env` must start one of the known read forms. Any other
    // use (optional chaining, an alias such as `const e = process.env`, a template key, a spread)
    // is listed as unresolved, and the test compares that list with NON_READ_FORMS.
    for (const m of text.matchAll(/\bprocess\.env\b/g)) {
      const at = text.slice(m.index ?? 0);
      // A mention in a comment is prose, not a read: a line that starts as a comment, or a `//`
      // before the token on a line with no quote in front of it.
      const lineStart = text.lastIndexOf('\n', (m.index ?? 0) - 1) + 1;
      const before = text.slice(lineStart, m.index ?? 0);
      if (/^\s*(\/\/|\/\*|\*)/.test(before) || (before.includes('//') && !/['"`]/.test(before))) continue;
      if (/^process\.env\.[A-Z][A-Z0-9_]*\b/.test(at)) add(/^process\.env\.([A-Z][A-Z0-9_]*)/.exec(at)![1], file);
      else if (/^process\.env\[\s*['"][A-Z][A-Z0-9_]*['"]\s*\]/.test(at)) add(/['"]([A-Z][A-Z0-9_]*)['"]/.exec(at)![1], file);
      else if (/^process\.env\[\s*[A-Za-z_]\w*\s*\]/.test(at)) continue;   // a parameter read: form 4 names it
      else unresolved.push(`${file}: ${at.split('\n')[0].trim()}`);
    }
    for (const m of text.matchAll(/\benv\.([A-Z][A-Z0-9_]*)\b/g)) add(m[1], file);
    for (const m of text.matchAll(/\benv\[\s*['"]([A-Z][A-Z0-9_]*)['"]\s*\]/g)) add(m[1], file);
    for (const m of text.matchAll(/\benv\[\s*([A-Za-z_]\w*)\s*\]/g)) {
      const value = constants.get(m[1]);
      if (value !== undefined) add(value, file);
      else unresolved.push(`${file}: env[${m[1]}]`);
    }
    for (const m of text.matchAll(/\b(?:envPositiveInt|envInt|envNumber)\(\s*['"]([A-Z][A-Z0-9_]*)['"]/g)) add(m[1], file);
    if (file.endsWith('learn-config.ts')) {
      for (const m of text.matchAll(/\b(?:raw|count|amount)\(\s*['"]([A-Z0-9_]+)['"]/g)) {
        add(`EPISODIC_MEMORY_LEARN_${m[1]}`, file);
      }
    }
  }
  return { names, unresolved };
}

/** The dynamic reads of the helper bodies that form 4 cannot name. Each one is a parameter read. */
const HELPER_PARAM_READS = ['src/constants.ts: env[name]', 'src/digest-compress.ts: env[name]'];

/**
 * Uses of `process.env` that are not a read by name, each reviewed: the whole rest of the line
 * after the token, as the scan reports it. A new use of the token fails the gate until it is listed.
 */
const NON_READ_FORMS: readonly string[] = [
  // The whole environment is passed on, not read by name. The child or the callee reads its keys.
  'cli/ensure-deps.js: process.env, rm = rmSync, spawn } = options;',  // default env of the npm runner
  'cli/sync-hook.js: process.env,',                                   // env of the detached sync spawn
  'src/claude-bin.ts: process.env;',                                  // default env of the probe
  'src/codex-hook-trust.ts: process.env, CODEX_HOME: codexHome },',   // spread into the codex child env
  'src/learn/learn-config.ts: process.env[PREFIX + suffix];',         // raw/count/amount read; form 5 names the suffixes
  'src/priority.ts: process.env): boolean {',                         // default parameter; callers name the key
  'src/priority.ts: process.env,',                                    // default parameter of the reaper seam
  'src/summarizer.ts: process.env,',                                  // spread into the SDK env
  'src/summarizer.ts: process.env',                                   // default parameter of the env-reading helper
  'src/sync-cli.ts: process.env);',                                   // whole env to buildSyncOptionsFromEnv (named reads there)
  'src/sync-cli.ts: process.env, [BACKGROUND_WORKER_ENV]: \'1\' }',   // spread into the detached worker env
];

/** Names that the scanner must find. If it misses one, the scanner itself is broken: the gate fails. */
const SELF_CHECK = ['EPISODIC_MEMORY_SKIP_SUMMARIES', 'EPISODIC_MEMORY_LEARN_MAX_CALLS', 'EPISODIC_MEMORY_TOPICS_MAX_DOCS'];

describe('coverage gate: env vars', () => {
  it('finds the self-check names by the forms it claims to scan', () => {
    const scan = scanEnvVars(envSourceFiles());
    const missing = SELF_CHECK.filter((name) => !scan.names.has(name));
    expect(missing).toEqual([]);
  });

  it('registers every env var that the source reads', () => {
    const scan = scanEnvVars(envSourceFiles());
    const registered = new Set([...ENV_VARS, ...UNCOVERED.filter((u) => u.kind === 'env').map((u) => u.name)]);
    const problems = [...scan.names.keys()]
      .filter((name) => !registered.has(name))
      .map((name) => `${name} (read in ${scan.names.get(name)}) is not registered`);
    expect(problems).toEqual([]);
  });

  it('finds every registered env var in the source (no dead entries)', () => {
    const scan = scanEnvVars(envSourceFiles());
    const wideText = [...envSourceFiles(), ...listFiles(SCRIPTS_DIR, () => true)]
      .map((file) => readFileSync(file, 'utf-8'))
      .join('\n');
    const problems: string[] = [];
    for (const name of ENV_VARS) {
      if (!scan.names.has(name) && !HARNESS_ONLY_ENV.includes(name)) problems.push(`ENV_VARS ${name} is not read by the scan`);
    }
    for (const entry of UNCOVERED) {
      const whole = new RegExp(`(?<![A-Za-z0-9_])${escapeRe(entry.name)}(?![A-Za-z0-9_])`);
      if (entry.kind === 'env' && !scan.names.has(entry.name) && !whole.test(wideText)) {
        problems.push(`UNCOVERED ${entry.name} appears nowhere in src, cli or scripts`);
      }
    }
    expect(problems).toEqual([]);
  });

  it('reports every dynamic env read that the five forms cannot name', () => {
    const scan = scanEnvVars(envSourceFiles());
    // The bodies of the two env helpers read a parameter. Their callers pass literal names, which
    // form 5 scans. Any other dynamic read is a new, unnamed hole and fails here.
    expect([...scan.unresolved].sort()).toEqual([...HELPER_PARAM_READS, ...NON_READ_FORMS].sort());
  });
});

describe("coverage gate: MCP tools", () => {
  it("lists exactly the registered tools in a real tools/list", async () => {
    const client = await McpClient.start(sb);
    let names: string[] = [];
    let closed: number | null = null;
    try {
      names = await client.listTools();
    } finally {
      closed = await client.close();
    }
    expect(closed).toBe(0);
    const expected = [...new Set([...MCP_TOOLS, ...UNCOVERED.filter((u) => u.kind === "tool").map((u) => u.name)])];
    expect([...names].sort()).toEqual([...expected].sort());
  });
});
