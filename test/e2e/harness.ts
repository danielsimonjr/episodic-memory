/**
 * End-to-end harness. It runs the SHIPPED entry points as child processes, in a sandbox.
 *
 * Isolation (see PLAN.md, "Harness"): a child env is BUILT from {}, never inherited. Every path
 * the child may read or write resolves under the sandbox root. A pure string guard refuses any
 * spawn whose env breaks that rule, before the spawn happens. The guard never calls the path
 * helpers of the product, because those create directories.
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync, type Dirent } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { repairPlan } from '../../src/deps-health.js';
import { pruneOptionalWeight } from '../../cli/ensure-deps.js';
import { safeRmSync } from '../test-utils.js';
import { ENV_VARS } from './cases.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** The repository root: test/e2e/ -> repo. */
export const REPO_ROOT = path.resolve(HERE, '..', '..');
export const CLI_DIR = path.join(REPO_ROOT, 'cli');
export const DIST_DIR = path.join(REPO_ROOT, 'dist');
export const FIXTURE_DIR = path.join(REPO_ROOT, 'test', 'fixtures');
/** The proc-lister seam. Absolute, because the hook imports it by file URL. */
export const LISTER_PATH = path.join(HERE, 'fake-proc-lister.mjs');

/** An absolute path to a shipped bin in `cli/`. Extensionless bins work (package.json is ESM). */
export function cliBin(name: string): string {
  return path.join(CLI_DIR, name);
}

/** The directories of one sandbox. Every field is under `root`. */
export interface Sandbox {
  readonly root: string;
  /** EPISODIC_MEMORY_CONFIG_DIR: config, archive, index, learned, logs. */
  readonly cfg: string;
  /** CLAUDE_CONFIG_DIR: the transcript source is `<claude>/projects`. */
  readonly claude: string;
  readonly codex: string;
  readonly home: string;
  readonly xdg: string;
  readonly tmp: string;
  /** The archive that `sync` copies into. `index` reads only this folder. */
  readonly archive: string;
  /** The index folder: `db.sqlite` and `.sync.lock`. */
  readonly index: string;
  /** A GPU reservation file that does not exist: the GPU is free. */
  readonly noReservation: string;
  /** The child PATH: an empty folder, so a bare `codex`, `ps` or `npm` is not found. */
  readonly bin: string;
}

/**
 * Create a sandbox under the OS temp folder. Callers close it with `removeSandbox`.
 * The sandbox holds empty folders only: the product creates the rest when a case runs it.
 */
export function makeSandbox(): Sandbox {
  const root = mkdtempSync(path.join(os.tmpdir(), 'em-e2e-'));
  const cfg = path.join(root, 'cfg');
  const claude = path.join(root, 'claude');
  const sb: Sandbox = {
    root,
    cfg,
    claude,
    codex: path.join(root, 'codex'),
    home: path.join(root, 'home'),
    xdg: path.join(root, 'xdg'),
    tmp: path.join(root, 'tmp'),
    archive: path.join(cfg, 'conversation-archive'),
    index: path.join(cfg, 'conversation-index'),
    noReservation: path.join(root, 'no-reservation.json'),
    bin: path.join(root, 'bin'),
  };
  for (const dir of [sb.cfg, path.join(claude, 'projects'), sb.codex, sb.home, sb.xdg, sb.tmp, sb.bin]) {
    mkdirSync(dir, { recursive: true });
  }
  return sb;
}

/** Remove a sandbox. `safeRmSync` retries the Windows EPERM of a SQLite WAL file. */
export function removeSandbox(sb: Sandbox): void {
  safeRmSync(sb.root);
}

/** Path variables of the child env. Each one must resolve under the sandbox root. */
const PATH_VARS = [
  'EPISODIC_MEMORY_CONFIG_DIR', 'CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'HOME', 'USERPROFILE',
  'XDG_CONFIG_HOME', 'FLEET_GPU_RESERVATION', 'EPISODIC_MEMORY_CODEX_BIN', 'TEMP', 'TMP', 'TMPDIR',
] as const;

/** Path variables that a case may set. When present, each must resolve under the root. */
const OPTIONAL_PATH_VARS = [
  'EPISODIC_MEMORY_DB_PATH', 'E2E_LISTER_PID_FILE', 'PERSONAL_SUPERPOWERS_DIR',
  'TEST_PROJECTS_DIR', 'TEST_ARCHIVE_DIR', 'TEST_DB_PATH',
] as const;

/**
 * Variables that must never reach a child. The product reads each one, and each one reaches a
 * real model, a real Claude binary, the live plugin or the repo's node_modules (see PLAN.md).
 * A case that needs one names it in `allowEnv`, so the choice is visible in the test.
 */
const NEVER_SET = [
  'EPISODIC_MEMORY_OLLAMA_FALLBACK_MODEL', 'EPISODIC_MEMORY_CLAUDE_BIN', 'CLAUDE_PLUGIN_ROOT',
  'PLUGIN_ROOT', 'EPISODIC_MEMORY_API_BASE_URL', 'EPISODIC_MEMORY_API_TOKEN',
] as const;

/** Keys that `buildEnv` sets itself or copies from the OS. Every other key needs the registry or allowEnv. */
const BASE_KEYS: readonly string[] = [
  'SYSTEMROOT', 'COMSPEC', 'PATHEXT', 'PATH', 'TEMP', 'TMP', 'TMPDIR', 'HOME', 'USERPROFILE', 'E2E_LISTER_PID_FILE',
  'E2E_LISTER_NONCE',
];

