# CLAUDE.md — episodic-memory (a fork)

> Project instructions for AI coding assistants operating on **this fork** of
> `obra/episodic-memory`. Auto-loaded by Claude Code on every session. Keep terse
> in this file; details live in `docs/roadmap/`, `todo.md`, and `CHANGELOG.md`.

This is **`danielsimonjr/episodic-memory`** — a downstream fork of
`obra/episodic-memory@1.4.1` carrying local-only patches for Windows
correctness, stdio-protocol safety, and prompt-injection hardening. The fork
exists to ship those fixes immediately without waiting for upstream merge.

## Identity invariants

- **Repo:** `~/Dropbox/Github/episodic-memory` (local) ↔ `danielsimonjr/episodic-memory` (origin) ↔ `obra/episodic-memory` (upstream)
- **Default branch:** `main` — direct push, no PR flow for fork-only commits
- **Upstream remote:** `upstream` → `https://github.com/obra/episodic-memory.git`
- **Install path on this machine:** `episodic-memory@local-marketplace` (via `~/.claude/local-marketplace/.claude-plugin/marketplace.json`). NOT `@superpowers-marketplace`.
- **Persistent state lives outside the repo.** As of 2026-05-18, this fork uses a relocated copy at `~/.claude/episodic-memory-data/` (configured via `EPISODIC_MEMORY_CONFIG_DIR` user env var), while the original at `~/.config/superpowers/` is preserved untouched as a fallback so upstream installs (if reverted to) still find their data.
  - **Active path (fork reads from here):** `C:\Users\danie\.claude\episodic-memory-data\`
    - DB: `…\conversation-index\db.sqlite` (175 MB, 2,739 exchanges)
    - Archive: `…\conversation-archive\` (751 MB across 16 projects)
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
| **`onnxruntime-common` hoist** | `443db0e` | `@huggingface/transformers@4.2.0` directly imports `onnxruntime-common` but doesn't declare it as a direct dep. npm doesn't hoist it because conflicting versions nested under `onnxruntime-node` + `onnxruntime-web`. Adding it as a top-level dep restores ESM resolution. |
| **Windows path-split** | `6cadc20` | `parseConversationFile` used `filePath.split('/')` — broken on Windows backslash paths. Every conversation ended up `project='unknown'`. Now uses `path.basename(path.dirname(filePath))`. |
| **stdio log corruption** | `6cadc20` | 5 `console.log` calls in `migrateSchema`/`migrateToolCallsCascade` fire to **stdout** during MCP startup, corrupting JSON-RPC. Switched to `console.error`. |
| **`read` tool path hardening** | `6cadc20` | The MCP `read` tool accepted arbitrary absolute paths with only `existsSync` — prompt-injection arbitrary file read. Now confined to inside `getArchiveDir()` and `.jsonl` extension. |
| **Windows-safe test cleanup** | `6cadc20` | `fs.rmSync` on SQLite WAL files intermittently throws EPERM. Added `safeRmSync` helper with retry+backoff in `test/test-utils.ts`. |

When upstream merges these (or equivalents), rebase/merge `upstream/main` and drop the locally-redundant patches.

## Quick orientation

- **TypeScript source** in `src/`, compiled to `dist/` by `tsc && esbuild`. **Both are committed.**
- **CLI entry points** in `cli/` (Node.js wrappers — no bash).
- **MCP server** is `dist/mcp-server.js`, launched by `cli/mcp-server-wrapper.js` from the plugin manifest.
- **Tests** in `test/` via vitest (38 files, 210 tests — counts verified 2026-08-08).
- **Generated files** in `dist/` AND `src/version.ts`. The latter is gitignored; never edit it.
- **`package-lock.json` is committed** — CI uses `npm ci` + `npm audit --audit-level=critical`.

```
src/
  embeddings.ts          # encoder pipeline; query/exchange embedders
  embedding-migration.ts # version constant + lock + batch migration
  search.ts              # vector + text search; multi-concept aggregation
  indexer.ts             # incremental index from sources to vec_exchanges
  sync.ts / sync-cli.ts  # source→archive copy + index, with reentrancy guard
  summarizer.ts          # Claude Agent SDK calls; persistSession: false guard
  db.ts                  # schema + migrations (cascade + embedding_version)
  paths.ts               # config/index/archive directory resolution
  parser.ts              # JSONL transcript → exchanges (cross-platform path-aware as of fork)
  mcp-server.ts          # MCP tool surface (search, read) — read is archive-confined as of fork
  version.ts             # GENERATED — do not edit

