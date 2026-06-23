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

- [ ] **Test stability: hook timeouts in `integration.test.ts`** — pre-warm embedder OR bump hookTimeout to 30s. Target: ≥9/10 consecutive runs pass.
- [ ] **SessionStart sync failures should not be silent** (upstream #94) — redirect hook stderr to `~/.config/superpowers/sync-errors.log` with `|| true` to preserve non-blocking. PR upstream.
- [ ] **`doctor` Windows diagnostics** — extend `doctor` with plugin install state + node_modules sentinel check + DB stats + recent errors + EMBEDDING_VERSION drift detection.
- [ ] **Search-result summary visibility** (upstream #74) — include summary in search response when available, default on, feature-flagged. PR upstream.
- [ ] **Upstream sync after first obra merges** — drop redundant fork patches per the "When upstream merges a fork patch" recipe in `docs/roadmap/upstream-sync.md`.
- [ ] **Skip resume attempt for known-archived sessions** (optimization, follow-up to the 2026-06-23 resume-fallback fix) — un-resumable sessions currently cost 2 SDK calls (resume-fail + transcript-success) the one time they drain. Could check whether the session JSONL still exists in `~/.claude/projects/` before attempting resume, and go straight to transcript text when it doesn't. Low priority: the double cost is one-time per conversation (the backlog drains permanently after), so this only matters during a large initial drain.

### Medium-term (3-6 months, mirrors `docs/roadmap/next.md`)

Themes (not individual tasks; promote into tasks here as plans firm up):

- [ ] **Theme 1: Better first-run install story** — progress reporting, doctor install command, failure recovery hints
- [ ] **Theme 2: Search quality experiments** — build eval harness with ≥50 labeled queries; ship one quality improvement with measured win; LEANN feasibility study
- [ ] **Theme 3: Embedding pipeline modernization** — compare bge-small / gte-small / mxbai-embed-large against current MiniLM-L6; reversible upgrade if winner emerges
- [ ] **Theme 4: Observability & debugging UX** — structured sync log, `doctor` expansion, DEBUG=episodic:* flag, local metrics counters
- [ ] **Theme 5: Cross-harness integration polish** — harness detection metadata, summarization fallback chain
- [ ] **Theme 6: Multi-machine foundation (import/export)** — per-machine identity tagging, bundle export/import; full sync deferred to `later.md`
- [ ] **Theme 7: Security hardening sweep** — written threat-model doc, secret-aware indexing option, optional DB encryption at rest, MCP tool authz pattern

---

## Deferred (from prior work)

### Items that were considered but not pursued this cycle

- [ ] **`: any` type tightening** — 16 sites in `src/` use `any` at DB-row + JSONL-payload trust boundaries. Tightening to `unknown` + type guards is a real refactor. Defer until a quality reason exists; don't churn for cosmetics.
- [ ] **Major dep bumps** — typescript 5→6, vitest 3→4, marked 16→18, @types/node 24→25. All cross-major; each needs its own evaluation. Defer until needed (e.g., a vitest 4 fix we want).
- [ ] **Parser TODO** at `src/parser.ts:207` — "Match tool_use_id to previous tool_use" — documented edge case in tool-call matching. Not a defect; address only if it causes a real bug.

### Upstream behavior we're tracking but not contributing to

- [ ] **LEANN integration** (upstream #46) — interesting but speculative for now; reconsider after the eval harness from `next.md` Theme 2 exists
- [ ] **AWS Bedrock support** (upstream #44) — fork doesn't need it; track upstream, contribute if direction matches

---

## Conventions

### Repo state

- **Repo:** `~/Dropbox/Github/episodic-memory` (local working dir)
- **Origin:** `danielsimonjr/episodic-memory` (Daniel's fork)
- **Upstream:** `obra/episodic-memory`
- **Default branch:** `main` (direct push, no PR flow for fork-only commits)
- **package-lock.json:** `.gitignore`'d — npm install on each fresh checkout
- **dist/ committed:** edit `src/`, then `npm run build`, then commit both. Only stage dist files with real content diffs (skip line-ending-only churn)

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

- `npm audit` (clean as of 2026-05-18)
- `gitleaks scan` (not run yet; add to next audit cycle)
- Manual RLM pass with honest-claude verification — pattern documented in `docs/roadmap/focus-areas/security-hardening.md` § "Audit tooling"
- `npx vitest run` (full test gate)
- `npm run build` + smoke probe (CLAUDE.md § "Probing the server in isolation")

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
