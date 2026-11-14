/**
 * The registry of the coverage gate (`coverage.test.ts`). It lists every flag, environment
 * variable and MCP tool that the suite must cover, plus the items it may leave uncovered, each
 * with a reason. The gate compares this list with what the --help output and the source show.
 *
 * Source of the lists: PLAN.md, "Coverage gate" and "Test files". A `Dn pending` reason marks a
 * defect of PLAN.md that its fix commit moves into FLAGS or ENV_VARS.
 */

/** One flag or subcommand of one command. `flag` is a `--name`, a `-x` or a bare subcommand word. */
export interface FlagEntry {
  readonly command: string;
  readonly flag: string;
}

/**
 * An item the suite does not cover, with its reason.
 * - `flag`: `name` is `<command> <flag>` for a help flag, or the bare flag for a source literal.
 * - `env`: `name` is the variable name.
 * - `tool`: `name` is the MCP tool name.
 * - `path`: a behavior with no flag or variable (a defect, a prompt). The gate does not scan it.
 */
export interface UncoveredEntry {
  readonly kind: 'flag' | 'env' | 'tool' | 'path';
  readonly name: string;
  readonly reason: string;
}

function flagsOf(command: string, flags: readonly string[]): FlagEntry[] {
  return flags.map((flag) => ({ command, flag }));
}

/** Every flag and subcommand that the --help output of each command lists. */
export const FLAGS: readonly FlagEntry[] = [
  ...flagsOf('search', ['--help', '-h', '--vector', '--text', '--after', '--before', '--project', '--session-id', '--git-branch', '--limit', '--both']),
  ...flagsOf('show', ['--help', '-h', '--format', '-f']),
  ...flagsOf('stats', ['--help', '-h']),
  ...flagsOf('index', [
    '--help', '-h', '--concurrency', '-c', '--no-summaries', '--yes', '--cleanup', '--session',
    '--verify', '--repair', '--rebuild', '--project', '--excluded', '--dry-run',
    'prune', 'vacuum', 'index-all', 'index-session', 'index-cleanup', 'verify', 'repair', 'rebuild',
  ]),
  ...flagsOf('sync', ['--help', '-h', '--background']),
  ...flagsOf('backfill', ['--help', '-h', '--limit', '--batch', '--dry-run']),
  ...flagsOf('learn', [
    '--help', '-h', '--per-project', '--seed', '--check', '--run', '--json', '--project', '--yes', '--to',
    'tasks', 'status', 'report', 'approve', 'export', 'render',
  ]),
  ...flagsOf('doctor', ['--help', '-h', '--json', 'codex']),
];