cli/
  episodic-memory.js     # umbrella CLI dispatcher
  mcp-server-wrapper.js  # ensures deps are installed (sentinel check as of fork)
  *.js                   # subcommand entry points

scripts/
  bump-version.sh        # version bumper with drift audit
  generate-version.js    # writes src/version.ts from package.json
  scrub-fixtures.sh      # PII-scrubs test fixtures (BSD/macOS sed only)

test/
  test-utils.ts          # createTestDb, safeRmSync (fork-added), suppressConsole, fixtures
  *.test.ts              # 35 test files
  fixtures/              # JSONL conversation fixtures

docs/
  roadmap/               # see docs/roadmap/README.md
  ...

hooks/hooks.json         # SessionStart: command "node ${PLUGIN_ROOT}/cli/episodic-memory.js sync --background"
agents/                  # agents/search-conversations.md
skills/                  # skills/remembering-conversations/{SKILL.md,MCP-TOOLS.md}
prompts/                 # prompts/search-agent.md
```

## Build, test, release commands

```bash
npm test          # full suite; runs prebuild step that generates src/version.ts
npm run build     # tsc + esbuild bundle into dist/mcp-server.js
npm run generate-version   # writes src/version.ts from package.json
```

The `prebuild` and `pretest` hooks both regenerate `src/version.ts`. After
source changes that touch the MCP server or any imported module, run
`npm run build` so `dist/` reflects source. **Commit `dist/` alongside `src/`** —
CI doesn't rebuild for you.

### Current test state

- **Full suite: 187/187 pass on Windows**, reliably. The former `integration.test.ts` / `verify.test.ts` cold-embedding timeout flakes were fixed 2026-06-23: the embedder is pre-warmed once per worker in `beforeAll`, `vitest.config.ts` sets `hookTimeout: 30000`, and the repair re-index test gets 60s. If you see a fresh timeout flake, suspect a new embedding-heavy hook without warm-up rather than the old cold-start cause.
- Run on Windows: expect ~75s wall-clock for the full suite.
- Run a single test: `npx vitest run test/<file>.test.ts`. Much faster, cleaner output.

## Critical gotchas (read before editing)

### 1. stdio MCP servers MUST log to stderr only

stdout is reserved for JSON-RPC. **Any `console.log` reachable from the MCP server crashes the protocol.** The fork already fixed the 5 `console.log` calls in `db.ts` migrations. When adding new logging:

- ✅ `console.error('...')`
- ✅ `process.stderr.write('...\n')`
- ❌ `console.log(...)` — corrupts protocol
- ❌ `process.stdout.write(...)` — corrupts protocol

This applies to **every module reachable from `mcp-server.ts`**. Current reachable surface: `search.ts`, `show.ts`, `db.ts`, `paths.ts`, `embeddings.ts`, `parser.ts`, `version.ts`. Modules used only by CLI files (`indexer.ts`, `sync.ts`, etc.) are safe to use `console.log` in.

### 2. Windows path separators

Always use `path.join`, `path.dirname`, `path.basename`, `path.sep` — never split or join paths on a literal `/` or `\\`. The fork already fixed `parser.ts:540`; future code should match.

When matching paths in tests or fixtures, normalize both sides:
```ts
expect(path.normalize(actual)).toBe(path.normalize(expected));
```

### 3. `dist/` is committed — edit src/, build, commit both

Hand-edits to `dist/` get clobbered by `npm run build`. Always edit `src/`, then `npm run build`, then commit both together.

When committing dist/, **only stage files with real content changes** — `tsc` regenerates with native line endings on each platform, producing many "modified" files that are line-ending-only diffs. On Windows, expect 40+ dist files to show as modified after a build but only ~5 have real content. Stage explicitly by name, not by `git add dist/`.

### 4. The summarizer recursion guard (#87)

`summarizer.ts` calls the Claude Agent SDK's `query()`, which spawns a Claude subprocess that fires `SessionStart` hooks. Our `SessionStart` hook runs `sync --background`, which calls the summarizer. That loop fans out hundreds of processes within seconds.

The fix:
- `getApiEnv()` always sets `EPISODIC_MEMORY_SUMMARIZER_GUARD=1` in the env it returns to the SDK
- `sync-cli.ts` checks `shouldSkipReentrantSync()` **before importing the heavy native stack** and exits silently when the guard is set

The guard lives in its own dependency-free module, `src/reentrancy.ts` (`SUMMARIZER_GUARD_ENV` + `shouldSkipReentrantSync`), re-exported from `summarizer.ts` for back-compat. It is checked *first* in `sync-cli.ts`; the heavy modules (`db.js` → better-sqlite3, `embeddings.js`/`embedding-migration.js` → transformers) are imported lazily via `await import()` only when the CLI is actually going to do work. Keep it that way — moving any heavy module back to a top-level static import makes every guarded reentrant subprocess pay a multi-second load just to bail.

**Anything new that spawns a Claude subprocess via the SDK must inherit this guard.** Nothing should run `sync --background` without checking the guard first. Test with `test/sync-cli-reentrancy.test.ts` / `test/reentrancy.test.ts` if you change the spawn path.

### 5. Embedding migration

The `exchanges.embedding_version` column tracks which encoder produced each row's vector. New code stamps `EMBEDDING_VERSION` (in `src/embedding-migration.ts`); old rows from earlier installs default to 0. The sync flow re-embeds stale rows in batches behind a lock at `~/.config/superpowers/conversation-index/.embedding-migration.lock`.

**If you change anything in the embedding pipeline** (model, dtype, prefix, pooling, normalization, truncation), **bump `EMBEDDING_VERSION`**. That triggers automatic re-embedding for everyone on upgrade. Don't change pipeline behavior silently — search results would degrade against indexed vectors from the old pipeline.

### 6. Test isolation

Tests use `mkdtempSync`, set `TEST_DB_PATH`/`TEST_PROJECTS_DIR`/`EPISODIC_MEMORY_CONFIG_DIR` per-test, and clean up in `afterEach`. Don't reach for the real `~/.config/superpowers/`. The `test-utils.ts` helpers cover the common patterns. **Use `safeRmSync` (not raw `fs.rmSync`)** in afterEach for directories holding SQLite WAL files — Windows EPERM race documented in [[feedback_stdio_mcp_logger_stderr]].

### 7. MCP failure-cache bug

Claude Code's plugin loader caches MCP failures keyed on config-hash. Once a server fails to start, `/reload-plugins` silently skips it forever. To force a retry, change the env in `.mcp.json` (a `_RETRY` field with a unique timestamp works). Documented at [[feedback_claude_code_mcp_failure_cache]] and exercised during the mcp-host troubleshooting on 2026-05-18.

The fork's plugin uses `cwd: '.'` and a fixed command — if a fresh install fails, it's the plugin bug, not the cache bug.

## MCP tool surface

The fork exposes 2 MCP tools (same as upstream, but with the fork's safety hardening on `read`):

### `search`

Vector + text search across indexed conversations.

Inputs (Zod-validated):
- `query`: string (required) — natural-language search
- `mode`: `'vector'` | `'text'` | `'both'` (default: `'both'`)
- `limit`: number (default: 10, max: 100)
- `project`, `session_id`, `git_branch`: optional metadata filters
- `after`, `before`: ISO date strings `YYYY-MM-DD`
- `responseFormat`: `'markdown'` | `'json'`
- `concepts`: string[] — for multi-concept aggregation

Output: list of `ConversationExchange` rows (id, project, timestamp, user/assistant message, archive_path, line_start, line_end, plus metadata).

### `read`

Read a specific JSONL conversation file by path.

Inputs:
- `path`: string (required) — **must resolve inside `getArchiveDir()` and end in `.jsonl`** (fork hardening)
- `startLine`, `endLine`: optional line range

Output: markdown-formatted conversation.

**Fork security model:** the `path` parameter is intended to be filled with `archive_path` values returned by `search()`. Direct calls with arbitrary paths now error. If you need to read a JSONL outside the archive, copy it in first (or use `fs.readFileSync` from a CLI/script context).

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
10. **push** — direct push to fork's `main`
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
- `RLM` skill for whole-codebase audits (this fork's first one happened 2026-05-18; see `CHANGELOG.md`)
- `honest-claude` skill to vet every RLM finding by reading the actual file before recommending or committing

## Common debugging recipes

### "× failed" in `/mcp`

Most common cause on a fresh install: the wrapper's `npm install` didn't fully populate `node_modules`. **The fork's sentinel check should catch this**, but if it doesn't:

```bash
cd ~/.claude/plugins/cache/<marketplace>/episodic-memory/<version>
npm install --no-audit --no-fund
# If transformers errors on onnxruntime-common:
npm install --no-save onnxruntime-common@1.24.3
```

Then `/reload-plugins`. If still failing, you're hitting Claude Code's per-session failure cache — see gotcha #7.

### Probing the server in isolation

```bash
cd ~/.claude/plugins/cache/<marketplace>/episodic-memory/<version>
echo '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"probe","version":"0.0"}}}' \
  | node ./cli/mcp-server-wrapper.js
