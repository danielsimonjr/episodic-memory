# now — next 1-3 months

> **As of 2026-05-18.** Concrete deliverables with definition-of-done.
> Status markers per [README.md § Status conventions](README.md).

Items here are either shipped on the fork (📦) or actively queued (📋).
Move to 📦 with commit ref when shipped; sweep into CHANGELOG release
section after the next cut.

---

## Recently shipped (last 30 days, fork-only)

### 📦 Self-improving memory (Recursa) — archive-graded eval harness + learner
**Shipped:** 2026-11-06

The archive can now grade itself. `learn tasks` builds `locate` / `recall` / `when` / `multi` questions
from deterministically sampled exchanges at three tiers, stratifies them 60/40 into `train` and a held-out
`test` split, and stores the answer key as an archive address plus a session date range. `learn solve`
grades answers against that address deterministically; `learn report` prints pass rate per split and tier
before and after, calls and USD spent, kept entries, and every rejection with its gate. Everything is off
behind `EPISODIC_MEMORY_LEARN=1`.

This is the eval harness [Theme 2 of `next.md`](../next.md#theme-2-search-quality-experiments) asked for,
and the first half of its definition of done: it measures search quality against real archive addresses
rather than a hand-labeled query file. What it does not yet give Theme 2 is *user intent* labels — the
tasks ask "which conversation holds this fact", not "find the conversation where I…". Labeling ≥50 real
recall queries on top of this harness is the remaining work.

Also shipped in the same series: the `skills` MCP tool, the learned-hints block injected at session start,
bootstrapping, a leaf learner with validated edits, a recursive learner with split/merge/reflection and a
held-out final evaluation, `learn approve` with a diff, skill export, and a `doctor` section.

**Left for the owner:** the dual-machine plugin-cache install check, and a live-archive smoke run
(`learn tasks` → `solve` → `bootstrap` → `improve` → `report` → `approve`) to decide whether to turn the
flag on by default on this machine.

### 📦 Plugin install hardening for Windows clean machines
**Shipped:** 2026-05-18 (commit `443db0e`)

The plugin's first-run install workflow couldn't recover from two
common failure modes on Windows: partial `node_modules` extracts and
the `@huggingface/transformers` → `onnxruntime-common` hoist gap. Both
manifested as `× failed` in `/mcp` with `ERR_MODULE_NOT_FOUND` and
required manual `npm install` recovery. Fork now self-heals.

Filed upstream as obra/episodic-memory#95.

### 📦 Housekeeping audit: 4 fixes (security + Windows + stdio + tests)
**Shipped:** 2026-05-18 (commit `6cadc20`)

Single audit pass against v1.4.1 base:
- **Security:** `read` MCP tool path traversal closed (was: any file Node can read; now: archive-confined `.jsonl` only)
- **Windows:** `parseConversationFile` was returning `project='unknown'` for every conversation indexed on Windows due to literal `/`-split — fixed with `path.basename(path.dirname(filePath))`
- **stdio:** 5 `console.log` calls in `db.ts` migrations were corrupting MCP JSON-RPC on upgrade — switched to `console.error`
- **Tests:** Added `safeRmSync` helper to handle Windows SQLite WAL cleanup race; wired into 3 affected test files

Net: 6 more tests pass, 0 regressions, 0 npm vulnerabilities, 0 hardcoded secrets / SQL injection / eval / unsafe exec found in the codebase.

---

## Queued (1-3 months)

### 📋 Upstream sync after first batch of obra merges
**Owner:** Daniel · **ETA:** depends on obra · **Tracking:** [#95](https://github.com/obra/episodic-memory/issues/95)

Once obra merges any of the 4 audit fixes (or ships equivalents), drop
the locally-redundant patches and re-build/test. The merge dance is
documented in `CLAUDE.md` § Upstream sync workflow.

**Definition of done:**
- `git log --oneline main..upstream/main` is empty after merge
- `npm test` still passes
- `dist/` rebuilt + committed
- Redundant fork patches reverted with commit message naming the upstream commit that obsoletes them
- todo.md + CHANGELOG.md updated

### 📋 Test stability: hook timeouts in integration.test.ts
**Owner:** Daniel · **ETA:** next session

3-6 `beforeEach` hooks in `test/integration.test.ts` exceed the default
10s timeout on Windows due to cold-start embedding model warm-up.
Options:

1. Bump per-file `hookTimeout` to 30s (cheap, addresses symptom)
2. Pre-warm the embedding model in a module-level beforeAll (faster overall but couples tests)
3. Mock the embedder for these tests (changes coverage shape)

**Definition of done:**
- Full suite passes ≥9/10 consecutive runs on Windows
- No test takes >60s in isolation
- CI documentation in CLAUDE.md updated with expected pass count

### 📋 SessionStart sync failures should not be silent (upstream issue #94)
**Owner:** Daniel · **ETA:** ~2 weeks · **Tracking:** [obra#94](https://github.com/obra/episodic-memory/issues/94)

The hook `npm rebuild ... 2>/dev/null || true` swallows real install
errors. Two-part fix:
1. Log to a known location (`~/.config/superpowers/sync-errors.log`) so failures are diagnosable
2. Surface in `doctor` output so users know to look

**Definition of done:**
- Hook exits 0 always (no breaking other plugins) but writes error context to log
- `doctor` reads + displays last 5 hook errors
- `test/hooks.test.ts` extended with a failing-rebuild case
- PR opened upstream

### 📋 doctor command: Windows install diagnostics
**Owner:** Daniel · **ETA:** ~3 weeks

Current `doctor` covers config dir + DB path + Claude CLI version. Add:
- Plugin install path detection (which marketplace, which version)
- `node_modules` health check (sentinel files, native binding present)
- DB size + row counts (sanity check)
- Recent sync errors (from the log added in the previous task)
- EMBEDDING_VERSION mismatch detection

**Definition of done:**
- `npx episodic-memory doctor` produces a structured report (markdown + optional `--json` flag)
- `test/codex-doctor.test.ts`-style coverage extended
- README mentions the diagnostic flow

### 📋 Search-result summary visibility (upstream issue #74)
**Owner:** community/Daniel · **ETA:** flexible · **Tracking:** [obra#74](https://github.com/obra/episodic-memory/issues/74)

When a conversation has a summary, search results currently return
exchange snippets only. Including the summary in the result inline
would dramatically improve LLM recall behavior.

**Definition of done:**
- Search results include summary when available, behind a feature flag (default: on)
- New test `test/search-with-summary.test.ts`
- PR opened upstream

---

## Status board (rolling, this quarter)

| Item | Status | Notes |
|---|---|---|
| Self-improving memory (Recursa) | 📦 shipped | flag off; owner smoke + install check pending |
| Plugin install hardening | 📦 shipped | `443db0e`, upstream PR pending |
| Housekeeping audit (4 fixes) | 📦 shipped | `6cadc20`, upstream PR pending |
| Upstream sync (post-merges) | 📋 queued | Depends on obra |
| integration.test.ts hook timeouts | 📋 queued | Started next session |
| SessionStart silent-fail (#94) | 📦 shipped | `cli/sync-hook.js` + `sync-errors.log` + doctor |
| doctor Windows diagnostics | 📦 shipped | default `doctor` + `--json` |
| Search summary visibility (#74) | 📦 shipped | default on; env flag |

## What's NOT in `now`

(Things to clarify scope — these belong in `next.md` or `later.md`, not here.)

- LEANN integration (#46) — too speculative for `now`, see `next.md`
- AWS Bedrock support (#44) — fork doesn't need it; track upstream
- Embedding model swap — bigger lift, see `next.md`
- Multi-machine sync — `later.md`

## See also

- [`/todo.md`](../../todo.md) — operational task tracker (more granular than this roadmap)
- [`next.md`](next.md) — what's 3-6 months out
- [`upstream-sync.md`](upstream-sync.md) — how this fork pulls in obra's work