/** Pure: true when `value` resolves to a path inside `root`. No file system access. */
export function isUnderRoot(root: string, value: string): boolean {
  const rel = path.relative(path.resolve(root), path.resolve(value));
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/**
 * The refusal guard. Pure string checks on the env, run before every spawn. It returns the list
 * of violations. An empty list means the env may be spawned. It never creates a directory.
 */
export function envViolations(
  env: Readonly<Record<string, string | undefined>>,
  root: string,
  allowEnv: readonly string[] = []
): string[] {
  const out: string[] = [];
  for (const name of PATH_VARS) {
    const value = env[name];
    // An empty config dir is allowed on purpose only: the product then falls back to
    // XDG_CONFIG_HOME, which this same loop requires under the sandbox.
    if (name === 'EPISODIC_MEMORY_CONFIG_DIR' && value === '' && allowEnv.includes(name)) continue;
    if (value === undefined || value === '') out.push(`${name} is not set`);
    else if (!isUnderRoot(root, value)) out.push(`${name} is outside the sandbox: ${value}`);
  }
  for (const name of OPTIONAL_PATH_VARS) {
    const value = env[name];
    if (value !== undefined && !isUnderRoot(root, value)) out.push(`${name} is outside the sandbox: ${value}`);
  }
  if (env.EPISODIC_MEMORY_PROC_LISTER !== LISTER_PATH) {
    out.push(`EPISODIC_MEMORY_PROC_LISTER must be ${LISTER_PATH}`);
  }
  const url = env.EPISODIC_MEMORY_OLLAMA_URL ?? '';
  let loopback = false;
  try {
    const parsed = new URL(url);
    loopback = parsed.protocol === 'http:' && parsed.hostname === '127.0.0.1' && parsed.port !== '11434';
  } catch {
    loopback = false;
  }
  if (!loopback) out.push(`EPISODIC_MEMORY_OLLAMA_URL must be loopback http and not port 11434: ${url}`);
  for (const name of NEVER_SET) {
    if (env[name] !== undefined && !allowEnv.includes(name)) out.push(`${name} must not be set`);
  }
  // Default-deny: a key the registry does not name is refused, so a new read cannot leak in unnoticed.
  for (const name of Object.keys(env)) {
    if (env[name] === undefined || BASE_KEYS.includes(name) || allowEnv.includes(name)) continue;
    if (name.startsWith('TEST_')) out.push(`${name} must not be set (TEST_* is refused)`);
    else if (!ENV_VARS.includes(name)) out.push(`${name} is not in the registry (cases.ts ENV_VARS); name it in allowEnv`);
  }
  // Any backend but ollama reaches a real model (claude: Agent SDK; codex: a real binary).
  const backend = env.EPISODIC_MEMORY_SUMMARIZER_BACKEND;
  if (backend !== undefined && backend !== 'ollama' && !allowEnv.includes('EPISODIC_MEMORY_SUMMARIZER_BACKEND')) {
    out.push(`EPISODIC_MEMORY_SUMMARIZER_BACKEND=${backend} needs allowEnv (only ollama is fake)`);
  }
  return out;
}

/** The learn subcommands that run the Agent SDK, which reaches the bundled Claude binary. */
const LEARN_AGENT_WORDS = ['solve', 'improve', 'bootstrap'];

/**
 * Pure: the bin, argv and cwd of one child. A learn agent subcommand needs the `learn-agent`
 * allowance, through the umbrella (`learn` anywhere before the word) or through the learn bin
 * itself. The check reads every argument, so a flag before the subcommand does not hide it. A cwd
 * outside the sandbox would let the product read the machine's files for its default project key.
 */
export function argvViolations(
  bin: string, args: readonly string[], cwd: string | undefined, root: string, allowEnv: readonly string[]
): string[] {
  const out: string[] = [];
  const base = path.basename(bin);
  const learnIndex = base === 'learn-cli.js' ? -1 : args.indexOf('learn');
  const isLearn = base === 'learn-cli.js' || learnIndex >= 0;
  const agentWord = isLearn ? args.slice(learnIndex + 1).find((arg) => LEARN_AGENT_WORDS.includes(arg)) : undefined;
  if (agentWord !== undefined && !allowEnv.includes('learn-agent')) {
    out.push(`learn ${agentWord} runs the Agent SDK; name 'learn-agent' in allowEnv`);
  }
  if (cwd !== undefined && !isUnderRoot(root, cwd)) out.push(`cwd is outside the sandbox: ${cwd}`);
  return out;
}

/**
 * Kill a child and every process it started. `forward-child` starts the real script as a
 * grandchild, and `child.kill()` alone leaves that grandchild holding db.sqlite on Windows.
 * POSIX children are spawned detached, so the negative pid names their process group.
 */
export function killTree(child: ChildProcess): void {
  if (child.pid === undefined) return;
  if (process.platform === 'win32') {
    const kill = spawnSync('taskkill', ['/T', '/F', '/PID', String(child.pid)], { windowsHide: true });
    if (kill.status !== 0) child.kill('SIGKILL');
    return;
  }
  try {
    process.kill(-child.pid, 'SIGKILL');
  } catch {
    child.kill('SIGKILL');
  }
}

/** Throw when `env` breaks a rule. The message names every violation. */
export function assertSpawnable(env: Readonly<Record<string, string | undefined>>, root: string, allowEnv: readonly string[] = []): void {
  const bad = envViolations(env, root, allowEnv);
  if (bad.length > 0) throw new Error(`e2e guard refused a spawn:\n  - ${bad.join('\n  - ')}`);
}

/** Options of a child env. `env` holds the case's extra variables; `undefined` removes one. */
export interface EnvOptions {
  env?: Record<string, string | undefined>;
  allowEnv?: readonly string[];
}

/**
 * Build the child env from {} and apply the sandbox rules. Only PATH (the node directory alone),
 * SYSTEMROOT, COMSPEC and PATHEXT come from the machine, and each of them is a fixed system value.
 */
export function buildEnv(sb: Sandbox, opts: EnvOptions = {}): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = {};
  for (const key of ['SYSTEMROOT', 'COMSPEC', 'PATHEXT'] as const) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  // The node binary is started by its absolute execPath, so PATH only needs to hold nothing.
  env.PATH = sb.bin;
  // os.tmpdir() reads TEMP and TMP on Windows and TMPDIR on POSIX: all three point into the sandbox.
  env.TEMP = sb.tmp;
  env.TMP = sb.tmp;
  env.TMPDIR = sb.tmp;
  env.EPISODIC_MEMORY_CONFIG_DIR = sb.cfg;
  env.CLAUDE_CONFIG_DIR = sb.claude;
  env.CODEX_HOME = sb.codex;
  env.HOME = sb.home;
  env.USERPROFILE = sb.home;
  env.XDG_CONFIG_HOME = sb.xdg;
  env.FLEET_GPU_RESERVATION = sb.noReservation;
  env.EPISODIC_MEMORY_SUMMARIZER_BACKEND = 'ollama';
  env.EPISODIC_MEMORY_OLLAMA_URL = 'http://127.0.0.1:9';
  env.EPISODIC_MEMORY_OLLAMA_MODEL = 'e2e-fake';
  env.EPISODIC_MEMORY_CODEX_BIN = path.join(sb.root, 'no-codex');
  env.EPISODIC_MEMORY_PROC_LISTER = LISTER_PATH;
  for (const [key, value] of Object.entries(opts.env ?? {})) {
    if (value === undefined) delete env[key];
    else env[key] = value;
  }
  assertSpawnable(env, sb.root, opts.allowEnv ?? []);
  return env;
}