```

Expected response on stdout (single JSON line):
```json
{"result":{"protocolVersion":"2024-11-05","capabilities":{"tools":{}},"serverInfo":{"name":"episodic-memory","version":"1.4.0"}},"jsonrpc":"2.0","id":1}
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

## Upstream sync workflow

```bash
cd ~/Dropbox/Github/episodic-memory
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
1. `npm install` (deps may have changed)
2. `npm run build` (regenerate dist/)
3. `npm test` (verify nothing regressed)
4. Update `CHANGELOG.md` and `todo.md` with the upstream merge note

**If obra merges any of the fork patches** (track at https://github.com/obra/episodic-memory/issues/95), drop the locally-redundant patch from this fork by reverting that specific change and rebuilding.

## Release engineering (only if shipping a fork-only npm version)

This fork is **not** currently published to npm — installs flow through Claude Code's plugin marketplace, which clones the GitHub repo. If you ever want to publish:

1. `npm test` (full suite must pass)
2. `npm run build` (commits `dist/` need to be fresh)
3. `./scripts/bump-version.sh X.Y.Z-fork.N` (versioned to avoid colliding with upstream)
4. CHANGELOG entry under the new version header
5. `git commit -m "Release vX.Y.Z-fork.N: <one-line>"`
6. `git tag -a vX.Y.Z-fork.N -m "Release vX.Y.Z-fork.N"`
7. `git push origin main && git push origin vX.Y.Z-fork.N`
8. `npm publish --ignore-scripts --access public` (`--ignore-scripts` to skip the slow `prepublishOnly` on Windows — the suite is verified at step 1)

⚠️ Daniel pasted his `NPM_TOKEN` in a transcript on 2026-05-18; **rotate before any publish** at https://www.npmjs.com/settings/danielsimonjr/tokens.

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

…stop and use `brainstorming` → `writing-plans` first. These are load-bearing
contracts; subtle drift breaks downstream caches and indexed data.
