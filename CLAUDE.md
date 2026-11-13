# CLAUDE.md — episodic-memory (a fork)

> Project instructions for AI coding assistants operating on **this fork** of
> `obra/episodic-memory`. Auto-loaded by Claude Code on every session. Keep terse
> in this file; details live in `docs/roadmap/`, `todo.md`, and `CHANGELOG.md`.

**`danielsimonjr/episodic-memory`** is a downstream fork of `obra/episodic-memory@1.4.1`. The fork carries local-only
patches for Windows correctness, stdio-protocol safety, and prompt-injection hardening. The fork exists to ship
those fixes immediately without waiting for upstream merge.

## Identity invariants

- **Repo:** `~/Github/episodic-memory` (local) ↔ `danielsimonjr/episodic-memory` (origin) ↔ `obra/episodic-memory` (upstream)
- **Default branch:** `main` is protected. The CI `build` check is required, so every change goes on a branch and a pull request.
- **Upstream remote:** `upstream` → `https://github.com/obra/episodic-memory.git`
- **Install path on this machine:** `episodic-memory@local-marketplace`. The marketplace `local-marketplace` is sourced from the GitHub repo `danielsimonjr/skills`. NOT `@superpowers-marketplace`.
- **Persistent state lives outside the repo.** The fork uses a relocated copy at `~/.claude/episodic-memory-data/`. The `EPISODIC_MEMORY_CONFIG_DIR` user env var selects the relocated copy. The original at `~/.config/superpowers/` stays untouched as a fallback. If you revert to the upstream install, the upstream install still finds its data there.
  - **Active path (fork reads from here):** `C:\Users\danie\.claude\episodic-memory-data\`
    - DB: `…\conversation-index\db.sqlite`
    - Archive: `…\conversation-archive\`
  - **Fallback path (preserved, untouched, byte-identical):** `C:\Users\danie\.config\superpowers\`
  - **Why the duplication:** isolates fork's data from upstream's; lets us experiment with embedder bumps / schema migrations on the fork without contaminating the canonical config-dir copy. Original survives if we ever revert to `episodic-memory@superpowers-marketplace`.
  - **Keep them in sync intermittently** — if you want the fallback to mirror the active copy after substantive new indexing, re-run robocopy from active → fallback. Or leave them diverged; the fallback is just a recovery point.
  - **Env var:** `EPISODIC_MEMORY_CONFIG_DIR=C:\Users\danie\.claude\episodic-memory-data` (User-level, set via `[Environment]::SetEnvironmentVariable(..., 'User')`). This env var is whitelisted in the plugin's `.mcp.json` so Claude Code passes it through to the spawned MCP server.

## Why this fork exists — the 4 patches

Carry these against upstream `1.4.1`. Each is a real bug; PRs filed at
[obra/episodic-memory#95](https://github.com/obra/episodic-memory/issues/95).

| Patch | Commit | What it fixes |
|---|---|---|
| **Wrapper sentinel check** | `443db0e` | Partial `node_modules` extracts (better-sqlite3 missing native binding) slip past `existsSync(node_modules)`. Wrapper now verifies sentinel files before declaring deps healthy. |
| **`onnxruntime-common` hoist** | `443db0e` | `@huggingface/transformers@4.2.0` directly imports `onnxruntime-common` but doesn't declare it as a direct dep. npm doesn't hoist it because conflicting versions nested under `onnxruntime-node` + `onnxruntime-web`. Adding it as a top-level dep restores ESM resolution. The `onnxruntime-web` override now installs a stub with no dependencies, so at most `onnxruntime-node` nests a copy; the top-level dep stays. |
| **Windows path-split** | `6cadc20` | `parseConversationFile` used `filePath.split('/')` — broken on Windows backslash paths. Every conversation ended up `project='unknown'`. Now uses `path.basename(path.dirname(filePath))`. |
| **stdio log corruption** | `6cadc20` | 5 `console.log` calls in `migrateSchema`/`migrateToolCallsCascade` fire to **stdout** during MCP startup, corrupting JSON-RPC. Switched to `console.error`. |
| **`read` tool path hardening** | `6cadc20` | The MCP `read` tool accepted arbitrary absolute paths with only `existsSync` — prompt-injection arbitrary file read. Now confined to inside `getArchiveDir()` and `.jsonl` extension. |
| **Windows-safe test cleanup** | `6cadc20` | `fs.rmSync` on SQLite WAL files intermittently throws EPERM. Added `safeRmSync` helper with retry+backoff in `test/test-utils.ts`. |

When upstream merges these (or equivalents), rebase/merge `upstream/main` and drop the locally-redundant patches.

## Knowledge store (no memoryjs)

The `learn` feature's `learned/knowledge.db` uses plain better-sqlite3. `src/learn/knowledge-store.ts` owns the
`entities` / `relations` layout. This layout is the one that the former `@danielsimonjr/memoryjs` adapter created,
so an existing file opens unchanged. Every read-modify-write runs under the write lock. The store has no memoryjs
dependency, no `MEMORY_*` environment handling and no per-handle cache. Each open handle sees every write.

## Quick orientation

- **TypeScript source** in `src/`, compiled to `dist/` by `tsc && esbuild`. **Both are committed.**
- **CLI entry points** in `cli/` (Node.js wrappers — no bash).
- **MCP server** is `dist/mcp-server.js`, launched by `cli/mcp-server-wrapper.js` from the plugin manifest.
- **Tests** in `test/` with vitest (155 files, 1548 tests).
- **Generated files** in `dist/` AND `src/version.ts`. The latter is gitignored; never edit it.
- **`bun.lock` is committed** — CI uses `bun install --frozen-lockfile` + `bun audit --audit-level=critical`. Do not commit `package-lock.json` (gitignored).

```
src/
  embeddings.ts          # encoder pipeline; query/exchange embedders
  embedding-migration.ts # version constant + lock + batch migration
  search.ts              # vector + text search; multi-concept aggregation
  indexer.ts             # incremental index from sources to vec_exchanges
  sync.ts / sync-cli.ts  # source→archive copy + index, with reentrancy guard
  fs-retry.ts            # rename that retries a Windows sharing violation (EPERM, EBUSY); imports only fs
  summarizer.ts          # Claude Agent SDK calls; persistSession: false guard
  claude-bin.ts          # EPISODIC_MEMORY_CLAUDE_BIN: the Claude Code executable, probed against the SDK floor; Node built-ins only
  deferral.ts            # deferralDetail: a GPU reservation or an unusable executable defers the model work
  db.ts                  # schema + migrations (cascade + embedding_version)
  paths.ts               # config/index/archive directory resolution
  parser.ts              # JSONL transcript → exchanges (cross-platform path-aware as of fork)
  content-text.ts        # text of a message content, and JSON parse with a fallback; shared by parser.ts and show.ts; imports nothing
  mcp-server.ts          # MCP tool surface (search, read, digest, skills, topics)
  mcp-schemas.ts         # Zod input schemas for the MCP tools; imports only topic-time.ts eagerly
  mcp-tools.ts           # tool handlers; imports learn/skills-tool.js and topic-tool.js lazily
  fts-query.ts           # free text to an FTS5 query: each word quoted, all words must match; imports nothing
  topic-time.ts          # YYYY, YYYY-MM and YYYY-MM-DD times, and the unit id pattern; imports nothing
  topic-format.ts        # topic documents: parse, serialize, unit ids, footnotes, links
  topic-validate.ts      # checks of one staged topic edit; one error line for each failed check
  topic-db.ts            # topic tables: schema, install transaction, read queries
  topic-prompts.ts       # organize prompt and answer parser (FILE and DELETE blocks)
  topic-job.ts           # organize step: picks sessions, calls the model, validates, installs
  topic-phase.ts         # sync entry point of the topic step; never throws
  topic-tool.ts          # body of the topics MCP tool (read-only)
  version.ts             # GENERATED — do not edit

  learn/                 # the Recursa feature; flag EPISODIC_MEMORY_LEARN, off by default
    learn-config.ts      # flag + settings; imports nothing (hook fast path)
    learned-text-screen.ts # injection screen for learned text; imports only ../redact.js
    learn-inject.ts      # rendered block render/read/cap; never opens the knowledge store
    knowledge-store.ts   # knowledge.db on better-sqlite3 (the only module that knows the row layout)
    pii-redactor.ts      # email/SSN/card/phone/IP redaction; imports nothing
    knowledge-db.ts      # snapshots, activation, supersede over the store
    learning-store.ts    # learned/learning.sqlite handle; hook opens it read-only
    learning-db.ts       # runs, tasks, attempts, pass rates
    entry-order.ts       # the two sort orders of learned entries; imports nothing
    prng.ts              # mulberry32, the seeded generator of the task split and the validation sample; imports nothing
    skills-tool.ts       # the `skills` MCP tool body
    tasks.ts / grade.ts  # self-practice task generation and deterministic grading
    solver.ts / agent-runner.ts / sdk-tools.ts / semaphore.ts / prompts.ts
    bootstrap.ts / leaf-learner.ts / learner.ts / knowledge-gate.ts / cited-ids.ts
    export.ts / report.ts / learn-lock.ts / usage.ts / cli-main.ts