/** The newest mtime (ms) of the files under `dir` that pass `keep`. 0 when there are none. */
function newestMtime(dir: string, keep: (rel: string) => boolean): number {
  let newest = 0;
  const walk = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (keep(path.relative(dir, full))) newest = Math.max(newest, statSync(full).mtimeMs);
    }
  };
  walk(dir);
  return newest;
}

let preconditionsChecked = false;

/**
 * The repo preconditions, asserted once per process. Each one names what to run to fix it.
 * - node_modules is healthy: otherwise sync-hook and the MCP wrapper run an install from the network.
 * - Node is at least the `learn` floor, 22.16.0.
 * - dist is not older than src (LOCAL only): CI runs its own dist gate after the tests.
 */
export function assertRepoPreconditions(): void {
  if (preconditionsChecked) return;
  const nodeModules = path.join(REPO_ROOT, 'node_modules');
  const plan = repairPlan(nodeModules);
  if (plan !== 'none') throw new Error(`repo node_modules needs repair (${plan}): run bun install`);

  const [major, minor] = process.versions.node.split('.').map(Number);
  if (major < 22 || (major === 22 && minor < 16)) {
    throw new Error(`Node ${process.versions.node} is below the 22.16.0 floor`);
  }

  if (!process.env.CI) {
    // Per file: each src/<rel>.ts needs dist/<rel>.js, and that file must not be older than its source.
    // A newest-vs-newest check passes when one fresh dist file hides a stale one (measured).
    const stale = staleDistPairs();
    if (stale.length > 0) {
      throw new Error(`dist is older than src or missing (run bun run build before the e2e suite):\n  ${stale.join('\n  ')}`);
    }
  }
  preconditionsChecked = true;
}

/** Each src/**\/*.ts (not version.ts) whose dist/**\/*.js is missing or older. Empty when current. */
export function staleDistPairs(): string[] {
  const srcDir = path.join(REPO_ROOT, 'src');
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      if (!entry.name.endsWith('.ts') || entry.name.endsWith('.d.ts') || full === path.join(srcDir, 'version.ts')) continue;
      const rel = path.relative(srcDir, full).split(path.sep).join('/');
      const built = path.join(DIST_DIR, rel.replace(/\.ts$/, '.js'));
      let distMtime: number;
      try {
        distMtime = statSync(built).mtimeMs;
      } catch {
        out.push(`missing: dist/${rel.replace(/\.ts$/, '.js')}`);
        continue;
      }
      if (statSync(full).mtimeMs > distMtime) out.push(`stale: dist/${rel.replace(/\.ts$/, '.js')} is older than src/${rel}`);
    }
  };
  walk(srcDir);
  return out;
}

/**
 * The listing of the given roots: one sorted line per file (name, size, mtime). A missing root is
 * named. The listing, not only its hash, lets a failure print which file changed.
 */
export function listTree(roots: readonly string[], skip: (base: string) => boolean = () => false): string[] {
  const lines: string[] = [];
  // A live process can delete an entry between the listing and the stat: that entry is skipped,
  // and the walk goes on. Any other error is an UNREADABLE line, so a check never passes on a
  // partial walk without saying so.
  const gone = (err: unknown): boolean => (err as NodeJS.ErrnoException).code === 'ENOENT';
  const walk = (base: string, current: string): void => {
    let entries: Dirent[];
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch (err) {
      if (current === base && gone(err)) lines.push(`MISSING ${base}`);
      else if (!gone(err)) lines.push(`UNREADABLE ${current}: ${(err as NodeJS.ErrnoException).code}`);
      return;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) { walk(base, full); continue; }
      if (skip(entry.name)) continue;
      try {
        const st = statSync(full);
        lines.push(`${path.relative(base, full).split(path.sep).join('/')}\t${st.size}\t${st.mtimeMs}`);
      } catch (err) {
        if (!gone(err)) lines.push(`UNREADABLE ${full}: ${(err as NodeJS.ErrnoException).code}`);
      }
    }
  };
  for (const root of roots) walk(root, root);
  return lines.sort();
}

/** The hash of a listing. Equal listings have equal hashes. */
export function hashTree(roots: readonly string[], skip: (base: string) => boolean = () => false): string {
  return createHash('sha256').update(listTree(roots, skip).join('\n')).digest('hex');
}

/** The lines removed (`- `) and added (`+ `) between two listings. Empty when they are equal. */
export function diffListings(before: readonly string[], after: readonly string[]): string[] {
  const kept = new Set(after);
  const had = new Set(before);
  return [
    ...before.filter((line) => !kept.has(line)).map((line) => `- ${line}`),
    ...after.filter((line) => !had.has(line)).map((line) => `+ ${line}`),
  ];
}

/** The isolation skip rule of PLAN: live-database files and lock files change under a running plugin. */
export function isLiveFile(base: string): boolean {
  return base.endsWith('.log') || base.endsWith('-wal') || base.endsWith('-shm') || /^\..*\.lock$/.test(base);
}

/** The repo folders that `ensureDeps` prunes and deletes (F2 of the critique). */
export const REPO_CANARY_ROOTS: readonly string[] = [
  path.join(REPO_ROOT, 'node_modules', '@anthropic-ai'),
  path.join(REPO_ROOT, 'node_modules', 'onnxruntime-node', 'bin'),
];

