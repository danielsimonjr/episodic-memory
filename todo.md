# episodic-memory TODO

Durable cross-session task tracker for **`danielsimonjr/episodic-memory`**.
Update this file as work progresses — checkboxes flip when tasks complete,
items move between sections as state changes.

> The in-conversation TaskCreate/TaskUpdate tracker is ephemeral. This
> file is the source of truth for "what's next" across sessions. The
> three-tier roadmap (`docs/roadmap/{now,next,later}.md`) is the strategic
> view; this file is the operational view.

---

## Latest shipped (this fork)

- **TypeScript-on-BunJS toolchain completed** (this PR) — single `bun.lock`, `package-lock.json` gitignored, `bun run` scripts + real `typecheck`, exact `better-sqlite3` pin + Bun `trustedDependencies`. Node remains production runtime; plugin wrapper still `npm install`s for end users.
- **Sync fires on compaction too — long-lived sessions stopped archiving** (2026-08-08) — `hooks/hooks.json` matched only `startup|resume|clear`, so archiving happened at session boundaries and nowhere else. Measured on the ZBOOK: **65 hours with zero archive writes** while every process stayed healthy, the last sync had completed cleanly, and MCP `search` answered correctly — from stale data. 64 of 67 transcripts written since the cutoff were missing entirely. The trap worth remembering: *"the archiver is broken"* and *"the archiver was never invoked"* produce identical evidence if you only measure the output; reading `hooks.json` settled it in a minute after a longer wrong-headed hunt through logs and process state. One-word matcher change, TDD'd (RED confirmed on the missing `compact`), full suite 210/210. Does not widen the #87 recursion surface — SDK subprocesses fire `startup`, already matched, and the guard is env-based not matcher-based.
- **Orphan-storm root cause + full hardening pass** (2026-06-24) — the SessionStart background sync was leaving orphaned `sync-cli` processes pegging CPU for hours. Root causes: (1) each summarizer SDK subprocess loaded user settings → booted the whole MCP-server fleet + fired SessionStart hooks (a wedged one spawned a tree of ~14 children) — fixed with `settingSources: []` / `mcpServers: {}` isolation; (2) `callClaude` had no timeout → a stalled subprocess wedged the sync forever — fixed with an `AbortController` timeout; (3) no concurrency lock → overlapping syncs stacked — fixed with a generic `src/lockfile.ts` (PID-liveness + mtime-age stale recovery, atomic steal, ownership-checked release) and a `.sync.lock` acquired in the worker path. Removed the doomed resume path entirely (it always failed from the background context). Plus an audit-driven sweep: poison-pill summary retry cap (sentinel after N failures), global configurable summary budget, Codex `--version`/app-server timeouts + pending-promise rejection + stdin EPIPE guard, hierarchical chunk cap, sync-log rotation, DB `busy_timeout`, `db.close()` in `finally`, `copyIfNewer` temp cleanup, non-UUID session fallback, logFd close, and an MCP-wrapper parent-liveness poll. +15 tests; full suite 188/188. Code-review agent caught a release-after-steal lock bug, fixed.
- **Resume-skip + early reentrancy guard + test-stability** (2026-06-23, follow-up) — three issues closed in one pass. (1) `summarizeConversation` now checks `isSessionResumable()` and skips the doomed resume SDK call for archived sessions (was 2 SDK calls per archived conversation during drain → 1). (2) The reentrancy guard (#87) moved to a dependency-free `src/reentrancy.ts` and is checked BEFORE `sync-cli` imports the heavy native stack (transformers, better-sqlite3) — a guarded reentrant subprocess now exits in ~0.5s instead of ~3.5s warm / >5s cold (which was timing out the integration test). (3) Pre-warm the embedder in `beforeAll` + `hookTimeout: 30000` + bumped the verify re-index test to 60s — fixes the documented `integration.test.ts`/`verify.test.ts` cold-embedding timeout flakes. +6 tests (`test/reentrancy.test.ts`, expanded `summarizer-resume-fallback.test.ts`); full suite green.
- **Summarizer resume-failure fallback — fixes the sync orphan/CPU storm** (2026-06-23) — archived conversations whose session no longer exists in `~/.claude/projects/` made the resume-based summarizer return `undefined`, crashing `extractSummary` with `Cannot read properties of undefined (reading 'match')`. Summaries never succeeded → backlog never drained → every SessionStart sync re-attempted 10 of them, each spawning a doomed Claude subprocess (one observed pegging a CPU core at 66%). Fix: `callClaude` now throws a clear error on SDK-error results, `extractSummary` guards non-string input, and `summarizeConversation` falls back to transcript-text summarization when resume fails. +5 tests (`test/summarizer-resume-fallback.test.ts`), 0 regressions (20 summarizer + 12 sync green). Same backlog-never-drains class as the 1.4.1 empty-conversation fix, different root cause.
- **Memory archive cloned to fork-local path** (2026-05-18) — full byte-identical copy of `~/.config/superpowers/` (926 MB / 2,458 files) to `~/.claude/episodic-memory-data/`. `EPISODIC_MEMORY_CONFIG_DIR` user env var points fork install at the new location; SQLite integrity check `ok`; row counts match (2,739 exchanges / 1,429 conversations / 10 projects). Original at `~/.config/superpowers/` preserved as fallback if we ever revert to upstream install. NOT a commit — operational state on this machine only.
- **Fork housekeeping audit — 4 fixes** (2026-05-18, commit `6cadc20`) — security: `read` MCP path traversal closed; Windows: parser path-split fixed; stdio: 5 `console.log` → `console.error` in db.ts migrations; tests: safeRmSync helper for Windows EPERM race. Net +6 tests passing, 0 regressions.
- **Plugin install hardening** (2026-05-18, commit `443db0e`) — wrapper sentinel check for partial node_modules + onnxruntime-common top-level dep. Resolves clean-Windows-machine `× failed` in `/mcp`.
- **Initial fork from `obra/episodic-memory@1.4.1`** (2026-05-18) — forked to `danielsimonjr/episodic-memory`; cloned to `~/Dropbox/Github/episodic-memory`; `upstream` remote added.
- **Repo documentation pass** (2026-05-18) — full-rewrite `CLAUDE.md` for the fork; three-tier `docs/roadmap/` structure; this `todo.md`. Tracking from this point forward.

---

## Active queue

### Immediate (next session-or-two)

- [ ] **Swap install source from upstream → fork** — first-time activation. Daniel runs `/plugin uninstall episodic-memory@superpowers-marketplace` then `/plugin install episodic-memory@local-marketplace` then `/reload-plugins`. Memory is already in place at `~/.claude/episodic-memory-data/` (cloned from `~/.config/superpowers/` on 2026-05-18); `EPISODIC_MEMORY_CONFIG_DIR` user env var points the fork at it. Original at `~/.config/superpowers/` preserved as fallback.
- [ ] **Verify fork install works end-to-end** — after the swap, run a real search query through the MCP `search` tool (should return results from the 2,739 indexed exchanges) and a real `read` against a returned archive_path (should resolve to the new `~/.claude/episodic-memory-data/conversation-archive/...` path). Confirm no `× failed` symptoms; confirm the new path-confinement rejects out-of-archive paths.
- [ ] **Monitor obra/episodic-memory#95 for merges** — when obra responds, decide whether to split into 4 PRs or wait for review feedback.

### Short-term (1-3 months, mirrors `docs/roadmap/now.md`)

- [x] **SessionStart sync failures should not be silent** (upstream #94) — `cli/sync-hook.js` logs to `sync-errors.log` and always exits 0; `doctor` surfaces last 5 errors.
- [x] **`doctor` Windows diagnostics** — default `episodic-memory doctor` reports plugin/node_modules sentinels, DB stats, hook errors, EMBEDDING_VERSION drift; `--json` supported.
- [x] **Search-result summary visibility** (upstream #74) — summaries in markdown + MCP JSON + multi-concept; `EPISODIC_MEMORY_INCLUDE_SUMMARY` flag.
- [ ] **Upstream sync after first obra merges** — drop redundant fork patches per the "When upstream merges a fork patch" recipe in `docs/roadmap/upstream-sync.md`.
- [ ] **(Considered, deliberately NOT done 2026-06-24) `.gitattributes` eol normalization for `dist/`** — the committed `dist/` churns LF↔CRLF on every Windows `tsc` build (gotcha #3 documents the "stage real-content files only" workaround). A `* text=auto eol=lf` + `git add --renormalize` would stop the churn but (a) produces a one-time ~40-file noisy diff and (b) risks eol merge friction against `upstream/main` (this is a fork that merges from obra). Left as-is on purpose; revisit if/when the fork stops tracking upstream.

### Medium-term (3-6 months, mirrors `docs/roadmap/next.md`)

Themes (not individual tasks; promote into tasks here as plans firm up):

- [ ] **Theme 1: Better first-run install story** — progress reporting, doctor install command, failure recovery hints
- [ ] **Theme 2: Search quality experiments** — build eval harness with ≥50 labeled queries; ship one quality improvement with measured win; LEANN feasibility study
- [ ] **Theme 3: Embedding pipeline modernization** — compare bge-small / gte-small / mxbai-embed-large against current MiniLM-L6; reversible upgrade if winner emerges
- [ ] **Theme 4: Observability & debugging UX** — structured sync log, `doctor` expansion, DEBUG=episodic:* flag, local metrics counters
- [ ] **Theme 5: Cross-harness integration polish** — harness detection metadata, summarization fallback chain
- [ ] **Theme 6: Multi-machine foundation (import/export)** — per-machine identity tagging, bundle export/import; full sync deferred to `later.md`
- [x] **Theme 7: Security hardening sweep** — `docs/security.md` written; secret redaction + MCP realpath/`read` caps + dir modes + optional `EPISODIC_MEMORY_MCP_TOKEN` shipped. Residual: SQLCipher opt-in (documented as filesystem encryption).

---

## Deferred (from prior work)

### Items that were considered but not pursued this cycle

- [ ] **`: any` type tightening** — 16 sites in `src/` use `any` at DB-row + JSONL-payload trust boundaries. Tightening to `unknown` + type guards is a real refactor. Defer until a quality reason exists; don't churn for cosmetics.
- [ ] **Major dep bumps** — typescript 5→6, vitest 3→4, marked 16→18, @types/node 24→25. All cross-major; each needs its own evaluation. Defer until needed (e.g., a vitest 4 fix we want).
- [x] **Parser TODO** at `src/parser.ts:207` — Claude `tool_result` now matches `tool_use_id` the same way Codex matches `call_id`.

### Upstream behavior we're tracking but not contributing to

- [ ] **LEANN integration** (upstream #46) — interesting but speculative for now; reconsider after the eval harness from `next.md` Theme 2 exists
- [ ] **AWS Bedrock support** (upstream #44) — fork doesn't need it; track upstream, contribute if direction matches

---

## Conventions

### Repo state

- **Repo:** `~/Dropbox/Github/episodic-memory` (local working dir)
- **Origin:** `danielsimonjr/episodic-memory` (a fork)
- **Upstream:** `obra/episodic-memory`
- **Default branch:** `main` (direct push, no PR flow for fork-only commits)
- **bun.lock:** committed — prefer `bun install --frozen-lockfile` on fresh checkouts; CI audits at critical level via `bun audit`. Do not commit `package-lock.json`.
- **dist/ committed:** edit `src/`, then `bun run build`, then commit both. Only stage dist files with real content diffs (skip line-ending-only churn)
- **Toolchain vs runtime:** Bun for install/scripts/CI; Node for shipped CLI/MCP/hooks. Plugin first-run wrapper still runs `npm install`.

### Workflow

For each task, follow the `dev-workflow` 12-step pipeline (plan → review-plan → TDD → review-code → fix → simplify → tasklist → CHANGELOG → commit → push → next → recurse). Per-task gates:

- TDD strict — failing test first, confirm RED, implement, confirm GREEN
- Verify before claiming done — run typecheck + scoped test + smoke
- Atomic commits — one task = one commit (or a clean atomic series)
- CHANGELOG entry under `[Unreleased]` user-facing language
- Push direct to fork's `main`

For non-trivial work (multi-task spans, schema changes, architectural shifts):

- `superpowers:brainstorming` → `superpowers:writing-plans` → optional Adam+Eve adversarial review on BOTH design AND plan → `superpowers:subagent-driven-development` to execute

### Reasoning tier

- **Adam (Gemini 2.5 Pro)** + **Eve (OpenAI o3)** are the default review-tier models for non-trivial design/plan/audit work on this fork. Invoke liberally — `OPENAI_REASONING_MODEL=o3` already pinned in `mcp-host/.mcp.json`.
- MCP llm-tools are **TEXT-ONLY** — inline source content into the `prompt` string when asking Adam/Eve to verify code claims. Per `feedback_mcp_llm_text_only_no_fs_access` memory.

### Audit tooling

Re-runnable when a sweep is due (per `docs/roadmap/focus-areas/security-hardening.md` § Audit tooling):

- `bun audit` (clean as of 2026-05-18; gate is `--audit-level=critical`)
- `gitleaks scan` (not run yet; add to next audit cycle)
- Manual RLM pass with honest-claude verification — pattern documented in `docs/roadmap/focus-areas/security-hardening.md` § "Audit tooling"
- `bun run test` (full test gate)
- `bun run build` + smoke probe (CLAUDE.md § "Probing the server in isolation")

### Documentation

| File | Purpose |
|---|---|
| `CLAUDE.md` | Project conventions, gotchas, workflow — auto-loaded by Claude Code |
| `README.md` | User-facing readme (upstream's; mostly unchanged) |
| `CHANGELOG.md` | Keep-a-Changelog format; entries under `[Unreleased]` until release |
| `todo.md` (this file) | Operational task tracker |
| `docs/roadmap/README.md` | Three-tier roadmap index |
| `docs/roadmap/{now,next,later}.md` | Time-horizon-organized work |
| `docs/roadmap/upstream-sync.md` | Strategy for tracking obra's work |
| `docs/roadmap/focus-areas/*.md` | Per-theme deep dives |

### How to update this file

- **When a task completes:** flip `[ ]` → `[x]` and move it to "Latest shipped" with the commit ref. After the next release cut, sweep into `CHANGELOG.md`.
- **When a new task surfaces:** add to the appropriate section (immediate / short-term / medium-term / deferred).
- **Keep "Latest shipped" to 3-5 entries** — older releases roll off into `CHANGELOG.md`.
- **Commit this file alongside the work it tracks** — it's not `.gitignore`'d.

### Fork-specific gotchas (don't forget)

- **stdio MCP servers MUST log to stderr.** `console.log` from any module reachable from `mcp-server.ts` corrupts JSON-RPC. Reachable surface: `search.ts`, `show.ts`, `db.ts`, `paths.ts`, `embeddings.ts`, `parser.ts`, `version.ts`.
- **Windows paths.** Always use `path.join`, `path.basename`, `path.dirname`. Never split on literal `/` or `\\`. The fork already fixed one of these (`parseConversationFile`); be alert for others.
- **`dist/` is committed.** Always edit src/, build, commit both. After build, only stage dist files with real content diffs.
- **EMBEDDING_VERSION bump triggers re-embed for all users.** Don't bump casually; do it as part of a planned embedder upgrade with migration story.
- **The MCP failure cache survives `/reload-plugins`.** If a server fails once, the cache silently skips it. Bust by nudging `env` in `.mcp.json` with a `_RETRY` value, or start a fresh CC session.
- **NPM_TOKEN was leaked to transcript on 2026-05-18.** Rotate before any npm publish from this fork.

---

## Horizon (no commitments, see `docs/roadmap/later.md`)

- Multi-machine continuous sync (theme A)
- Agent-driven memory shaping (consolidation, supersession, labels) (theme B)
- Beyond-conversation memory (Obsidian, voice memos, paper drafts) (theme C)
- Personalized retrieval (theme D)
- Embeddings as a moving target — continuous model evolution (theme E)
- TensorJS adjacency (theme F)
- Ecosystem play — standardized semantic-memory MCP surface (theme G)