cli/
  episodic-memory.js     # umbrella CLI dispatcher
  mcp-server-wrapper.js  # ensures deps are installed (sentinel check as of fork)
  forward-child.js       # runs one script as a child; a signal stop exits 1; runChild waits for the child; shared by the entry points
  *.js                   # subcommand entry points

vendor/
  onnxruntime-web-stub/  # the package that the onnxruntime-web override points at; never published, its main file throws

scripts/
  bump-version.sh        # version bumper with drift audit
  generate-version.js    # writes src/version.ts from package.json
  scrub-fixtures.sh      # PII-scrubs test fixtures (BSD/macOS sed only)

test/
  test-utils.ts          # createTestDb, safeRmSync (fork-added), suppressConsole, fixtures
  *.test.ts              # 155 test files, 1548 tests
  learn/                 # the Recursa suite; fakes for every model call
  fixtures/              # JSONL conversation fixtures

docs/
  roadmap/               # see docs/roadmap/README.md
  ...

hooks/hooks.json         # SessionStart: cli/sync-hook.js (spawns `sync --background` detached) then cli/digest-hook.js
agents/                  # agents/search-conversations.md
skills/                  # skills/remembering-conversations/{SKILL.md,MCP-TOOLS.md}
prompts/                 # prompts/search-agent.md
```

## Build, test, release commands

```bash
bun install        # package manager is Bun (Node stays the production runtime)
bun test           # alias: bun run test — full suite; pretest generates src/version.ts
bun run typecheck  # tsc --noEmit
bun run build      # tsc + esbuild bundle into dist/mcp-server.js
bun run generate-version   # writes src/version.ts from package.json
```

The `prebuild` and `pretest` hooks both regenerate `src/version.ts`. After
source changes that touch the MCP server or any imported module, run
`bun run build` so `dist/` reflects source. **Commit `dist/` alongside `src/`** —
CI doesn't rebuild for you.

**Node floor: `>=22.0.0`** is the floor of better-sqlite3 13. The `engines` field is advisory, so the launch enforces
the floor. `src/node-floor.ts` holds the constant. `cli/mcp-server-wrapper.js` and `cli/episodic-memory.js learn`
exit with one stderr line below the floor. CI runs Node 24. Both of the user's machines run Node 24.
`docs/roadmap/upstream-sync.md` records the floor as a fork-only divergence from upstream.

**Toolchain vs runtime:** Bun is the package manager and script driver (CI + local
dev). Shipped code still runs under **Node** (CLI shebangs, `.mcp.json`, hooks).
Plugin first-run dependency install in `cli/mcp-server-wrapper.js` still uses
`npm install --omit=dev` (`NPM_INSTALL_ARGS` in `cli/ensure-deps.js`) because end-user Claude Code / Codex
hosts have npm, not Bun. `test/runtime-imports.test.ts` fails when a runtime file imports a package that
is not a dependency.
`ensureDeps` also runs `pruneOptionalWeight` on every call. As a result, the wrapper and the sync hook remove
the `onnxruntime-node` binding directories of the other platforms from `node_modules`. A repo checkout loses
the directories too. A plain `bun install` keeps the pruned tree. To restore the directories, delete
`node_modules/onnxruntime-node` and run `bun install`.

**Claude Code executable (`EPISODIC_MEMORY_CLAUDE_BIN`, opt-in).** When the variable is unset, the SDK runs the
binary of its platform package `@anthropic-ai/claude-agent-sdk-<platform>-<arch>` (269 MB on Windows x64). When the
variable is set, it names an absolute path to a Claude Code binary, or to a `.js` or `.mjs` file. `src/claude-bin.ts` probes the path once per
process with `--version` against the floor in the SDK `manifest.json`. When the probe passes, `pruneOptionalWeight`
removes the platform packages. When no usable executable exists, the summary loop, the digest, the topic job and
the backfill defer (`src/deferral.ts`). These steps count no attempt and write no failure record. The learn commands that
start Claude Code exit 1 before the lock. Set the variable in a place that every process inherits: the User
environment variable on Windows, or the shell profile elsewhere. The Claude Code `env` setting does not reach a
scheduled task. To roll back, remove the variable first. Then run `npm install --omit=dev --no-audit --no-fund`
(or `bun install`) in the plugin root. A plain install restores the platform package.

### Current test state

- **Full suite: 1548 tests in 155 files pass** in about 17 s of wall clock on Linux. Windows runs are slower.
  The suite no longer has the former `integration.test.ts` / `verify.test.ts` cold-embedding timeout flakes.
  `beforeAll` pre-warms the embedder once per worker. `vitest.config.ts` sets `hookTimeout: 30000`.
  The repair re-index test gets 60s. If you see a fresh timeout flake, suspect a new embedding-heavy hook
  without warm-up, not the old cold-start cause.
- The learn tests are the bulk of the suite (`test/learn/`, 38 files; the other 117 test files sit directly in `test/`). The learn tests never reach a model: every agent and
  text call is injectable and tests pass fakes. `test/test-env.ts` pins the Claude backend, a closed ollama URL
  and a temporary config directory. `test/setup-env.ts` deletes every other `EPISODIC_MEMORY_*` variable of
  the machine. A local run therefore uses the CI settings and cannot reach a model or the live data.
  `test/setup-env.ts` also replaces `query` of the Claude Agent SDK with the guard of `test/real-sdk-guard.ts`.
  A test that reaches the guard fails, also when its code catches the error. A test file that mocks the SDK
  keeps its own mock. `test/test-env.ts` pins `EPISODIC_MEMORY_CODEX_BIN` to a path that does not exist.
  `test/global-setup.ts` loads the embedding model once before the workers start. A fresh checkout
  therefore downloads the model one time, and the workers read the cached file.
- Run a single test: `bun run test test/<file>.test.ts`. Much faster, cleaner output.

## Critical gotchas (read before editing)

### 1. stdio MCP servers MUST log to stderr only

stdout is reserved for JSON-RPC. **Any `console.log` reachable from the MCP server crashes the protocol.** The fork already fixed the 5 `console.log` calls in `db.ts` migrations. When adding new logging:

- ✅ `console.error('...')`
- ✅ `process.stderr.write('...\n')`
- ❌ `console.log(...)` — corrupts protocol
- ❌ `process.stdout.write(...)` — corrupts protocol

The stderr-only rule applies to **every module reachable from `mcp-server.ts`**. The lists below name the modules of the source import graph. The `bundle` script inlines all of them into `dist/mcp-server.js`, except `learn/skills-tool.js` and `topic-tool.js`, which stay separate files. The rule holds for both the source and the bundle.

Static imports load these modules at server start:

`mcp-server.ts`, `mcp-tools.ts`, `mcp-schemas.ts`, `mcp-auth.ts`, `archive-path.ts`, `paths.ts`, `db.ts`, `digest-db.ts`, `embedding-migration.ts`, `fts-query.ts`, `lockfile.ts`, `redact.ts`, `constants.ts`, `version.ts`, `learn/learn-config.ts`, `topic-time.ts`

Dynamic imports load these modules only inside a branch:

- `search`: `search.ts`, `embeddings.ts`
- `read`: `show.ts`, `content-text.ts`
- `digest`: `digest-tool.ts`, `digest-inject.ts`, `digest-validate.ts`
- `skills`: `learn/skills-tool.ts`, `digest-inject.ts`, `learn/knowledge-store.ts`, `learn/learn-inject.ts`, `learn/learned-text-screen.ts`, `learn/pii-redactor.ts`
- `topics`: `topic-tool.ts`, `topic-db.ts`, `topic-format.ts`, `digest-inject.ts`, `digest-validate.ts`

`topic-tool.ts` is imported lazily, like `skills-tool.ts`. `fts-query.ts` and `topic-time.ts` are already eager. The topic branch adds nothing to them. `mcp-schemas.ts` imports only `topic-time.ts` eagerly.

CLI files use some modules that the server never loads, for example `indexer.ts`, `sync.ts` and `learn/cli-main.ts`. These modules can use `console.log`.

The lazy import has a load-bearing role in both directions. `mcp-tools.ts` calls `learnEnabled()` from `learn-config.ts` (which imports nothing) *before* `mcp-tools.ts` imports `skills-tool.ts`. A flag-off server never opens the knowledge store. If a session never asks for a skill, the session pays nothing for the feature. `topic-tool.ts` has the same arrangement. If a session never calls `topics`, the session loads no topic module except `topic-time.ts`. Keep the eager feature surface at `learn-config.ts` and `topic-time.ts`, and nowhere else.

### 2. Windows path separators

Always use `path.join`, `path.dirname`, `path.basename`, `path.sep` — never split or join paths on a literal `/` or `\\`. The fork already fixed `parser.ts:540`; future code should match.

When matching paths in tests or fixtures, normalize both sides:
```ts
expect(path.normalize(actual)).toBe(path.normalize(expected));
```

### 3. `dist/` is committed — edit src/, build, commit both

Hand-edits to `dist/` get clobbered by `bun run build`. Always edit `src/`, then `bun run build`, then commit both together.

When you commit dist/, **only stage files with real content changes**. `tsc` regenerates with native line endings on each platform. `tsc` produces many "modified" files with line-ending-only diffs. On Windows, expect 40+ dist files to show as modified after a build. Only ~5 dist files have real content. Stage explicitly by name, not by `git add dist/`.

### 4. The summarizer recursion guard (#87)

`summarizer.ts` calls the Claude Agent SDK's `query()`, which spawns a Claude subprocess that fires `SessionStart` hooks. Our `SessionStart` hook (`cli/sync-hook.js`) spawns `sync --background`, which calls the summarizer. That loop fans out hundreds of processes within seconds.

The fix:
- `getApiEnv()` always sets `EPISODIC_MEMORY_SUMMARIZER_GUARD=1` in the env it returns to the SDK
- `sync-cli.ts` checks `shouldSkipReentrantSync()` **before importing the heavy native stack** and exits silently when the guard is set

The guard lives in its own dependency-free module, `src/reentrancy.ts` (`SUMMARIZER_GUARD_ENV` + `shouldSkipReentrantSync`). `summarizer.ts` re-exports the guard for back-compat. `sync-cli.ts` checks the guard *first*. The CLI imports the heavy modules (`db.js` → better-sqlite3, `embeddings.js`/ `embedding-migration.js` → transformers) lazily via `await import()` only when the CLI actually does work. Keep the lazy import arrangement. Moving any heavy module back to a top-level static import makes every guarded reentrant subprocess pay a multi-second load just to bail.

**Anything new that spawns a Claude subprocess via the SDK must inherit this guard.** Nothing should run `sync --background` without checking the guard first. Test with `test/sync-cli-reentrancy.test.ts` / `test/reentrancy.test.ts` if you change the spawn path.

### 5. Embedding migration

The `exchanges.embedding_version` column tracks which encoder produced each row's vector. New code stamps `EMBEDDING_VERSION` (in `src/embedding-migration.ts`); old rows from earlier installs default to 0. The sync flow re-embeds stale rows in batches behind a lock at `~/.config/superpowers/conversation-index/.embedding-migration.lock`.

**If you change anything in the embedding pipeline** (model, dtype, prefix, pooling, normalization, truncation), **bump `EMBEDDING_VERSION`**. That triggers automatic re-embedding for everyone on upgrade. Don't change pipeline behavior silently — search results would degrade against indexed vectors from the old pipeline.

### 6. Test isolation

Tests use `mkdtempSync`, set `TEST_DB_PATH`/`TEST_PROJECTS_DIR`/`EPISODIC_MEMORY_CONFIG_DIR` per-test, and clean up in `afterEach`. Don't reach for the real `~/.config/superpowers/`. The `test-utils.ts` helpers cover the common patterns. **Use `safeRmSync` (not raw `fs.rmSync`)** in afterEach for directories holding SQLite WAL files — Windows EPERM race documented in [[feedback_stdio_mcp_logger_stderr]].

### 7. MCP failure-cache bug

Claude Code's plugin loader caches MCP failures keyed on config-hash. Once a server fails to start, `/reload-plugins` silently skips it forever. To force a retry, change the env in `.mcp.json` (a `_RETRY` field with a unique timestamp works). Documented at [[feedback_claude_code_mcp_failure_cache]].

The fork's plugin uses `cwd: '.'` and a fixed command — if a fresh install fails, it's the plugin bug, not the cache bug.

### 8. Learned text is untrusted: gate it

A model writes everything that the `learn` feature stores, and that model has just read archive content. The
hook injects the stored text into every future session. The export writes the stored text to `SKILL.md` files.
Later learners read the stored text. The code therefore treats the stored text as hostile input, not as
instructions:

- Every field of every kind (title, description, scope, body, slug, reflection text) passes
  `screenLearnedText` (`src/learn/learned-text-screen.ts`) **before storage and again on the way out**.
  `screenLearnedText` runs in the hook, the `skills` tool and the export. `screenLearnedText` rejects
  instruction-override and authority framing, unlisted tool invocations, shell commands, file writes,
  URLs and obfuscated URLs, emails, long base64 runs, and credential requests. `screenLearnedText`
  runs after NFKC normalisation and removal of zero-width / bidi characters.
- Every line must cite real exchange ids. Every line must also share `EPISODIC_MEMORY_LEARN_MIN_GROUNDING`
  content tokens with one of the cited exchanges. The gate drops a line that fails either check. The gate rejects an
  entry that has no remaining line.
- Redaction runs first and last: prompts, stored fields, answers and traces all pass `redactSecrets` plus
  `redactPii` (`src/learn/pii-redactor.ts`).
- A skill activates on validation; an instruction stays a `candidate` until a human runs `learn approve`
  (default `EPISODIC_MEMORY_LEARN_APPROVE=instructions`).

The screen is a **barrier, not a proof**. If you add a new place that renders learned text, route it
through the same screen and redaction rather than trusting the store. Never `console.log` learned text
without screening it, and never treat a learned line as an instruction in code.

## MCP tool surface

The fork exposes 5 MCP tools: `search` and `read` as upstream (with the fork's safety hardening on `read`),
plus `digest`, `skills` and `topics`.

`.mcp.json` whitelists the environment variables the server may see:

```
EPISODIC_MEMORY_CONFIG_DIR          PERSONAL_SUPERPOWERS_DIR
XDG_CONFIG_HOME                     EPISODIC_MEMORY_DB_PATH
CONVERSATION_SEARCH_EXCLUDE_PROJECTS
EPISODIC_MEMORY_LEARN               EPISODIC_MEMORY_LEARN_MAX_CHARS
EPISODIC_MEMORY_MCP_TOKEN           EPISODIC_MEMORY_REDACT_SECRETS
EPISODIC_MEMORY_MAX_READ_BYTES      EPISODIC_MEMORY_DIGEST_MAX_CHARS
EPISODIC_MEMORY_INCLUDE_SUMMARY     EPISODIC_MEMORY_MAX_SUMMARY_DISPLAY_CHARS
EPISODIC_MEMORY_CLAUDE_BIN
```

Every variable that the server reads at runtime has an explicit line in this whitelist. Without its line, the
plugin-launched server never sees the variable. `skills` would then answer "learning is off" forever.
`auth_token` could never be required. A read cap or a redaction setting would have no effect. Any new setting
that the MCP server reads at runtime needs its own line here and in `test/codex-plugin.test.ts`.
`EPISODIC_MEMORY_DIGEST` is not in the list on purpose. The variable gates *writing* the digest in `sync` and the
hook, and the `digest` tool reads the digest that those steps wrote. `EPISODIC_MEMORY_CLAUDE_BIN` is in the list
for `cli/mcp-server-wrapper.js`. The `ensureDeps` call of the wrapper removes the platform packages only when the
wrapper sees the variable.

### `search`

Vector + text search across indexed conversations.

Inputs (Zod-validated):
- `query`: string (required) — natural-language search
- `mode`: `'vector'` | `'text'` | `'both'` (default: `'both'`)
- `limit`: number (default: 10, max: 50)
- `project`, `session_id`, `git_branch`: optional metadata filters
- `after`, `before`: ISO date strings `YYYY-MM-DD`
- `response_format`: `'markdown'` | `'json'`
- `auth_token`: required only when `EPISODIC_MEMORY_MCP_TOKEN` is set (`src/mcp-auth.ts`)
- multi-concept AND search: pass `query` as an array of 2–5 strings

Output: list of `ConversationExchange` rows (id, project, timestamp, user/assistant message, archive_path, line_start, line_end, plus metadata).

### `read`

Read a specific JSONL conversation file by path.

Inputs:
- `path`: string (required) — **must resolve inside `getArchiveDir()` and end in `.jsonl`** (fork hardening, `src/archive-path.ts`; symlink escapes refused; full reads capped by `EPISODIC_MEMORY_MAX_READ_BYTES`, default 32 MB)
- `startLine`, `endLine`: optional line range
- `auth_token`: as for `search`

Output: markdown-formatted conversation.

**Fork security model:** the `path` parameter is intended to be filled with `archive_path` values returned by `search()`. Direct calls with arbitrary paths now error. If you need to read a JSONL outside the archive, copy it in first (or use `fs.readFileSync` from a CLI/script context).

### `digest`

The `digest` tool shows the session digest. The tool searches the digest (`query`). The tool turns a `[#id]` mark
into an archive path and line range for `read` (`expand`). The tool stores a one-line note for the next session
(`handoff`). The tool is off unless `EPISODIC_MEMORY_DIGEST=1`. `README.md` § Session Digest documents the tool.

### `skills`

Read the skills the `learn` feature derived from this project's conversations. The tool is read-only.
The tool never writes. With `EPISODIC_MEMORY_LEARN` unset, the tool answers that learning is off
**without opening a store**. The tool checks `learnEnabled()` before the tool imports the
store-backed module. So a flag-off session pays nothing.

Inputs:
- `get`: slug of one skill, as listed — returns its frontmatter and body
- `query`: search learned skills instead of listing them
- `project`: project key (default: the key for `process.cwd()`, same rule as `digest`)
- `limit`: number (default: 10, max: 50)

Output: one `slug: description (confidence, vN)` line per active skill, or the requested skill's
frontmatter (`name`, `description`, `scope`, `sources`, `confidence`, `version`) plus body.

The tool screens every field for injected instructions. The tool redacts secrets and PII before the tool returns
the field. If a field fails the screen, the tool withholds the whole entry. The tool does not print a skill whose
text cannot be trusted. The tool opens the store **per call, read-only** and closes the store in `finally`. The
server therefore never holds a handle on `knowledge.db` between calls. A read-only tool call can never create or
migrate the file.

### `topics`

Read the topic memory documents of a project: `list`, `read`, `search`, `links` or `timeline`. The sync step writes the documents when `EPISODIC_MEMORY_TOPICS=1`. Documented in `skills/remembering-conversations/MCP-TOOLS.md` § topics.

Inputs (`TopicsInputSchema` in `src/mcp-schemas.ts`, strict: unknown fields are refused):
- `action`: `'list'` | `'read'` | `'search'` | `'links'` | `'timeline'` (required)
- `read` requires `slug`; `search` requires `query`; `links` requires `unit` (8 lowercase hex characters); `list` and `timeline` require nothing
- `project`: project key (default: the key for `process.cwd()`)
- `from`, `to`: optional `YYYY`, `YYYY-MM` or `YYYY-MM-DD`, used by `search` and `timeline`; `to` must not be before `from`
- `limit`: 1–50; `search` default 10, `timeline` default 50
- `auth_token`: required only when `EPISODIC_MEMORY_MCP_TOKEN` is set

Read-only. `src/topic-tool.ts` opens the index read-only, never calls `ensureTopicSchema`, and answers `Topic memory has no documents yet.` when the index file or a topic table is missing. The tool does not check `EPISODIC_MEMORY_TOPICS`. The tool returns what the sync step wrote. The server reads no topic variable, so `.mcp.json` does not whitelist any `EPISODIC_MEMORY_TOPICS_*` name. Topic text passes `redactEntryText` again on the way out.

## Development workflow — the user's 12 steps

Use `dev-workflow` skill for any task that produces a commit. Pipeline:

1. **plan** — design approach
2. **review-plan** — self-review for assumptions/edge cases/back-compat
3. **write-code** — TDD strict, failing test first
4. **review-code** — diff review (use `pr-review-toolkit:code-reviewer` for non-trivial changes)
5. **fix issues** — address findings ≥confidence 70
6. **code-simplifier** — preserve behavior, increase clarity
7. **update ROADMAP/todo.md** — flip checkboxes in tracking docs
8. **update CHANGELOG** — entry under `## [Unreleased]`, user-facing
9. **commit** — atomic, descriptive message, `Co-Authored-By: Claude` footer
10. **push** — push the branch, open a pull request, and merge after CI passes
11. **next task** — pick next 🟢 from todo.md
12. **recurse** — back to step 1

**Cardinal rules:**
- TDD strict — confirm RED before implementing, GREEN before refactoring
- Verify before claiming done — each task's gate must be run (typecheck/test/smoke)
- No `--no-verify` / `--no-gpg-sign` / hook bypassing without explicit authorization
- Atomic commits — one task = one commit (or a clean atomic series)
- Root-cause fixes — don't widen thresholds, disable tests, or eslint-disable without comments

**For non-trivial work, also use:**
- `superpowers:brainstorming` → `superpowers:writing-plans` for design/plan docs
- `Adam (Gemini 2.5 Pro) + Eve (OpenAI o3)` adversarial review on both design AND plan (the "review-both" lesson from UPT)
- `RLM` skill for whole-codebase audits (see `CHANGELOG.md` for the first audit of this fork)
- `honest-claude` skill to vet every RLM finding by reading the actual file before recommending or committing

## Common debugging recipes

### "× failed" in `/mcp`

Most common cause on a fresh install: the wrapper's `npm install` didn't fully populate `node_modules`. **The fork's sentinel check should catch this**, but if it doesn't:

```bash
cd ~/.claude/plugins/cache/<marketplace>/episodic-memory/<version>
npm install --omit=dev --no-audit --no-fund
# If transformers errors on onnxruntime-common:
npm install --no-save onnxruntime-common@1.24.3
# If the first search fails because onnxruntime_binding.node is missing (npm does not restore one file):
rm -rf node_modules/onnxruntime-node && npm install --omit=dev --no-audit --no-fund
```

(Plugin cache installs use **npm**, not Bun — matching the MCP wrapper.)

The check also finds a missing `onnxruntime-node` binding. The wrapper then moves `node_modules/onnxruntime-node` aside and installs it again. When that reinstall fails, the wrapper puts the old directory back, writes `.episodic-memory-onnx-repair-failed` in the plugin root, and starts the server without vector search. The next attempt waits 24 hours. Delete the marker file to retry at the next start.

Then `/reload-plugins`. If still failing, you're hitting Claude Code's per-session failure cache — see gotcha #7.

### Probing the server in isolation

```bash
cd ~/.claude/plugins/cache/<marketplace>/episodic-memory/<version>
echo '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"probe","version":"0.0"}}}' \
  | node ./cli/mcp-server-wrapper.js
```

Expected response on stdout (single JSON line):
```json
{"result":{"protocolVersion":"2024-11-05","capabilities":{"tools":{}},"serverInfo":{"name":"episodic-memory","version":"<version>"}},"jsonrpc":"2.0","id":1}
```
Plus on stderr: `Episodic Memory MCP server running via stdio`.

If stdout has ANYTHING before the JSON-RPC response — that's a stdio corruption bug (gotcha #1). Fix the offending `console.log`.

### "Database is locked"

Likely a leaked DB handle from a previous process. Check `~/.config/superpowers/conversation-index/`:

```bash
ls -la ~/.config/superpowers/conversation-index/*.db-wal ~/.config/superpowers/conversation-index/*.db-shm 2>/dev/null
```

If WAL files are present and stale (>1 hour), it's safe to delete them (SQLite will recreate). If recent, find and kill the holding process.

### Resetting the index

```bash
node cli/episodic-memory.js index rebuild
# Or destructively:
rm -rf ~/.config/superpowers/conversation-index/
node cli/episodic-memory.js sync
```

⚠️ Don't `rm -rf ~/.config/superpowers/conversation-archive/` — that's the source data backup. Only the index can be safely rebuilt from the archive.

⚠️ `learned/` is **outside** `conversation-index/`. The directory is a sibling, not a child. So none of
the commands above touch the directory. Do not remove the directory as part of an index reset. The
directory holds learned entries (`knowledge.db`), the learning trace (`learning.sqlite`) and the
rendered hint block. None of these items can be rebuilt from the archive. Delete `learned/` only when
you deliberately want the agent to forget everything the agent learned. (`learned-skills/`, also a
sibling, *is* generated output and regenerates on the next export.)

## Upstream sync workflow

```bash
cd ~/Github/episodic-memory
git fetch upstream
git log --oneline main..upstream/main  # see what's new upstream

# If clean merge:
git merge upstream/main
git push origin main

# If conflicts (most likely in src/db.ts, src/parser.ts, src/mcp-server.ts where the fork patches live):
git merge upstream/main
# Resolve, prioritizing fork patches that haven't been merged upstream
git commit
git push origin main
```

After each upstream sync:
1. `bun install` (deps may have changed)
2. `bun run build` (regenerate dist/)
3. `bun run test` (verify nothing regressed)
4. Update `CHANGELOG.md` and `todo.md` with the upstream merge note

**If obra merges any of the fork patches** (track at https://github.com/obra/episodic-memory/issues/95), drop the locally-redundant patch from this fork by reverting that specific change and rebuilding.

## Release engineering (only if shipping a fork-only npm version)

This fork is **not** currently published to npm — installs flow through Claude Code's plugin marketplace, which clones the GitHub repo. If you ever want to publish:

1. `bun run test` (full suite must pass)
2. `bun run build` (commits `dist/` need to be fresh)
3. `./scripts/bump-version.sh X.Y.Z-fork.N` (versioned to avoid colliding with upstream)
4. CHANGELOG entry under the new version header
5. `git commit -m "Release vX.Y.Z-fork.N: <one-line>"`
6. `git tag -a vX.Y.Z-fork.N -m "Release vX.Y.Z-fork.N"`
7. `git push origin main && git push origin vX.Y.Z-fork.N`
8. `npm publish --ignore-scripts --access public` (`--ignore-scripts` to skip the slow `prepublishOnly` on Windows — the suite is verified at step 1)

⚠️ **Rotate the npm token before any publish** if it was ever pasted into a transcript. Token page: https://www.npmjs.com/settings/danielsimonjr/tokens.

## File / docs cross-reference

- `todo.md` — current task tracker (root)
- `docs/roadmap/README.md` — three-tier roadmap index
- `docs/roadmap/now.md` — 1-3 month deliverables
- `docs/roadmap/next.md` — 3-6 month themes
- `docs/roadmap/later.md` — 6-12+ month vision
- `docs/roadmap/upstream-sync.md` — strategy for tracking obra's work
- `docs/roadmap/focus-areas/*.md` — per-theme deep dives
- `CHANGELOG.md` — Keep-a-Changelog format, entries under `[Unreleased]` until release
- `README.md` — upstream's; mostly unchanged in the fork

## When in doubt

Read the relevant test file. Tests in this repo are the executable spec —
particularly `test/embedding-migration.test.ts`, `test/sync-cli-reentrancy.test.ts`,
`test/tool-calls-cascade.test.ts`, and `test/parser.test.ts`. They cover the
load-bearing invariants (lock contention, recursion-guard, schema migrations,
cross-platform path handling) and exercise real subsystems rather than mocking
them.

If you're about to make a change that touches more than one of:
- The MCP tool surface (search/read inputs or outputs)
- The DB schema
- The embedding pipeline
- The sync recursion contract

…stop and use `brainstorming` → `writing-plans` first. The contracts are load-bearing. Subtle drift breaks
downstream caches and indexed data.