/**
 * The repo canary. Call it in beforeAll and call `changes` in afterAll. The start first runs the
 * same prune that the sync hook and the MCP wrapper run on every start, so the baseline already
 * holds the pruned tree. `changes` returns the listing difference: an empty list means no change.
 */
export function startRepoCanary(): { changes(): string[] } {
  pruneOptionalWeight(path.join(REPO_ROOT, 'node_modules'));
  const before = repoCanaryListing();
  return { changes: () => diffListings(before, repoCanaryListing()) };
}

/** The repair marker that `ensureDeps` writes at the package root when an onnx reinstall fails. */
const REPAIR_MARKER = path.join(REPO_ROOT, '.episodic-memory-onnx-repair-failed');

/**
 * The canary listing: the pruned folders in full, the names at the top of node_modules (an
 * install adds or removes a package there), and the repair marker at the repo root.
 */
function repoCanaryListing(): string[] {
  const top = readdirSync(path.join(REPO_ROOT, 'node_modules')).map((name) => `node_modules/${name}`);
  const marker = existsSync(REPAIR_MARKER) ? [`marker ${path.basename(REPAIR_MARKER)}`] : [];
  return [...listTree(REPO_CANARY_ROOTS), ...top, ...marker].sort();
}

/** The result of one child run. */
export interface CliResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

/** Options of one child run. `allowEnv` names the never-set variables a case sets on purpose. */
export interface RunOptions extends EnvOptions {
  stdin?: string;
  timeoutMs?: number;
  cwd?: string;
}

/**
 * Run a shipped bin under node, with no shell. The only runner: it is async, so a fake server in
 * this process keeps answering while the child runs (a spawnSync would block it). A timeout or a
 * spawn error rejects: a silent empty result would pass for a clean run.
 */
export function runCli(sb: Sandbox, bin: string, args: readonly string[], opts: RunOptions = {}): Promise<CliResult> {
  assertRepoPreconditions();
  const allowEnv = opts.allowEnv ?? [];
  const bad = argvViolations(bin, args, opts.cwd, sb.root, allowEnv);
  if (bad.length > 0) throw new Error(`e2e guard refused a run:\n  - ${bad.join('\n  - ')}`);
  const env = buildEnv(sb, opts);
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [bin, ...args], {
      env: env as NodeJS.ProcessEnv,
      cwd: opts.cwd ?? sb.root,
      shell: false,
      windowsHide: true,
      // A POSIX process group, so a timeout can kill the grandchildren too (killTree).
      detached: process.platform !== 'win32',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf-8');
    child.stderr.setEncoding('utf-8');
    child.stdout.on('data', (chunk: string) => { stdout += chunk; });
    child.stderr.on('data', (chunk: string) => { stderr += chunk; });
    const timer = setTimeout(() => {
      killTree(child);
      reject(new Error(`runCli ${path.basename(bin)} ${args.join(' ')} timed out; stderr: ${stderr}`));
    }, opts.timeoutMs ?? 120_000);
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
    child.stdin.end(opts.stdin ?? '');
  });
}

/** The prompt kinds the fake answers. The order of `classifyPrompt` is load-bearing (see below). */
export type FakeKind = 'learn' | 'topic' | 'digest' | 'compress' | 'summary' | 'other' | 'invalid';

/** The context marker that starts the summary, digest and topic prompts (src/constants.ts:7-8). */
const CONTEXT_MARKER = 'Context: This summary will be shown in a list to help users and Claude choose which conversations are relevant.';

/**
 * The opening text of each product prompt, copied verbatim from the prompt module. A prompt is of
 * one kind when it STARTS with that kind's header. A transcript can quote any marker, so the
 * classifier never searches the body. `prompt-headers` tests check each copy against its source.
 */
export const PROMPT_HEADERS = {
  // src/summarizer.ts:131-133, buildShortSummaryPrompt: the marker, then the request line.
  summary: `${CONTEXT_MARKER}\n\nPlease write a concise, factual summary of this conversation.`,
  // src/digest-prompts.ts:79-81 and 21, buildSessionPrompt: the marker, then RULES.
  digest: `${CONTEXT_MARKER}\n\nWrite the facts that a future session would need to continue this work.`,
  // src/topic-prompts.ts:141-142 and 26-27, buildTopicPrompt: the marker, then TOPIC_RULES.
  topic: `${CONTEXT_MARKER}\n\nKeep the topic documents of this project up to date with the conversation.`,
  // src/digest-prompts.ts:117-119, buildCompressPrompt: the marker, then the merge line (read from a built prompt).
  compress: `${CONTEXT_MARKER}\n\nMerge these notes from one `,
  // src/learn/tasks.ts:203-204, paraphrasePrompt: the first two lines of the array.
  learn: 'You write retrieval practice questions about a past conversation, for a system that must find\nthe conversation again from the question alone.',
} as const;

/** Classify a prompt by its opening text. The body is never searched: a transcript can quote any marker. */
export function classifyPrompt(prompt: string): FakeKind {
  if (prompt.startsWith(PROMPT_HEADERS.learn)) return 'learn';
  if (prompt.startsWith(PROMPT_HEADERS.topic)) return 'topic';
  if (prompt.startsWith(PROMPT_HEADERS.digest)) return 'digest';
  if (prompt.startsWith(PROMPT_HEADERS.compress)) return 'compress';
  if (prompt.startsWith(PROMPT_HEADERS.summary)) return 'summary';
  return 'other';
}

/** The name the fake's callers use for the classifier. */
export const kindOf = classifyPrompt;

/** The failure modes of the fake. `ok` answers every kind in the parser's exact form. */
export type FakeMode = 'ok' | '500' | 'no-summary-block' | 'empty';

/** One request the fake received. Recorded for every request, so a case can assert the calls. */
export interface FakeRequest {
  readonly model: string;
  readonly kind: FakeKind;
  readonly promptLength: number;
  readonly prompt: string;
  /** The `options` object the product sent (for example `temperature`, `num_ctx`). */
  readonly options?: Record<string, unknown>;
  /** The `think` flag the product sent. */
  readonly think?: boolean;
}

