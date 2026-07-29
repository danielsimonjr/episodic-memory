# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed
- **Added `index prune`** ([#4](https://github.com/danielsimonjr/episodic-memory/issues/4)). `exclude.txt` / `CONVERSATION_SEARCH_EXCLUDE_PROJECTS` are consulted only while walking source directories at index time (`indexer.ts:62-63`), so adding a project to the exclude list stopped new rows appearing but left everything already indexed in place and searchable, with no supported way to remove it. That is the wrong moment for the feature to be usable: nobody adds an exclusion *before* the noisy project exists, so users reach for it only after something has flooded the index — the point at which it can no longer help. `index prune --excluded` removes rows for every project in the exclude list; `index prune --project <name>` targets one; `--dry-run` reports counts and reclaimable bytes without touching anything. Deletion order respects the `tool_calls` foreign key (see #81), and vectors are removed one id at a time because vec0 virtual tables support neither JOIN nor subquery in `DELETE` — this requires the `sqlite-vec` extension to be loaded on the connection, which `initDatabase()` does. A client without it (Python's stock `sqlite3`, for instance) silently skips the vector table and leaves orphans behind. An empty project list is an explicit no-op rather than an `IN ()` clause that would be a syntax error at best and match everything at worst. Prune reminds you to run `index vacuum` afterwards, since deleting rows alone returns no disk space.
- **Added `index vacuum`** ([#3](https://github.com/danielsimonjr/episodic-memory/issues/3)). There was no `VACUUM` anywhere in the codebase — nor any retention or TTL — so the index only ever grew. SQLite does not return freed pages to the filesystem on its own, which meant deleting rows reclaimed no disk space at all and read to users as "deleting didn't work". Verified: a database holding 51.8 MB of deleted rows stayed at 51.8 MB until vacuumed, then dropped to 0.1 MB. The command reports the reclaimable free-page total before running so the benefit is visible up front, and warns that VACUUM needs temporary free space roughly equal to the database size. When there is nothing to reclaim it says so plainly rather than printing a negative figure — VACUUM also checkpoints the WAL into the main file, so a nearly-empty database can legitimately finish slightly larger.
- **Machine-generated prompt payload is no longer indexed verbatim as conversation** ([#2](https://github.com/danielsimonjr/episodic-memory/issues/2)). Third-party plugins that summarize conversations spawn a subagent whose prompt embeds the entire conversation being summarized. Those subagent sessions are ordinary transcripts, so they were indexed like any other chat — turning a single "user message" into megabytes. The existing `EXCLUSION_MARKERS` defence in `sync.ts` does not help here: it is *cooperative*, matching only agents that emit a known marker, and third-party summarizers emit none. Measured on a real install: median `user_message` **1,636 bytes**, largest **3,109,374 bytes**, and 1,301 such rows accounted for **2.53 GB — 97.2% of a 3.04 GB database**. For scale, every assistant reply ever recorded totalled 0.03 GB. `insertExchange()` now caps both message columns at `MAX_INDEXED_MESSAGE_BYTES` (default 256 KB, ~150x the median, override via `EPISODIC_MEMORY_MAX_MESSAGE_BYTES`; 0 disables). The head of the message is kept so the row stays searchable and its source identifiable, and a `[truncated by episodic-memory: …]` notice records what was dropped rather than silently discarding it. Truncation is idempotent, so re-indexing never stacks notices. Applied in `insertExchange()` because that is the single choke point every indexer path goes through, so the size invariant holds regardless of caller.

  Note this caps what is *stored*; the oversized text is still embedded before insert. Moving the cap earlier, into the parser, would also avoid that wasted embedding work — worth doing, but it is a larger change across four construction sites and is left as a follow-up.

### Security
- **Enforced patched-version floors for vulnerable dependencies.** `npm audit` reported a CRITICAL in `vitest` (`<3.2.6`, GHSA-5xrq-8626-4rwp) plus HIGH advisories in transitive `hono` (≤4.12.24 — `serve-static` path traversal, CORS reflection, cookie injection, etc.) and `protobufjs` (≤7.6.2). Because this repo intentionally gitignores `package-lock.json`, the fix is encoded in `package.json`: the `vitest` devDependency floor is raised `^3.2.4 → ^3.2.6` (the old range still permitted the vulnerable 3.2.4/3.2.5), and `overrides` pin `hono ^4.12.27` (via `@modelcontextprotocol/sdk`) and `protobufjs ^7.6.4` (via `@huggingface/transformers`). `npm audit` is now 0; the full 188-test suite still passes.
- Hardened the `read` MCP tool against arbitrary local file reads. Previously the tool accepted any absolute path with only an `existsSync` check, so a prompt-injection attack could trick an LLM into reading any file the Node process had access to (e.g., `~/.ssh/id_rsa`). The tool now requires the resolved path to lie inside the configured archive directory and end in `.jsonl`. All legitimate paths flow from `search()` results, whose `archive_path` values are always constructed as `path.join(projectArchive, file)` rooted in `getArchiveDir()`, so this is non-breaking for normal use.

### Fixed
- **The background sync worker no longer starves the interactive session that spawned it.** `sync --background` spawns a *detached* worker which then boots transformers.js and embeds exchanges on the CPU; onnxruntime saturates every core it is given. Because the worker inherited **normal** priority, it competed on equal terms with the foreground — including plugin MCP servers, which must complete a handshake inside Claude Code's 30s startup budget. Observed 2026-07-13: a background sync held ~5 of 12 cores for 10+ minutes, the machine sat at 100% CPU, and MCP servers timed out at 30s (`chrome-devtools` among them) — a "plugin is broken" symptom whose actual cause was CPU starvation. The detached worker is now tagged via `EPISODIC_MEMORY_BACKGROUND_WORKER` and drops itself to **below-normal** priority *before* the heavy imports load, so the OS preempts it for interactive work. The sync still completes; it just gets out of the way. (The earlier orphan-storm fix bounded how *many* workers spawn — this bounds what a single legitimate worker is allowed to cost.)
- **`repairIndex` now indexes a conversation even when summary generation fails.** The re-index loop generated a summary (a Claude Agent SDK call) *before* inserting the exchanges, and a summarizer throw (unauthenticated environment, timeout, SDK error) fell through to the loop's outer `catch` — so the file was never re-indexed, `last_indexed` was never updated, and the file stayed permanently "outdated," re-attempted (and re-failing) on every run. Summary generation is now best-effort (its own `try/catch`): a summary failure logs a warning and the exchanges + embeddings are still indexed. The summary is auxiliary; indexing is the point.
- **`verifyIndex` no longer reports a just-repaired file as still outdated on fast machines.** The outdated check compared `fs.statSync(path).mtimeMs` — a float carrying sub-millisecond precision (e.g. `1234.9`) — against the stored `last_indexed`, an *integer* ms epoch (`Date.now()`), using a strict `>`. So `1234.9 > 1234` flagged a file as modified even when the re-index landed in the same integer millisecond as its mtime. On fast runners (Linux CI) this made `repairIndex` appear to do nothing (`verifyIndex().outdated` stayed non-empty after repair) and failed `verify.test.ts`; on slower Windows the ms gap hid it. The comparison now floors `mtimeMs` to the integer-ms storage granularity (`Math.floor(fileStat.mtimeMs) > lastIndexed`) — sub-ms changes are undetectable at this resolution anyway, and genuine later edits (>1 ms) are still detected.
- **The summarizer subprocess no longer boots the user's whole MCP-server fleet (the process cascade behind the wedged-orphan storm).** Every summary spawns a Claude Agent SDK subprocess; because `buildSummarizerQueryOptions` didn't set `settingSources`, the SDK loaded the user's filesystem settings, which started every configured MCP server *and* fired SessionStart hooks inside each summary subprocess. A single wedged summary subprocess was observed to have spawned a tree of ~14 children, each with their own children — saturating the CPU. The summarizer now runs in isolation (`settingSources: []`, `mcpServers: {}`): no MCP servers, no hooks, no tools. Authentication is unaffected (it comes from the environment, not filesystem settings).
- **A stalled summarizer SDK call can no longer wedge the sync forever.** `callClaude` awaited the SDK result with no timeout, so a subprocess that never returned blocked the background sync indefinitely — the direct cause of the orphaned `sync-cli` processes that pegged CPU for hours. Each call is now bounded by an `AbortController` that fires after `EPISODIC_MEMORY_API_TIMEOUT_MS` (default 120s), aborting the subprocess and throwing a clear timeout error the caller records. The same no-timeout hazard in the Codex `--version` probe (`readCommandOutput`) is fixed too.
- **Overlapping background syncs no longer stack.** Every SessionStart (startup/resume/compact, across multiple Claude sessions) fired `sync --background` with nothing preventing concurrency, so multiple syncs ran at once — each loading the transformer and fanning out summarizer subprocesses. A new cross-process file lock (`.sync.lock`, PID-liveness + mtime-age stale recovery, atomic steal) serializes syncs: a second worker bails instantly. The lock is checked before the heavy imports load, so a locked-out worker exits in milliseconds.
- **Conversations that deterministically fail to summarize no longer re-queue forever.** When `summarizeConversation` threw, no sentinel was written, so the file was re-attempted on every subsequent sync — the "backlog never drains" class. After `EPISODIC_MEMORY_MAX_SUMMARY_ATTEMPTS` failures (default 3, tracked in a `-summary.failed` sidecar) the conversation gets an empty `-summary.txt` sentinel and stops being re-queued. A later success clears the failure record.
- **The resume-based summarization path was removed entirely** (superseding the earlier "skip resume when not resumable" change). Resume always failed from the background-sync context — the Agent SDK resolves a session by the subprocess's CWD-derived project directory (the plugin dir), not the user's project — so every archived conversation spawned a doomed resume subprocess that errored and fell back to transcript text anyway. `summarizeConversation` now always summarizes the transcript text it already holds.
- **The summary cap is now a single configurable per-sync budget.** It was applied per source directory (so the real cap was 10 × number of source dirs) and wasn't configurable. It's now one `EPISODIC_MEMORY_SUMMARY_LIMIT` budget (default 10) shared across all source dirs.
- The SessionStart sync hook now exits in ~0.5s (was ~3.5s warm, and >5s on a cold disk) when it detects it is a summarizer-spawned reentrant subprocess. The reentrancy guard (#87) was checked only *after* the heavy native modules were statically imported — `better-sqlite3` (via `db.js`) and the transformer/onnx stack (via `embeddings.js` / `embedding-migration.js`) — so every guarded subprocess loaded the full stack just to bail, wasting seconds of CPU/disk per spawn and intermittently timing out the reentrancy integration test on cold disks. The guard now lives in a dependency-free module (`src/reentrancy.ts`) and is checked first; `sync-cli` imports the heavy modules lazily only when it is actually going to do work.
- **Robustness hardening surfaced during the orphan-storm investigation** (each a latent hang, leak, or deadlock): the Codex app-server path rejects in-flight requests and guards stdin writes when the child dies (no dangling promises / uncaught EPIPE); hierarchical summarization caps its chunk count so a huge conversation can't fan out unbounded sequential SDK calls; the sync log rotates at 5 MB (`.1` backup) instead of growing without bound; the indexing DB handle is closed in a `finally` so a parse error can't leak it (and its WAL) into a "database is locked" on the next run; `initDatabase` sets `busy_timeout` so concurrent writers wait instead of failing with `SQLITE_BUSY`; `copyIfNewer` uses a unique temp suffix and cleans it up on a failed rename (no orphaned `*.tmp.*` files); transcripts whose filename has no session UUID are still summarized instead of silently dropped; the background-sync launcher closes its inherited log file descriptor; and the MCP server wrapper polls parent liveness so an abnormal Claude exit can't orphan the server holding the DB lock.
- Background sync no longer burns CPU and spawns doomed subprocesses forever on conversations whose original session has been archived. The summarizer resumes the original session to summarize it cheaply, but resuming a session that no longer exists in `~/.claude/projects/` makes the Agent SDK return an error result (`subtype: 'error_during_execution'`, no `result` field). `callClaude` returned that `undefined`, and `extractSummary` crashed with the cryptic `Cannot read properties of undefined (reading 'match')`. The conversation was never marked summarized, so every subsequent sync re-attempted it — spawning a fresh Claude subprocess that failed the same way — and the backlog never drained. Now: (1) `callClaude` throws a clear, actionable error when the SDK signals an error instead of returning `undefined`; (2) `extractSummary` guards against non-string input; and (3) `summarizeConversation` falls back to summarizing the transcript text it already has when resume fails, so archived conversations summarize successfully and the backlog drains. This is the same "backlog never drains" failure mode as the 1.4.1 empty-conversation fix, but with a different root cause (un-resumable sessions rather than zero-content files).
- On Windows, conversation parsing now extracts the correct project name. Previously `parseConversationFile` split the path on `/` only, so `C:\Users\...\test\fixtures\short.jsonl` produced `project = 'unknown'` instead of `'fixtures'`. All conversations indexed on a Windows machine had `project = 'unknown'` in the database. The fix uses `path.basename(path.dirname(filePath))` which handles both separators.
- Schema-migration log lines no longer corrupt the MCP stdio protocol. The five `console.log` calls in `migrateSchema` and `migrateToolCallsCascade` fire to stdout when migrations run during MCP server startup, and stdout on a stdio MCP server is reserved for JSON-RPC. Switched them to `console.error` (stderr). Users upgrading to a schema-changing version no longer get a `× failed` server with no obvious symptom.
- Test suite is no longer flaky on cold/contended machines. `integration.test.ts` and `verify.test.ts` intermittently timed out paying the transformer model's cold load (and bulk embedding of multi-exchange fixtures) inside per-test budgets. The model is now pre-warmed once per worker in `beforeAll`, `hookTimeout` is set to 30s (matching `testTimeout`) for the embedding-heavy `beforeEach` hooks, and the repair re-index test gets 60s. Two consecutive full-suite runs pass 173/173.
- Test cleanup is more resilient on Windows. `fs.rmSync` on a directory containing recently-closed SQLite WAL files (`*.db-wal`, `*.db-shm`) intermittently throws `EPERM` until the OS releases the handle. Added a shared `safeRmSync` helper in `test/test-utils.ts` with bounded retries and exponential backoff (20-320ms), and wired it into `db.test.ts`, `verify.test.ts`, and `integration.test.ts`.

### Earlier in this Unreleased cycle
- The plugin now loads on a freshly-installed Windows machine without a manual `npm install` recovery step. Two failure modes are addressed: (1) the launcher's "is `node_modules` healthy" check used to look only at the folder's existence, so a partial extract that left `better-sqlite3` missing its native binding slipped through silently — it now verifies a list of sentinel dep files and re-runs install if any are missing; (2) `@huggingface/transformers@4.2.0` directly imports `onnxruntime-common` in its ESM bundle without declaring it as a direct dependency, and npm doesn't hoist it to top-level because `onnxruntime-node` and `onnxruntime-web` pull conflicting versions — `onnxruntime-common` is now a direct top-level dep so Node's ESM resolver can find the bare import. Symptom in both cases was `× failed` in `/mcp` with `ERR_MODULE_NOT_FOUND` on import.

## [1.4.1] - 2026-05-17

### Fixed
- Sync no longer gets stuck on conversations with no real content. Previously, files with only metadata or stub records re-queued for summarization on every run. Once ten of them piled up at the head of the queue, real conversations behind them stopped getting summarized at all. Now those files are marked as done the first time they're skipped, and the backlog drains. Thanks to @minyek for the fix.

## [1.4.0] - 2026-05-13

### Changed
- The `remembering-conversations` skill now triggers reliably for personal-fact lookups and other small questions that previously slipped past it. Tested against fresh sessions asking a personal-fact question, the previous description fired the skill 0/5 trials; the new description fires 3/5.

### Removed
- The `/search-conversations` slash command. Reference past work in natural conversation instead — the `remembering-conversations` skill dispatches the `search-conversations` agent automatically when recall is needed.

## [1.3.1] - 2026-05-13

### Fixed
- Recall skills now trigger when an agent needs to remember anything learned from prior Claude Code or Codex conversations, including decisions, patterns, solutions, pitfalls, workflows, project context, and lessons from similar work.
- Search-agent and slash-command descriptions now describe broad recall situations instead of narrowing discovery to explicit user requests or personal facts.

## [1.3.0] - 2026-05-13

### Added
- Native Codex plugin support with `.codex-plugin/plugin.json`, Codex MCP configuration, plugin hook packaging, and a local development marketplace entry.
- Codex rollout transcript parsing, display, archiving, indexing, and cross-harness search across Claude Code and Codex conversations.
- Codex-native summarization through `codex app-server` ephemeral `thread/fork`, with transcript-text fallback when Codex summarization is unavailable.
- `episodic-memory doctor codex` for checking Codex version, plugin features, MCP registration, hook trust, transcript directory, database, and sync log paths.
- Opt-in live Codex and Claude E2E scripts that verify archive, summary, index, and MCP recall behavior.

### Changed
- Recall skill instructions and MCP tool documentation now describe Claude Code and Codex usage, including direct MCP search/read guidance in Codex.
- CLI help, README setup, and architecture documentation now describe Claude Code plus Codex support.

### Fixed
- Codex hook trust diagnostics now report when the Episodic Memory hook is already trusted instead of always suggesting `/hooks`.
- Codex HTML transcript rendering now escapes raw HTML from transcript content before rendering.
- Codex `local_shell_call_output` items are now paired with local shell tool calls during parsing and included in rendered transcript output.

## [1.2.0] - 2026-05-03

### Better search results

This release upgrades the embedding model used for semantic search. On a 17,000-exchange retrieval test built from real production data, the new model puts the right answer at rank 1 about **53% of the time, up from 47%**. Top-10 accuracy improves from 68% to 75%.

The new model is `bge-small-en-v1.5` (BAAI), replacing `all-MiniLM-L6-v2`. Both produce 384-dimensional embeddings, so storage is unchanged.

### Automatic migration

Existing indexes upgrade themselves in the background. After you install 1.2.0, each `episodic-memory sync` re-embeds up to 500 stored exchanges with the new model. Claude Code triggers a sync at every session start, so most indexes finish migrating after roughly 60 sync runs — a few days of normal use.

During sync you'll see a line like this on stderr:

    episodic-memory: re-embedding batch of 500 (29569 stale total)...

Search keeps working throughout. The index holds a mix of old and new embeddings until migration finishes; ranking is slightly noisier but never broken.

To finish faster, run a sync with a larger batch:

    EPISODIC_MEMORY_MIGRATION_BATCH=5000 episodic-memory sync

That takes about a minute per call on a recent Mac.

If two syncs run at once, only one re-embeds; the other skips its migration step. A crash mid-batch leaves the unfinished rows tagged for migration, and the next sync picks up where the previous one stopped.

### Other notes

- **First sync after upgrade** downloads a new 34 MB model file.
- **Rollback to 1.1.x is safe.** Search still works against a partially-migrated index.
- **Resolves #82** (ONNX runtime crash on Node 23 and earlier) as a side effect of the underlying library upgrade.

## [1.1.2] - 2026-05-03

### Fixed
- **Critical: recursive process explosion from auto-sync** (#87, #88, thanks @kaankoken and @materemias for the diagnosis):
  - The `persistSession: false` fix in 1.1.0 (#83) prevented the SDK-spawned Claude subprocess from *saving* its session JSONL, but did not stop the subprocess from *firing the SessionStart hook*. That re-ran `episodic-memory sync --background`, which re-summarized, which spawned another Claude subprocess, which fired the hook again — fanning out hundreds of detached processes, saturating CPU, and burning API quota.
  - Added a reentrancy guard env var `EPISODIC_MEMORY_SUMMARIZER_GUARD`, set when calling the SDK's `query()` and inherited by the spawned subprocess. The `sync-cli` entry point checks the guard at startup and exits silently when it's set, breaking the recursive cascade at its only feasible point.
  - Coverage: unit tests for `getApiEnv()` (always sets the guard) and `shouldSkipReentrantSync()`, plus an integration test that spawns `dist/sync-cli.js` with the guard env and asserts a clean exit without doing work.
  - Anyone affected by the cascade should update to 1.1.2 immediately. If 1.1.0 or 1.1.1 had been spawning processes, kill any lingering `episodic-memory` and `claude-agent-sdk` children before restarting Claude Code.

## [1.1.1] - 2026-05-03

### Fixed
- **MCP server now reports the actual plugin version** in its protocol handshake instead of the long-stale hardcoded `1.0.0`. Inspector tools and any client logging the server identity will now see the real version.

### Changed
- **Single source of truth for version numbers.** `package.json` is the source; `src/version.ts` is generated from it at prebuild/pretest time and is referenced by `mcp-server.ts`. Source code can no longer drift from the declared package version.
- **Drift test for manifest files.** A new `test/version-consistency.test.ts` asserts `package.json`, `.claude-plugin/plugin.json`, and `.claude-plugin/marketplace.json` all agree. CI fails if anyone bumps one without the others.
- **`scripts/bump-version.sh` + `.version-bump.json`** for one-command version bumps with built-in audit (greps the repo for stale version strings in undeclared files). Run `./scripts/bump-version.sh X.Y.Z` to update all declared files; `--check` reports current state, `--audit` scans for stragglers.

## [1.1.0] - 2026-05-02

### Added
- **Search metadata filters** (#63, thanks @jwk2601 for the design): `--project`, `--session-id`, and `--git-branch` flags scope results by exact-match project name, session ID, or git branch. Available on the CLI and the MCP `search` tool. Filter values bind as positional SQL parameters; the existing `--after`/`--before` time filters were converted from string interpolation to bound parameters in the same change.
- **API configuration env vars for summarization** (#37, thanks @techjoec):
  - `EPISODIC_MEMORY_API_MODEL` — override the summarizer model (default: haiku)
  - `EPISODIC_MEMORY_API_MODEL_FALLBACK` — fallback model on errors (default: sonnet)
  - `EPISODIC_MEMORY_API_BASE_URL` — custom Anthropic endpoint
  - `EPISODIC_MEMORY_API_TOKEN` — auth token for custom endpoint
  - `EPISODIC_MEMORY_API_TIMEOUT_MS` — request timeout

### Changed
- **Bumped `@anthropic-ai/claude-agent-sdk` to 0.2.x** (transitively requires zod 4). Required for the `persistSession` option used by the #83 fix.
- **`tool_calls` schema now uses `ON DELETE CASCADE`** (#81). Fresh databases create the table with cascade; existing databases get a one-time migration that recreates `tool_calls` with cascade and drops any orphaned rows. The migration is idempotent and runs only when the schema lacks `ON DELETE CASCADE`.
- **`exclude.txt` matches nested directory names** (#80, thanks @rohitgehe05 for the diagnosis): adding `subagents` now also skips `<project>/<session>/subagents/agent-*.jsonl` instead of only matching top-level project directories.

### Fixed
- **Indexer skipped appended exchanges** (#84, thanks @jamster for the diagnosis and detection script): the `COUNT(*) > 0` skip was replaced with a `MAX(line_end)` high-water mark, so transcripts that grow after their first index pass now pick up their tail. Resumed sessions and SessionStart syncs that race the still-running session no longer silently lose the trailing content.
- **Search similarity scores were wrong** (#55, thanks @gmax111): `1 - row.distance` was treating L2 distance as cosine distance. For unit-normalized embeddings the correct conversion is `1 - d²/2`. Result ordering was already correct (the formula was monotonic in distance), so this is a display/aggregation correction, not a ranking change.
- **Summarizer session pollution** (#83, thanks @benseeley for the detailed reproduction): `persistSession: false` is now passed to the SDK, so summarization no longer creates fake session JSONLs in `~/.claude/projects/<cwd-slug>/`.
- **`deleteExchange` FK crash** (#81, thanks @rohitgehe05): `index --repair` no longer fails with `SQLITE_CONSTRAINT_FOREIGNKEY` on exchanges that have associated tool_calls.
- **Windows hook fails on home directories with spaces** (#75, thanks @phantomsecurityandfire and @officialasishkumar): the SessionStart hook command now quotes `${CLAUDE_PLUGIN_ROOT}`.
- **MCP install fails with `ETARGET` on stale npm cache** (#76, thanks @DarkbyteAT and @mvanhorn): removed `--prefer-offline` from the wrapper's `npm install` invocation.
- **MCP protocol corruption from embedding model output** (#48): the embedding model's stdout is now redirected to stderr.
- **Orphaned MCP processes** (#54): added SIGHUP handler and stdin-close detection to the wrapper.
- **`exclude.txt` ignored at sync time** (#38): now honored by sync and verify commands.
- **Bundled file-discovery and path fixes** (#42, #50, #57, #62, #68, #70, #72): sidechain filtering in search, SessionStart `clear` matcher, `CLAUDE_CONFIG_DIR` support, recursive subagent file discovery, support for both `~/.claude/projects` and `~/.claude/transcripts`, and explicit surfacing of summarization failures.

### Documentation
- Fix npm install instructions to use the GitHub source (#71).

## [1.0.15] - 2025-12-17

### Changed
- **Stop shipping package-lock.json**: Removed from git tracking so npm generates platform-appropriate lockfile on install
- **Remove file deletion from MCP wrapper**: No longer deletes package-lock.json on first run (unnecessary without shipped lockfile)

## [1.0.14] - 2025-12-16

### Fixed
- **Windows spawn ENOENT error**: Add `shell` option for npx commands on Windows (#36, thanks @andrewcchoi!)
  - On Windows, npx is a .cmd file requiring `shell: true` for spawn() to work
  - Applied fix to `cli/episodic-memory.js` and `cli/index-conversations.js`
  - Resolves plugin initialization failures and silent SessionStart hook failures on Windows
- **Agent conversations polluting search index**: Add exclusion marker to summarizer prompts (#15, thanks @one1zero1one!)
  - Summarizer agent conversations are now properly excluded from indexing
  - Extracted marker to shared constant (`SUMMARIZER_CONTEXT_MARKER`) for maintainability
- **Background sync silently failing**: CLI now uses compiled JS instead of tsx at runtime (#25 root cause, thanks @stromseth for identifying!)
  - `--background` flag on sync command now works correctly
  - Fixes SessionStart hook auto-sync that was silently failing
- **Directory auto-creation**: Config directories are now created automatically (inspired by #18, thanks @gingerbeardman!)
  - `getSuperpowersDir()`, `getArchiveDir()`, `getIndexDir()` now ensure directories exist
  - Prevents errors on fresh installs where directories don't exist yet

### Changed
- **CLI uses compiled JavaScript**: Remove tsx from runtime path
  - All CLI commands now route through `dist/*.js` instead of `npx tsx src/*.ts`
  - Faster startup, lighter runtime dependencies
  - tsx is now dev-only (for tests and development)
  - Obsoletes PR #25 (background sync fix) by fixing root cause
- **CLI architecture cleanup**: Replace bash scripts with Node.js wrappers
  - All CLI entry points (`episodic-memory`, `index-conversations`, `search-conversations`, `mcp-server`) are now Node.js scripts
  - Eliminates bash dependency entirely for full cross-platform support (Windows, NixOS, etc.)
  - SessionStart hook now calls `node cli/episodic-memory.js` directly
  - Added `search-conversations.js` to complete Node.js CLI coverage
  - Obsoletes PRs #29 (pnpm workspace), #11 (env bash), and #17 (shebang fix)

## [1.0.13] - 2025-11-22

### Fixed
- **MCP server startup error**: Fix "Invalid or unexpected token" error when starting MCP server
  - Changed plugin.json to use `cli/mcp-server-wrapper.js` instead of bash script `cli/mcp-server`
  - MCP server configuration was pointing to bash script which was being executed with `node` command
  - Wrapper script properly handles Node.js execution and runs bundled `dist/mcp-server.js`

## [1.0.12] - 2025-11-22

### Changed
- **Skill triggering behavior**: Improved episodic memory skill to trigger at appropriate times
  - Changed from "ALWAYS USE THIS SKILL WHEN STARTING ANY KIND OF WORK" to contextual triggers
  - Now triggers when user asks for approach/decision after exploring code
  - Now triggers when stuck on complex problems after investigating
  - Now triggers for unfamiliar workflows or explicit historical references
  - Prevents premature memory searches before understanding current codebase
  - Empirically tested with subagents: 5/5 scenarios passed vs 3/5 with previous description

## [1.0.11] - 2025-11-20

### Fixed
- **Plugin Configuration**: Fix duplicate hooks file error in Claude Code
  - Remove duplicate `"hooks": "./hooks/hooks.json"` reference from plugin.json
  - Claude Code automatically loads hooks/hooks.json, so manifest should only reference additional hook files
  - Update MCP server reference from obsolete `mcp-server-wrapper.js` to direct `mcp-server` script

### Changed
- Simplified plugin.json configuration for cleaner Claude Code integration

## [1.0.10] - 2025-11-20

### Fixed
- **Search result formatting**: Prevent Claude's Read tool 256KB limit failures
  - Search results now include file metadata (size in KB, total line count)
  - Changed from verbose 3-line format to clean 1-line: "Lines 10-25 in /path/file.jsonl (295.7KB, 1247 lines)"
  - Removes prescriptive MCP tool instructions, trusting Claude to choose correct tool based on file size
  - Eliminates issue where episodic memory search triggered built-in Read tool instead of specialized MCP read tool

### Changed
- Enhanced `formatResults()` and `formatMultiConceptResults()` with async file metadata collection
- Added efficient streaming line counting and file size utilities
- Updated MCP server and CLI callers to handle async formatting functions

## [1.0.9] - 2025-10-31

### Removed
- **Dead code cleanup**: Removed obsolete bash script `cli/mcp-server-wrapper`
  - Eliminates duplicate wrapper implementations
  - Only Node.js cross-platform wrapper `mcp-server-wrapper.js` remains
  - Prevents confusion about which wrapper to use
  - Cleaner codebase with single MCP server entry point

### Changed
- Simplified MCP server architecture with single wrapper implementation
- Improved maintainability by removing redundant bash script

## [1.0.8] - 2025-10-31

### Fixed
- **Issue #7**: Fixed Windows support for MCP server provided in plugin
  - Replaced bash script `mcp-server-wrapper` with cross-platform Node.js version
  - MCP server now works on Windows with Claude Code native install
  - Resolves "No such file or directory" errors on Windows when using `/bin/bash`

### Changed
- MCP server wrapper now uses `node cli/mcp-server-wrapper.js` instead of bash script
- Cross-platform dependency installation with proper Windows npm.cmd handling
- Improved signal forwarding and process management in wrapper

### Added
- Cross-platform Node.js wrapper script for MCP server initialization
- Better error handling and messaging for missing dependencies
- Windows-compatible npm command detection (`npm.cmd` vs `npm`)

## [1.0.7] - 2025-10-31

### Fixed
- **Issue #10**: Fixed SessionStart hook configuration that prevented memory sync from running
  - Removed invalid `args` property from hook configuration
  - Added `async: true` and `--background` flag to prevent blocking Claude startup
- **Issue #5**: Fixed summary generation failure during sync command
  - Resolved confusion between archived conversation IDs and active session IDs
  - Sync now properly generates summaries for archived conversations
- **Issue #9**: Fixed better-sqlite3 Node.js version compatibility issues
  - Added postinstall script to automatically rebuild native modules
  - Resolves NODE_MODULE_VERSION mismatch errors on Node.js v25+
- **Issue #8**: Fixed version mismatch between git tags and marketplace.json
  - Synchronized plugin version metadata with release tags

### Added
- Background sync mode with `--background` flag for non-blocking operation
- Automatic native module rebuilding for cross-Node.js version compatibility
- Enhanced CLI help documentation with background mode usage examples

### Changed
- SessionStart hook now uses `episodic-memory sync --background` for instant startup
- Sync command forks to background process when `--background` flag is used
- Improved hook configuration follows Claude Code hook specification exactly
- Updated marketplace.json versions in both embedded and superpowers-marketplace locations

### Security
- Fixed potential process blocking during Claude Code startup
- Improved process detachment for background operations

## [1.0.6] - 2025-10-27

### Fixed
- **Issue #1**: Fixed Windows CLI execution failure by replacing bash scripts with cross-platform Node.js implementation
- **Issue #4**: Fixed sqlite-vec extension loading error on macOS ARM64 and Linux by adding `--external:sqlite-vec` to esbuild configuration
- Resolved "Loadable extension for sqlite-vec not found" error on affected platforms

### Added
- Cross-platform CLI support using Node.js instead of bash scripts
- Enhanced error handling with clear error messages and troubleshooting guidance
- Automatic dependency validation (npx, tsx) in CLI tools
- Proper symlink resolution for npm link and global installations

### Changed
- CLI entry points now use `.js` extension for universal compatibility
- Replaced `shell: true` spawn calls with direct spawn for improved security
- Updated build configuration to externalize sqlite-vec native module
- Improved process execution without shell interpretation to prevent command injection

### Security
- Removed shell dependencies from CLI execution
- Added input validation and protection against command injection vulnerabilities
- Safer process execution using direct spawn calls

## [1.0.5] - 2025-10-25

### Fixed
- MCP server wrapper now deletes package-lock.json before npm install to ensure platform-specific sqlite-vec packages are installed
- Resolves "Loadable extension for sqlite-vec not found" error on fresh plugin installs

### Changed
- Add package-lock.json to .gitignore to prevent cross-platform optional dependency issues
- Improve wrapper script to handle npm's platform-specific optional dependency installation behavior

## [1.0.4] - 2025-10-23

### Changed
- Strengthen agent and MCP tool descriptions to emphasize memory restoration
- Use empowering "this restores it" framing instead of deficit-focused language
- Make it crystal clear the tool provides cross-session memory and should be used before every task

## [1.0.3] - 2025-10-23

### Fixed
- MCP server now automatically installs npm dependencies on first startup via wrapper script
- Resolves "Cannot find module" errors for @modelcontextprotocol/sdk and native dependencies

### Added
- MCP server wrapper script (`cli/mcp-server-wrapper`) that auto-installs dependencies before starting
- esbuild bundling for MCP server to reduce dependency load time

### Changed
- MCP server now uses wrapper script instead of direct node execution
- Removed SessionStart ensure-dependencies hook (no longer needed)

### Removed
- `cli/ensure-dependencies` script (replaced by MCP server wrapper)

## [1.0.2] - 2025-10-23

### Fixed
- Pre-build and commit dist/ directory to avoid MCP server startup errors
- Remove dist/ from .gitignore to ensure built files are available after plugin install

### Changed
- Built JavaScript files now tracked in git for immediate plugin availability

## [1.0.1] - 2025-10-23

### Added
- Automatic dependency installation on plugin install via SessionStart hook
- `ensure-dependencies` script that checks and installs npm dependencies when needed

### Changed
- Plugin installation now automatically runs `npm install` if `node_modules` is missing
- Improved first-time plugin installation experience

### Fixed
- Plugin dependencies not being installed automatically after plugin installation

## [1.0.0] - 2025-10-14

### Added
- Initial release of episodic-memory
- Semantic search for Claude Code conversations
- MCP server integration for Claude Code
- Automatic session-end indexing via plugin hooks
- Multi-concept AND search for finding conversations matching all terms
- Unified CLI with commands: sync, search, show, stats, index
- Support for excluding conversations from indexing via DO NOT INDEX marker
- Comprehensive metadata tracking (session ID, git branch, thinking level, etc.)
- Both vector (semantic) and text (exact match) search modes
- Conversation display with markdown and HTML output formats
- Database verification and repair tools
- Full test suite with 71 tests

### Features
- **Search Modes**: Vector search, text search, or combined
- **Automatic Indexing**: SessionStart hook runs sync automatically
- **Privacy**: Exclude sensitive conversations from search index
- **Offline**: Uses local Transformers.js for embeddings (no API calls)
- **Fast**: SQLite with sqlite-vec for efficient similarity search
- **Rich Metadata**: Tracks project, date, git branch, Claude version, and more

### Components
- Core TypeScript library for indexing and searching
- CLI tools for manual operations
- MCP server for Claude Code integration
- Automatic search agent that triggers on relevant queries
- SessionStart hook for dependency installation and sync