/** The variables the source reads, plus the pinned ones of the harness (see `HARNESS_ONLY_ENV`). */
export const ENV_VARS: readonly string[] = [
  // Read by the source under their own names.
  'CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'XDG_CONFIG_HOME', 'PERSONAL_SUPERPOWERS_DIR',
  'CLAUDE_PLUGIN_ROOT', 'PLUGIN_ROOT', 'FLEET_GPU_RESERVATION', 'TEST_DB_PATH', 'TEST_ARCHIVE_DIR',
  'TEST_PROJECTS_DIR', 'CONVERSATION_SEARCH_EXCLUDE_PROJECTS',
  // EPISODIC_MEMORY_* (the prefix is part of the name).
  'EPISODIC_MEMORY_CONFIG_DIR', 'EPISODIC_MEMORY_DB_PATH', 'EPISODIC_MEMORY_DB_BUSY_TIMEOUT_MS',
  'EPISODIC_MEMORY_DIGEST', 'EPISODIC_MEMORY_DIGEST_MAX_CHARS', 'EPISODIC_MEMORY_DIGEST_MAX_SESSIONS',
  'EPISODIC_MEMORY_DIGEST_DAY_CAP', 'EPISODIC_MEMORY_DIGEST_WEEK_CAP', 'EPISODIC_MEMORY_TOPICS',
  'EPISODIC_MEMORY_TOPICS_SINCE', 'EPISODIC_MEMORY_TOPICS_MAX_SESSIONS',
  'EPISODIC_MEMORY_TOPICS_MAX_TRANSCRIPT_CHARS', 'EPISODIC_MEMORY_TOPICS_MAX_DOCS_CHARS',
  'EPISODIC_MEMORY_TOPICS_MAX_DOC_CHARS', 'EPISODIC_MEMORY_TOPICS_MAX_DOCS',
  'EPISODIC_MEMORY_SUMMARIZER_BACKEND', 'EPISODIC_MEMORY_SUMMARIZER_GUARD',
  'EPISODIC_MEMORY_BACKGROUND_WORKER', 'EPISODIC_MEMORY_SKIP_SUMMARIES', 'EPISODIC_MEMORY_SUMMARY_LIMIT',
  'EPISODIC_MEMORY_MAX_SUMMARY_BYTES', 'EPISODIC_MEMORY_MAX_SUMMARY_ATTEMPTS',
  'EPISODIC_MEMORY_MAX_SUMMARY_DISPLAY_CHARS', 'EPISODIC_MEMORY_INCLUDE_SUMMARY',
  'EPISODIC_MEMORY_MAX_READ_BYTES', 'EPISODIC_MEMORY_MAX_MESSAGE_BYTES',
  'EPISODIC_MEMORY_MIGRATION_BATCH', 'EPISODIC_MEMORY_REDACT_SECRETS', 'EPISODIC_MEMORY_MCP_TOKEN',
  'EPISODIC_MEMORY_DISABLE_AUTO_SYNC', 'EPISODIC_MEMORY_PROC_LISTER', 'EPISODIC_MEMORY_OLLAMA_URL',
  'EPISODIC_MEMORY_OLLAMA_MODEL', 'EPISODIC_MEMORY_OLLAMA_FALLBACK_MODEL',
  'EPISODIC_MEMORY_OLLAMA_MAX_PROMPT_CHARS', 'EPISODIC_MEMORY_API_BASE_URL', 'EPISODIC_MEMORY_API_TOKEN',
  'EPISODIC_MEMORY_API_TIMEOUT_MS', 'EPISODIC_MEMORY_API_MODEL', 'EPISODIC_MEMORY_API_MODEL_FALLBACK',
  'EPISODIC_MEMORY_CODEX_BIN', 'EPISODIC_MEMORY_CODEX_MODEL', 'EPISODIC_MEMORY_CODEX_SUMMARY_TIMEOUT_MS',
  'EPISODIC_MEMORY_LEARN', 'EPISODIC_MEMORY_LEARN_MODEL',
  // EPISODIC_MEMORY_LEARN_* (read by learn-config.ts through raw/count/amount).
  'EPISODIC_MEMORY_LEARN_APPROVE', 'EPISODIC_MEMORY_LEARN_MAX_CALLS', 'EPISODIC_MEMORY_LEARN_MAX_USD',
  'EPISODIC_MEMORY_LEARN_MAX_MINUTES', 'EPISODIC_MEMORY_LEARN_MAX_TASKS', 'EPISODIC_MEMORY_LEARN_CONCURRENCY',
  'EPISODIC_MEMORY_LEARN_ROUNDS', 'EPISODIC_MEMORY_LEARN_MIN_SAVING', 'EPISODIC_MEMORY_LEARN_MIN_GROUNDING',
  'EPISODIC_MEMORY_LEARN_SOLVER_MAX_TURNS', 'EPISODIC_MEMORY_LEARN_LEARNER_MAX_TURNS',
  'EPISODIC_MEMORY_LEARN_MAX_CHARS', 'EPISODIC_MEMORY_LEARN_LEAF_MAX', 'EPISODIC_MEMORY_LEARN_EDITS_PER_ROUND',
  'EPISODIC_MEMORY_LEARN_VALIDATE_SAMPLE', 'EPISODIC_MEMORY_LEARN_PID_POLL_MS',
];

/**
 * Names the harness sets or the OS reads, and the source does not read through a scanned form.
 * The dead-entry check exempts them. Each one is set by `buildEnv` or read by `os.homedir()`.
 */
export const HARNESS_ONLY_ENV: readonly string[] = ['HOME', 'USERPROFILE', 'PATH'];

/** A variable whose effect no e2e case can reach. An active case names it in a guard check. */
export interface GuardOnlyEnv {
  name: string;
  reason: string;
}

/** The registry variables that a case checks by a guard only, each with its reason. */
const REFUSED = 'the harness refuses it, and a case asserts the refusal: it selects a real external service, the live plugin or the unit-test seams';
const IN_PROCESS = 'read only by learnConfig; its effect needs a learn agent run, which the harness refuses; a case reads the config in process';
export const GUARD_ONLY_ENV: readonly GuardOnlyEnv[] = [
  ...['CLAUDE_PLUGIN_ROOT', 'PLUGIN_ROOT', 'TEST_DB_PATH', 'TEST_ARCHIVE_DIR', 'TEST_PROJECTS_DIR',
    'EPISODIC_MEMORY_API_BASE_URL', 'EPISODIC_MEMORY_API_TOKEN', 'EPISODIC_MEMORY_API_TIMEOUT_MS',
    'EPISODIC_MEMORY_API_MODEL', 'EPISODIC_MEMORY_API_MODEL_FALLBACK',
    'EPISODIC_MEMORY_CODEX_BIN', 'EPISODIC_MEMORY_CODEX_MODEL', 'EPISODIC_MEMORY_CODEX_SUMMARY_TIMEOUT_MS',
  ].map((name) => ({ name, reason: REFUSED })),
  ...['EPISODIC_MEMORY_LEARN_MODEL', 'EPISODIC_MEMORY_LEARN_APPROVE', 'EPISODIC_MEMORY_LEARN_MAX_MINUTES',
    'EPISODIC_MEMORY_LEARN_CONCURRENCY', 'EPISODIC_MEMORY_LEARN_ROUNDS', 'EPISODIC_MEMORY_LEARN_MIN_SAVING',
    'EPISODIC_MEMORY_LEARN_MIN_GROUNDING', 'EPISODIC_MEMORY_LEARN_SOLVER_MAX_TURNS',
    'EPISODIC_MEMORY_LEARN_LEARNER_MAX_TURNS', 'EPISODIC_MEMORY_LEARN_LEAF_MAX',
    'EPISODIC_MEMORY_LEARN_EDITS_PER_ROUND', 'EPISODIC_MEMORY_LEARN_VALIDATE_SAMPLE',
    'EPISODIC_MEMORY_LEARN_PID_POLL_MS',
  ].map((name) => ({ name, reason: IN_PROCESS })),
];