/** A running fake Ollama on 127.0.0.1. `close` ends every connection and the server. */
export interface FakeOllama {
  readonly url: string;
  readonly requests: FakeRequest[];
  mode: FakeMode;
  /** A scripted reply for one kind: a text, or a function of the prompt. `null` clears it. */
  setReply(kind: FakeKind, reply: string | ((prompt: string) => string) | null): void;
  close(): Promise<void>;
}

/** The reply text of the fake for one kind. Each form is the one the product's parser accepts. */
function fakeReply(kind: FakeKind, prompt: string, mode: FakeMode): string | null {
  if (mode === 'empty') return '';
  if (kind === 'summary') {
    return mode === 'no-summary-block' ? 'The model continued the transcript instead.' : '<summary>E2E summary MARKER</summary>';
  }
  if (kind === 'digest') {
    const nums = [...new Set([...prompt.matchAll(/\[(\d+)\] (?:\d{4}-\d{2}-\d{2} )?User:/g)].map((m) => m[1]))];
    return nums.slice(0, 2).map((n, i) => (i === 0 ? `The user asked about X. [${n}]` : `The agent fixed Y. [${n}]`)).join('\n');
  }
  if (kind === 'compress') {
    // One merged line that cites the first mark group of the notes. The rules above the notes hold
    // example marks, so the reply reads only the text after the "Notes:" line.
    const notes = prompt.slice(prompt.indexOf('\nNotes:\n'));
    const group = /\[(\d+(?:,\d+)*)\]/.exec(notes)?.[1] ?? '1';
    return `The sessions of this period record the build work. [${group}]`;
  }
  if (kind === 'topic') {
    return ['=== FILE e2e-topic', '# E2E topic', '', 'The build runs on a Linux runner. [^1]', '',
      '[^1]: Time: 2025-09-19; Sources: 1', '=== END'].join('\n');
  }
  if (kind === 'learn') {
    const tier = (n: number): string => `<tier${n}>\nlocate: where was the build setup discussed?\nrecall: what was decided about it, in two sentences?\nwhen: earlier in the archive?\nmulti: which setup choices were made together?\n</tier${n}>`;
    return [tier(1), tier(2), tier(3)].join('\n');
  }
  return 'OK';
}

/**
 * Start a fake Ollama on 127.0.0.1, on a free port. `close` destroys every open connection.
 */