/** The MCP tools of `dist/mcp-server.js`, in the order `tools/list` returns them. */
export const MCP_TOOLS: readonly string[] = ['search', 'read', 'digest', 'skills', 'topics'];

/** Items the suite does not cover, each with its reason. Defects carry `Dn pending`. */
export const UNCOVERED: readonly UncoveredEntry[] = [
  // Defects of PLAN.md. Each moves into FLAGS, ENV_VARS or a case in its fix commit.
  { kind: 'path', name: 'doctor creates the archive, index and logs directories', reason: 'D4 pending' },
  { kind: 'path', name: 'digest-hook creates conversation-index when EPISODIC_MEMORY_DIGEST=1', reason: 'D4 pending' },
  { kind: 'path', name: 'index --verify fails after a rebuild: the exchange-less transcript summary is deleted', reason: 'D7 pending' },
  { kind: 'path', name: 'doctor codex cannot find codex.cmd on win32', reason: 'D8 pending' },
  { kind: 'path', name: 'the digest MCP tool creates the index database with the digest flag unset', reason: 'D9 pending' },
  { kind: 'path', name: 'the topics MCP tool creates conversation-index on an empty config folder', reason: 'D10 pending' },
  { kind: 'path', name: 'the sync hook creates conversation-index with auto sync off', reason: 'D11 pending' },
  { kind: 'path', name: 'EPISODIC_MEMORY_MIGRATION_BATCH accepts a negative or non-numeric value', reason: 'D12 pending' },
  { kind: 'path', name: 'sync exits 0 and indexes nothing when another connection holds the write lock', reason: 'D13 pending' },
  // Plan exclusions: each needs a real Claude login, binary or TTY.
  { kind: 'env', name: 'EPISODIC_MEMORY_CLAUDE_BIN', reason: 'the probe of a real Claude Code binary needs a Claude login' },
  { kind: 'env', name: 'CLAUDE_CODE_MAX_OUTPUT_TOKENS', reason: 'SDK pass-through to the Claude Code binary' },
  { kind: 'env', name: 'EPISODIC_MEMORY_RUN_CLAUDE_E2E', reason: 'read by scripts/, outside the suite' },
  { kind: 'env', name: 'EPISODIC_MEMORY_RUN_CODEX_E2E', reason: 'read by scripts/, outside the suite' },
  { kind: 'flag', name: 'learn --split', reason: 'a flag of learn solve, which runs an Agent SDK subprocess' },
  { kind: 'flag', name: 'learn --limit', reason: 'a flag of learn solve, which runs an Agent SDK subprocess' },
  { kind: 'flag', name: 'learn --snapshot', reason: 'a flag of learn solve, which runs an Agent SDK subprocess' },
  { kind: 'flag', name: 'learn --rounds', reason: 'a flag of learn improve, which runs an Agent SDK subprocess' },
  { kind: 'flag', name: 'learn --dry-run', reason: 'a flag of learn improve, which runs an Agent SDK subprocess' },
  { kind: 'flag', name: 'learn solve', reason: 'runs an Agent SDK subprocess; needs a real Claude' },
  { kind: 'flag', name: 'learn improve', reason: 'runs an Agent SDK subprocess; needs a real Claude' },
  { kind: 'flag', name: 'learn bootstrap', reason: 'runs an Agent SDK subprocess; needs a real Claude' },
  { kind: 'path', name: 'index --rebuild without --yes (TTY prompt)', reason: 'a prompt needs a TTY; a child has none' },
  { kind: 'path', name: 'learn approve without --yes (TTY prompt)', reason: 'a prompt needs a TTY; a child has none' },
  { kind: 'path', name: 'claude summarizer backend', reason: 'needs a real Claude login and binary' },
  // Source literals that are not flags of this CLI.
  { kind: 'flag', name: '--version', reason: 'argument to an external command (codex --version), not a flag of this CLI' },
  { kind: 'flag', name: '--no-fund', reason: 'argument to npm in ensure-deps.js, not a flag of this CLI' },
  { kind: 'flag', name: '--no-audit', reason: 'argument to npm in ensure-deps.js, not a flag of this CLI' },
];