export async function fakeOllama(initialMode: FakeMode = 'ok'): Promise<FakeOllama> {
  const requests: FakeRequest[] = [];
  const state = { mode: initialMode };
  const replies = new Map<FakeKind, string | ((prompt: string) => string)>();
  const server = http.createServer((req, res) => {
    if (req.method !== 'POST' || req.url !== '/api/generate') {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end('{"error":"not found"}');
      return;
    }
    let body = '';
    req.setEncoding('utf-8');
    req.on('data', (chunk: string) => { body += chunk; });
    req.on('end', () => {
      let parsed: { model: string; prompt: string; options?: Record<string, unknown>; think?: boolean };
      try {
        parsed = JSON.parse(body) as typeof parsed;
        if (typeof parsed.prompt !== 'string') throw new Error('prompt is not a string');
      } catch {
        // A malformed body answers 400 and is recorded, so the case sees it; the server stays up.
        requests.push({ model: '', kind: 'invalid', promptLength: body.length, prompt: body });
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end('{"error":"e2e fake: malformed request"}');
        return;
      }
      const kind = classifyPrompt(parsed.prompt);
      requests.push({
        model: parsed.model, kind, promptLength: parsed.prompt.length, prompt: parsed.prompt,
        options: parsed.options, think: parsed.think,
      });
      if (state.mode === '500') {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end('{"error":"e2e forced failure"}');
        return;
      }
      // A scripted reply wins over the mode's default text, but never over `500`.
      const scripted = replies.get(kind);
      const response = scripted === undefined ? (fakeReply(kind, parsed.prompt, state.mode) ?? '')
        : typeof scripted === 'string' ? scripted : scripted(parsed.prompt);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ model: parsed.model, response, done: true }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    get mode() { return state.mode; },
    set mode(next: FakeMode) { state.mode = next; },
    setReply(kind: FakeKind, reply: string | ((prompt: string) => string) | null): void {
      if (reply === null) replies.delete(kind);
      else replies.set(kind, reply);
    },
    close: () => new Promise<void>((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve());
    }),
  };
}

/** The MCP server that `McpClient` starts directly. The wrapper case starts the wrapper instead. */
export const MCP_SERVER_JS = path.join(DIST_DIR, 'mcp-server.js');

const RPC_TIMEOUT_MS = 60_000;
const EXIT_TIMEOUT_MS = 5_000;

/** Resolve true when `done` settles within `ms`, false on the timeout. The timer is cleared. */
function settlesWithin(done: Promise<void>, ms: number): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), ms);
    void done.then(() => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

/** One MCP content block, as the server returns it. */
export interface McpContent {
  readonly type: string;
  readonly text?: string;
}

/** The result of a `tools/call`. `isError` is set when the tool refused its input. */
export interface McpCallResult {
  readonly content: readonly McpContent[];
  readonly isError?: boolean;
}

/**
 * A newline-delimited JSON-RPC client over the stdio of an MCP server, in the sandbox env.
 * Stdout that is not JSON fails every pending request, so a stdout corruption shows at once.
 */
export class McpClient {
  readonly stderrLog: { text: string } = { text: '' };
  private readonly child: ChildProcess;
  private readonly pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
  private readonly exited: Promise<void>;
  private nextId = 1;
  private buffer = '';
  /** Every non-JSON stdout line. `close()` throws when it holds one: stdout corruption is sticky. */
  private readonly stdoutGarbage: string[] = [];
  private exitCode: number | null | undefined = undefined;

  private constructor(child: ChildProcess) {
    this.child = child;
    child.stdout!.setEncoding('utf-8');
    child.stdout!.on('data', (chunk: string) => this.onStdout(chunk));
    child.stderr!.setEncoding('utf-8');
    child.stderr!.on('data', (chunk: string) => { this.stderrLog.text += chunk; });
    child.stdin!.on('error', (err) => this.failPending(err));
    child.on('error', (err) => this.failPending(err));
    this.exited = new Promise((resolve) => {
      child.once('exit', (code) => {
        this.exitCode = code;
        this.failPending(new Error(`MCP server exited with ${code}; stderr: ${this.stderrLog.text}`));
        resolve();
      });
    });
  }

  /**
   * Start a server in the sandbox env, then run the initialize handshake. `entry` picks
   * `dist/mcp-server.js` (default) or `cli/mcp-server-wrapper.js`. The wrapper runs `ensureDeps` on
   * the REPO root (its plugin-root default), which the repo canary covers. `cwd` obeys the guard.
   */
  static async start(sb: Sandbox, opts: EnvOptions & { entry?: 'server' | 'wrapper'; cwd?: string } = {}): Promise<McpClient> {
    assertRepoPreconditions();
    const cwd = opts.cwd ?? sb.root;
    const bad = argvViolations('', [], opts.cwd, sb.root, opts.allowEnv ?? []);
    if (bad.length > 0) throw new Error(`e2e guard refused a run:\n  - ${bad.join('\n  - ')}`);
    const env = buildEnv(sb, opts);
    const script = opts.entry === 'wrapper' ? cliBin('mcp-server-wrapper.js') : MCP_SERVER_JS;
    const child = spawn(process.execPath, [script], {
      env: env as NodeJS.ProcessEnv,
      cwd,
      shell: false,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const client = new McpClient(child);
    try {
      await client.request('initialize', {
        protocolVersion: '2025-11-25',
        capabilities: {},
        clientInfo: { name: 'e2e', version: '0.0' },
      });
    } catch (err) {
      // A failed handshake must not leave the server holding db.sqlite in the sandbox.
      await client.close().catch(() => undefined);
      throw err;
    }
    client.notify('notifications/initialized', {});
    return client;
  }

  private onStdout(chunk: string): void {
    this.buffer += chunk;
    let nl = this.buffer.indexOf('\n');
    while (nl >= 0) {
      const line = this.buffer.slice(0, nl).trim();
      this.buffer = this.buffer.slice(nl + 1);
      nl = this.buffer.indexOf('\n');
      if (line === '') continue;
      let msg: { id?: number; result?: unknown; error?: { message: string } };
      try {
        msg = JSON.parse(line);
      } catch {
        this.stdoutGarbage.push(line.slice(0, 200));
        this.failPending(new Error(`MCP stdout carries a non-JSON line: ${line.slice(0, 200)}`));
        continue;
      }
      if (msg.id === undefined) continue;
      const waiter = this.pending.get(msg.id);
      if (!waiter) continue;
      this.pending.delete(msg.id);
      clearTimeout(waiter.timer);
      if (msg.error) waiter.reject(new Error(`MCP error: ${msg.error.message}`));
      else waiter.resolve(msg.result);
    }
  }

  private failPending(err: Error): void {
    for (const [id, waiter] of this.pending) {
      clearTimeout(waiter.timer);
      this.pending.delete(id);
      waiter.reject(err);
    }
  }

  /** Send one request and await its result. A request that gets no answer times out, and fails. */
  request(method: string, params: unknown): Promise<any> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      if (this.exitCode !== undefined) {
        reject(new Error(`MCP server already exited (${this.exitCode}) before ${method}`));
        return;
      }
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP ${method} timed out after ${RPC_TIMEOUT_MS} ms; stderr: ${this.stderrLog.text}`));
      }, RPC_TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin!.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  }

  /** Send one notification (no id, no answer). */
  notify(method: string, params: unknown): void {
    this.child.stdin!.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
  }

  /** The names of `tools/list`, in the order the server returns them. */
  async listTools(): Promise<string[]> {
    const result = await this.request('tools/list', {});
    return (result.tools as Array<{ name: string }>).map((tool) => tool.name);
  }

  /** Call one tool. The result carries `content` and, for a refused input, `isError`. */
  call(name: string, args: Record<string, unknown>): Promise<McpCallResult> {
    return this.request('tools/call', { name, arguments: args });
  }

  /**
   * End the server. Stdin closes first: the stdio transport exits on EOF. Only after
   * EXIT_TIMEOUT_MS does the client kill the process, with `taskkill /T` on Windows.
   * Returns the exit code.
   */
  async close(): Promise<number | null> {
    if (this.exitCode === undefined) {
      this.child.stdin!.end();
      const exitedInTime = await settlesWithin(this.exited, EXIT_TIMEOUT_MS);
      if (!exitedInTime && this.exitCode === undefined) {
        killTree(this.child);
        // Bounded: a child that survives the kill is reported as null, never awaited forever.
        const gone = await settlesWithin(this.exited, EXIT_TIMEOUT_MS);
        if (!gone) this.stderrLog.text += '\n[harness] MCP server did not exit after SIGKILL';
      }
    }
    if (this.stdoutGarbage.length > 0) {
      throw new Error(`MCP stdout carried ${this.stdoutGarbage.length} non-JSON line(s): ${this.stdoutGarbage.join(' | ')}`);
    }
    return this.exitCode ?? null;
  }
}

/** The text of every text block of a tool result, joined with a newline. */
export function textOf(result: McpCallResult): string {
  return result.content.filter((c) => c.type === 'text').map((c) => c.text ?? '').join('\n');
}

/** The path of a fixture file of `test/fixtures`. */
export function fixturePath(name: string): string {
  return path.join(FIXTURE_DIR, name);
}

/** Where a seeded transcript goes: `<CLAUDE_CONFIG_DIR>/projects/<project>/`. `sync` reads it. */
export interface SeedOptions {
  /** The session id, which names the file. A fresh UUID when omitted. */
  sessionId?: string;
  /** Rewrite every timestamp to a fixed time in 2025. Digest and topic cases need old transcripts. */
  oldTimestamps?: boolean;
}

/**
 * Write a transcript into the sandbox source folder. `source` is a fixture file name, or the
 * exact JSONL lines. Returns the path of the written file.
 */
export function seedTranscript(sb: Sandbox, project: string, source: string | readonly string[], opts: SeedOptions = {}): string {
  const lines = typeof source === 'string'
    ? readFileSync(fixturePath(source), 'utf-8').split('\n').filter((line) => line.trim() !== '')
    : [...source];
  let text = `${lines.join('\n')}\n`;
  if (opts.oldTimestamps) {
    let i = 0;
    text = text.replace(/"timestamp":"[^"]*"/g, () => `"timestamp":"${new Date(Date.UTC(2025, 8, 19, 10, 0, i++)).toISOString()}"`);
  }
  const dir = path.join(sb.claude, 'projects', project);
  mkdirSync(dir, { recursive: true });
  const name = `${opts.sessionId ?? randomUUID()}.jsonl`;
  const file = path.join(dir, name);
  writeFileSync(file, text, 'utf-8');
  SEEDED_FILE_NAMES.add(name);
  return file;
}

/**
 * The file names of every transcript this test process seeded. Each name holds a fresh UUID. A sync
 * that escaped the sandbox copies the transcript into the real archive under the same name, and
 * every other write of such a sync (index rows, summaries) comes with that copy. `useIsolation`
 * therefore looks for these names in the real data folders. A listing diff cannot do that job,
 * because the live plugin of the running session writes those folders at any time.
 */
export const SEEDED_FILE_NAMES = new Set<string>();

/** The sync lock of the sandbox index. A detached `sync --background` holds it while it runs. */
export function syncLockPath(sb: Sandbox): string {
  return path.join(sb.index, '.sync.lock');
}

/** Poll `predicate` every 100 ms until it is true. Throws on the timeout, with `label` in the message. */
export async function waitUntil(predicate: () => boolean, timeoutMs: number, label: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out after ${timeoutMs} ms waiting for: ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

/**
 * The pids of the processes whose command line names sync-cli.js: the detached sync worker of
 * `sync --background`, which receives the sandbox only in its env. The PowerShell pattern is
 * built from pieces, so the PowerShell command line does not match itself.
 */
export function syncWorkerPids(): number[] {
  return syncWorkerProcesses().filter((proc) => isRepoWorker(proc.args)).map((proc) => proc.pid);
}

/** The worker script of this checkout. A worker of the installed plugin runs another copy. */
const REPO_WORKER = path.join(DIST_DIR, 'sync-cli.js');

/**
 * True when `args` runs the sync-cli.js of this checkout. The live plugin starts its own workers
 * from the plugin cache at any time, and those workers are not the suite's.
 */
export function isRepoWorker(args: string): boolean {
  const norm = (text: string) => (process.platform === 'win32' ? text.replace(/\//g, '\\').toLowerCase() : text);
  return norm(args).includes(norm(REPO_WORKER));
}

/** Every process whose command line names sync-cli.js, with that command line. */
function syncWorkerProcesses(): { pid: number; args: string }[] {
  if (process.platform === 'win32') {
    const pattern = "'*sync-cli' + '.js*'";
    const script = `Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like ${pattern} } | ForEach-Object { "$($_.ProcessId)\`t$($_.CommandLine)" }`;
    const result = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], {
      encoding: 'utf-8', windowsHide: true, timeout: 60_000,
    });
    if (result.status !== 0) throw new Error(`process list failed (${result.status}): ${result.stderr}`);
    return result.stdout.split(/\r?\n/).filter((line) => line.trim() !== '').map((line) => {
      const tab = line.indexOf('\t');
      return { pid: Number(line.slice(0, tab).trim()), args: line.slice(tab + 1) };
    });
  }
  const result = spawnSync('ps', ['-eo', 'pid=,args='], { encoding: 'utf-8', timeout: 60_000 });
  if (result.status !== 0) throw new Error(`process list failed (${result.status}): ${result.stderr}`);
  // A token boundary: a developer's grep for the name does not count as a worker.
  return result.stdout.split('\n')
    .filter((line) => /(^|[\\/\s])sync-cli\.js(\s|$)/.test(line))
    .map((line) => {
      const trimmed = line.trim();
      const space = trimmed.search(/\s/);
      return { pid: Number(trimmed.slice(0, space)), args: trimmed.slice(space + 1) };
    });
}

/** The worker pids of `after` that were not in `before`. A case asserts this list is empty. */
export function newSyncWorkers(before: readonly number[], after: readonly number[]): number[] {
  return after.filter((pid) => !before.includes(pid));
}

/** Exit codes of the CLI contract. One table, so no assertion repeats a literal. */
export const EXIT_FAIL = 1;
export const EXIT_USAGE = 2;
export const EXIT_LOCKED = 75;

/** The stderr of a run as one line. Throws unless it holds exactly one non-empty line. */
export function oneLine(stderr: string): string {
  const lines = stderr.split(/\r?\n/).filter((line) => line.trim() !== '');
  if (lines.length !== 1) throw new Error(`expected one stderr line, got ${lines.length}: ${JSON.stringify(stderr)}`);
  return lines[0];
}

/**
 * Open the sandbox index database read-only with node:sqlite. A zero is a real zero: the case
 * reads the rows itself, not through a CLI. Callers close it in `finally`.
 */
export function openIndexDb(sb: Sandbox): DatabaseSync {
  const file = path.join(sb.index, 'db.sqlite');
  if (!existsSync(file)) throw new Error(`no index database at ${file}`);
  return new DatabaseSync(file, { readOnly: true });
}

/**
 * The worker log of a sandbox: `logs/episodic-memory.log` (src/logging.ts `getSyncLogPath`). The
 * detached `sync --background` worker writes it. '' when no run wrote it.
 */
export function readSyncLog(sb: Sandbox): string {
  return readLogFile(path.join(sb.cfg, 'logs', 'episodic-memory.log'));
}

/**
 * The hook log of a sandbox: `sync-errors.log` at the config root (src/logging.ts
 * `getSyncErrorsLogPath`). The SessionStart hook writes the reaper lines and the skip lines here.
 */
export function readHookLog(sb: Sandbox): string {
  return readLogFile(path.join(sb.cfg, 'sync-errors.log'));
}

/** The text of a log file, or '' when it does not exist. It never creates a directory. */
function readLogFile(file: string): string {
  return existsSync(file) ? readFileSync(file, 'utf-8') : '';
}

/**
 * Run `fn` with the sandbox path variables set in this process, for in-process seeding (a learn
 * candidate, a digest row). The test process is pinned to a shared folder (test/test-env.ts), so
 * each variable is checked to resolve under the root before it is set. Every variable is restored
 * in `finally`, including the ones that were unset before.
 */
export async function withSandboxEnv<T>(sb: Sandbox, fn: () => T | Promise<T>): Promise<T> {
  const env = buildEnv(sb);
  const values: Array<[string, string]> = [];
  for (const name of PATH_VARS) {
    const value = env[name];
    if (value === undefined || !isUnderRoot(sb.root, value)) {
      throw new Error(`withSandboxEnv refused ${name}: ${value ?? 'unset'} is not under ${sb.root}`);
    }
    values.push([name, value]);
  }
  const saved = new Map(values.map(([name]) => [name, process.env[name]] as const));
  try {
    for (const [name, value] of values) process.env[name] = value;
    return await fn();
  } finally {
    for (const [name, prior] of saved) {
      if (prior === undefined) delete process.env[name];
      else process.env[name] = prior;
    }
  }
}

/** The quiet window before the digest reads a session (src/digest-job.ts, QUIET_MS = 30 min). */
const DIGEST_QUIET_MS = 30 * 60 * 1000;

export interface DigestableOptions {
  /** Exchanges in the session. The digest skips a one-exchange session (digest-job.ts isTrivial). */
  exchanges?: number;
  /** How old the session is. The default is 60 minutes, past the quiet window. */
  ageMinutes?: number;
  sessionId?: string;
}

/**
 * Write a session that the digest does NOT skip: at least two exchanges, each over 100 characters,
 * every timestamp older than the quiet window. Returns the transcript path. The stamps are computed
 * here and written as they are, so `ageMinutes` is exact (no `oldTimestamps` rewrite).
 */
export function seedDigestableSession(sb: Sandbox, project: string, opts: DigestableOptions = {}): string {
  const exchanges = opts.exchanges ?? 2;
  const ageMinutes = opts.ageMinutes ?? 60;
  if (exchanges < 2) throw new Error('a digestable session needs at least two exchanges');
  if (ageMinutes * 60_000 <= DIGEST_QUIET_MS) throw new Error(`ageMinutes ${ageMinutes} is inside the 30 minute quiet window`);
  const sessionId = opts.sessionId ?? randomUUID();
  const start = Date.now() - ageMinutes * 60_000;
  const stamp = (step: number): string => new Date(start + step * 1000).toISOString();
  const base = { isSidechain: false, userType: 'external', cwd: `/e2e/${project}`, sessionId, version: '2.0.9' };
  const lines: string[] = [];
  let parentUuid: string | null = null;
  for (let i = 0; i < exchanges; i++) {
    const userText = `Digest seed ${i}: the user asks how the build runs on the runner and where the cache lives.`;
    const agentText = `The agent explains the runner build steps, the cache location and the test order for seed ${i}.`;
    if (userText.length + agentText.length <= 100) throw new Error('digest seed text must exceed 100 characters');
    const userUuid = randomUUID();
    const agentUuid = randomUUID();
    lines.push(JSON.stringify({
      ...base, uuid: userUuid, parentUuid, type: 'user', timestamp: stamp(2 * i),
      message: { role: 'user', content: [{ type: 'text', text: userText }] },
    }));
    lines.push(JSON.stringify({
      ...base, uuid: agentUuid, parentUuid: userUuid, type: 'assistant', timestamp: stamp(2 * i + 1),
      message: { role: 'assistant', content: [{ type: 'text', text: agentText }] },
    }));
    parentUuid = agentUuid;
  }
  return seedTranscript(sb, project, lines, { sessionId });
}

/** The SessionStart hooks the harness runs. Each one is a shipped file in `cli/`. */
export type HookName = 'sync-hook' | 'digest-hook';

/** Run one SessionStart hook with the payload that Claude Code sends on stdin. The lister seam is in the env. */
export function runHook(sb: Sandbox, hookName: HookName, payload: object, opts: RunOptions = {}): Promise<CliResult> {
  return runCli(sb, cliBin(`${hookName}.js`), [], { ...opts, stdin: JSON.stringify(payload) });
}

/** The pause between two process-list polls. Each poll on win32 starts PowerShell, so it is not 100 ms. */
const PROCESS_POLL_MS = 1_000;

/**
 * Wait until the detached sync worker of a hook has finished, then remove the sandbox. Three
 * signals, in this order: (1) the sync lock is gone; (2) no sync-cli process is new since `before`
 * (take `before` with `syncWorkerPids()` before the hook runs); (3) the sandbox root removes, which
 * fails while a live worker holds db.sqlite. `inspect` runs after (2) and before (3), while the
 * sandbox still exists. Signal (3) DELETES the sandbox: the caller must not use it afterwards.
 */
export async function waitForBackgroundSync(
  sb: Sandbox, before: readonly number[], timeoutMs: number, inspect?: () => void
): Promise<void> {
  const lock = syncLockPath(sb);
  await waitUntil(() => !existsSync(lock), timeoutMs, `the sync lock ${lock} to be released`);
  const deadline = Date.now() + timeoutMs;
  let fresh = newSyncWorkers(before, syncWorkerPids());
  while (fresh.length > 0) {
    if (Date.now() > deadline) throw new Error(`sync worker pid(s) ${fresh.join(', ')} still running after ${timeoutMs} ms`);
    await new Promise((resolve) => setTimeout(resolve, PROCESS_POLL_MS));
    fresh = newSyncWorkers(before, syncWorkerPids());
  }
  if (inspect) inspect();
  // safeRmSync swallows a final failure, so the root's existence is the second method.
  safeRmSync(sb.root);
  if (existsSync(sb.root)) throw new Error(`sandbox ${sb.root} is still held after the sync worker exited`);
}
