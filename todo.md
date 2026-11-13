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

- **Self-improving memory (Recursa), Tasks 0–11** (2026-11-06) — the `learn` CLI, the `skills` MCP tool and the learned-hints block, off by default behind `EPISODIC_MEMORY_LEARN=1`. Archive-graded self-practice tasks, a deterministic grader, an isolated solver runner, bootstrapping, a leaf learner with validated edits, a recursive learner with split/merge/reflection and a held-out test split, `learn approve`, skill export, and the docs. Learned state lives in `learned/`, a sibling of `conversation-index/`, so an index rebuild or reset never reaches it. Full suite 1041 tests / 126 files green; typecheck, `bun audit --audit-level=critical` and the stdio probe clean. Left for the owner: the dual-machine plugin-cache install check (`/mcp` shows four tools; the hook prints nothing new with the flag off) and the live-archive smoke run (`learn tasks` → `solve` → `bootstrap` → `improve` → `report` → `approve`).
- **Agent SDK moved to 0.3.x so the bundled `claude` stops deleting live session records** (2026-10-14) — the 0.2.x line ends at 0.2.141, whose binary (2.1.141) removes the session record of a running High-integrity session when it starts at Medium. The range is now `^0.3.299` (binary 2.1.299, byte-identical to the installed CLI of that version) with a test that holds the floor. Five-axis pass: security and stability fixed (session records survive summarizer starts); speed, reliability and maintainability assessed, nothing else in reach. Left: the stale `1.6.2` and `1.6.4` plugin cache copies on the EVO still hold 2.1.141 until removed.
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

- [x] **Self-organized topic memory (SOMEM)** — from arXiv paper "Can LLM Agents Organize Their Own Memory?" (Fu, Qi et al.). The sync job writes agent-organized Topic documents that cite exchanges; the runtime validates each edit and derives backlinks and a timeline. Scope: Topic + validation + backlinks + timeline + MCP search/read; Core and Recent left out (the digest covers them; paper ablation shows them within noise). Spec and plan under `docs/superpowers/`.
  - [x] Tasks 1-3 (format, validator, store) plus the fix list of the Sonnet review and the Haiku challenger: fences, one reference per label, bare marks, links by unit id, range bounds, leap years, shared FTS query, pinned test arrays.
  - [x] Task 4: prompt, answer parser and prepare (worker df74821), plus the review fix list: fenced `===` lines, caller-order-independent doc order, bearer rule on one line, malformed blocks kept verbatim, link rewrite across lines, link targets kept by redaction.
  - [x] Task 5: organize job, phase and sync wiring (worker 8c63d13, reviewer 2653bc7), plus the fix list: NOTHING answer, edit faults stay pending, prompt never rejected for size, exact transcript cap, one Ollama cap reader, SINCE warning, mutant-checked reserve and NULL tests. Spec sections 5 and 11 updated.
  - [x] Tasks 6-7: the `topics` MCP tool, docs and build. Task 6: import only topic-db, topic-format and constants; never write; the server does not see EPISODIC_MEMORY_TOPICS, so the tool keys off the tables, not the flag. Shipped in v1.8.0 (#43): `src/topic-tool.ts`, registered as `topics` in `src/mcp-server.ts`; README and docs/SCHEMA.md describe it.
- 2026-11-12 five-axis (digest inline marks): speed n/a; stability n/a; reliability: each mark group of a digest line now names its exchanges; security: the learn hide filter now reads every mark group of a line, so an inner group that names a hidden exchange cannot reach the solver; maintainability: one mark-number reader (`markIds`) and one stable-mark writer in the parser. clones 3/2/12 before and after, none in this diff; left: 11 stored entries keep their raw numbers (no map from number to exchange survives the run). In a day or week merge, `buildCompressPrompt` gives new numbers to the `[#id]` marks, and a raw `[1]` of such an entry then reads as one of those numbers. The 11 entries date from 2026-10-13 to 2026-10-19 and 3 of them are day or week entries, so their merges already ran; a new merge over them needs a re-run of compression.
- 2026-11-12 five-axis (topic Task 6): speed: the server loads topic-tool on the first topics call only (bundle external, schema imports the import-free topic-time); stability: two load failures fixed at the cause (a learn test reached the real judge; the hook timing test counted the Node start); reliability: the tool opens the index read-only and creates no file, rejects from after to, caps the timeline, names an unknown unit; security: every action redacts secrets (tested), PII left unredacted as the spec says; maintainability: clones 3/2/12 before and after; left: the digest tool opens the index as a writer by design (handoff writes).
- 2026-11-12 five-axis (topic Task 5 fixes): speed n/a; stability: an edit fault no longer rejects a session for good; reliability: the digest prompt is no longer cut silently on Ollama, an empty-answer session is no longer rejected on Ollama; security n/a; maintainability: one reader of the Ollama prompt cap and one integer parser. clones 3/2/12 before and after, none in this diff.
- 2026-11-12 five-axis (topic Task 4 fixes): speed n/a; stability n/a; reliability: a fenced `=== END` no longer truncates a document silently; security: the bearer redaction no longer eats the next line, a secret-shaped slug is no longer mangled, the transcript-echo risk is recorded for the Task 7 risks section; maintainability: one fence rule (`fenceStep`) for the parser, the rewrite helpers and the answer parser. clones 3/2/12 before and after, none in this diff.
- [x] **Dependency-minimization plan** — the deployed tree is 839.2 MB; `@huggingface/transformers` (427.6 MB exclusive) and the Agent SDK (274.4 MB exclusive, 269.2 MB of it the bundled `claude` binary) are 83.7% of it. Write `docs/roadmap/dependency-minimization.md`: per dependency the saving, risk, acceptance test, rollback and a verdict. Not every dependency has to go.
- [x] **Deps PR 1: quick wins** — drop `tsx` and `@types/marked`, `sqlite-vec` range `^0.1.9`, regenerate `bun.lock`, correct the stale stderr comment in `src/deps-health.ts`. Plan section 3.1.
- 2026-11-12 five-axis (Deps PR 1): speed n/a; stability n/a; reliability n/a; security: `bun audit` clean, 29 fewer lockfile entries to track; maintainability: the `sqlite-vec` range names the installed release, one false comment corrected. clones 3 exact, 2 text, 12 near, the same as before; this diff changes one comment and no function.
- [x] **Deps PR 2: `--omit=dev` on plugin hosts** — one flag in the `runNpm` args of `cli/ensure-deps.js`; static dev-import check plus a wrapper/doctor/search run in an `--omit=dev` scratch tree. 78.4 MB, 54 packages. Plan section 3.2.
- 2026-11-12 five-axis (Deps PR 2): speed: a first-run install writes 87.5 MB and 49 packages less; stability n/a; reliability: a runtime import of a devDependency now fails a test instead of a plugin host; security: 49 fewer packages on each host; maintainability: the install arguments are one exported constant. clones not rerun: the diff adds one constant and no function.
- [x] **npm 11 skips the install scripts of `onnxruntime-node` and `protobufjs`** — npm 11.20 warns "2 packages have install scripts not yet covered by allowScripts" on a plugin-host install. Search and the native binding still work on Windows x64, measured. Find what the `onnxruntime-node` postinstall does on Linux and macOS, and decide whether `package.json` needs an `allowScripts` entry.
- 2026-11-12 five-axis (allowScripts deny): the premise of the row was wrong. npm 11.20 runs an unlisted install script with a notice, and skips a script denied with a name-only `false` entry (both measured with probe packages; the npm docs contradict each other on the default). speed and reliability: a linux/x64 host on npm 11 skips the 236 MB CUDA download that `onnxruntime-node` 1.30.0 makes, and that download is one network step less to fail; inferred from the script source, no linux install measured. security: two fewer dependency scripts run at install. stability n/a. maintainability: a test pins both entries. clones not rerun: the diff adds no function.
- [ ] **A plugin host installs versions that CI never tested (ADR-level)** — the repo has no npm lockfile (by design, `docs/roadmap/upstream-sync.md`), so `npm install` on a plugin host resolves the ranges. Measured 2026-11-12: a host gets `@huggingface/transformers` 4.3.2 and `onnxruntime-node` 1.30.0, while `bun.lock` and CI use 4.2.0 and 1.24.3. The embedding stack can change on any fresh install or plugin update without an `EMBEDDING_VERSION` bump. Options: exact pins for the embedding stack, a committed npm lockfile, or a host-version test. The choice is an ADR-level call; ask before acting.
- [x] **`sync` ignores an unknown flag without a word** — `episodic-memory sync --no-summaries` runs a full sync with summaries and prints nothing about the flag. `sync` should refuse an unknown flag.
- 2026-11-12 five-axis (sync unknown option): reliability: a mistyped flag stops with exit 2 instead of a full sync with default settings; the callers (SessionStart hook, scheduled task) pass only `--background` or nothing. stability: the test runs the CLI with an empty home and config folder, so a regression cannot reach real transcripts. maintainability: the unused pass-through of the other arguments to the background worker is gone. speed n/a. security n/a. clones not rerun: the diff adds no function.
- [x] **Deps PR 3: `onnxruntime-web` stub override** — `file:./vendor/onnxruntime-web-stub` in `overrides`, no published package; UNVERIFIED until `bun install --frozen-lockfile` and `npm install` both accept it. 140.7 MB, 18 packages. Plan section 3.3a.
- 2026-11-12 five-axis (Deps PR 3): speed: a fresh npm plugin-host install writes 151.9 MB and 17 packages less; stability n/a; reliability: both installers accept the `file:` override (npm links the stub, bun installs no directory), the known passage is hit 1 on the fixture index of the before tree, and a later transformers import of `onnxruntime-web` throws in the stub and fails a test; security: no `protobufjs` reaches the tree, so its override and install-script entry are removed; maintainability: the plan figure 140.7 MB holds at the `bun.lock` versions. clones 3 exact, 2 text, 12 near before and after, none in this diff (no source change).
- [ ] **`index` runs a full index for an unknown argument** — `node dist/index-cli.js --help` (and any unknown command) falls to the `default:` branch and indexes every source with summaries. `episodic-memory index --bogus` does the same through the `default:` case of `cli/index-conversations.js`. Refuse an unknown command and an unknown option with exit 2, as `sync` does.
- [x] **Deps PR 4: prune idle `onnxruntime-node` binaries** — every `napi-v6/<platform>/<arch>` except the running pair, best effort, on every `ensureDeps` call including a healthy tree. 158.1 MB on Windows x64 (estimate). Plan section 3.3b.
- 2026-11-12 five-axis (Deps PR 4): speed: a plugin host holds 158.1 MB (lock versions) or 233.9 MB (npm host) less, and a call with nothing to remove takes at most 1.3 ms; stability: the tests use fake trees in the temp folder and inject the removal, so no test touches a real `node_modules`; reliability: the prune never throws, stops at the first failure with one stderr line, stays quiet when a concurrent call removed a directory first, and removes nothing when the binding file of the running pair is absent; both pruned trees pass `doctor` and the fixture search, and the rollback (delete `node_modules/onnxruntime-node`, install) restores all five pairs under npm and bun; security n/a; maintainability: `ensureDeps` moves the repair into `repair`, and one best-effort removal helper serves PR 5. clones 3 exact, 2 text, 12 near before and after, none in this diff.
- [ ] **`repairPlan` does not check `onnxruntime-node`** — the sentinels of `src/deps-health.ts` name `onnxruntime-common` and the transformers manifest, not the `onnxruntime-node` binding. A tree without `onnxruntime-node/bin/napi-v6/<platform>/<arch>/onnxruntime_binding.node` reports healthy, and the first embedding fails. A plain sentinel is not the fix: `npm install` does not restore a missing file inside an installed package (measured in PR 4), so the repair would throw and stop the MCP server. The repair needs to delete `node_modules/onnxruntime-node` first. Found in the PR 4 review.
- [x] **Deps PR 5: Agent SDK platform package, opt-in** — `EPISODIC_MEMORY_CLAUDE_BIN` (unset = bundled binary), bounded `--version` probe against the SDK `manifest.json` floor, removal of every `claude-agent-sdk-*` package on opt-in hosts. 269.2 MB on opt-in hosts. Plan section 3.4.
- 2026-11-12 five-axis (Deps PR 5): speed: an opt-in host holds 269,231,840 bytes less, the probe runs once per process (a timeout retries at the next call), and the unset case runs no probe; stability: every test uses fake trees and fake `.mjs` binaries, and a mocked SDK, so no test starts Claude Code; reliability: a missing or old binary defers the summary, digest, topic and backfill work with no counted attempt and no failure record (data-safety test), and the learn commands stop before the lock; security: the probe refuses a relative path and the `.cmd`, `.bat` and `.ps1` shims, and keeps the SDK floor that protects session records; maintainability: one deferral predicate (`deferralDetail`) replaces four GPU-only checks, and one module reads the variable. clones 3 exact, 2 text, 12 near before and after, none in this diff. Left: an unlocked npm host resolves SDK 0.3.323 (floor 2.1.323) while the host binary is 2.1.318, so an opt-in host defers until Claude Code updates (no data lost; the row on untested host versions covers the cause).
- [ ] **One unhandled error in one of seven full-suite runs (Windows, bun 1.4.2, 2026-11-12)** — every test passed and vitest reported `Errors 1 error`. The run came right after `bun run build` and `bun run typecheck`. The output was cut to its last lines, so the error text is lost. Six more full runs (two after a build and a typecheck) and ten runs of the new PR 5 test files gave no error. Next time, write the full output to a file and read the `Unhandled` block before rerunning.
- [ ] **Deps PR 6 (DO LATER): embedding option B** — direct `onnxruntime-node` + `@huggingface/tokenizers` behind the 0.9999 cosine parity gate and its negative control; the gate decides the `EMBEDDING_VERSION` bump. 65.5 MB. Plan section 3.5.
- [ ] **Deps PR 7 (DO LATER): better-sqlite3 to `node:sqlite`** — Node floor 22.16.0, CI matrix with the exact 22.16.0 binary and Node 24, transaction wrapper with `BEGIN IMMEDIATE` and savepoints. 27.7 MB plus the native repair path. Plan section 3.6.
- [x] **Topics writes no documents** — after the start time moved back, 6 of 6 sessions gave 0 documents: 4 empty, 2 rejected by footnote checks 5 and 7, each with `attempts: 0`. Find whether the prompt, the model or the validator is at fault before changing one.
- 2026-11-12 five-axis (topic prompt fix): speed n/a; stability: a test runs the footnote example through the real parsers, `prepareTopicEdit` and `validateTopicEdit`, so a rule change that breaks the example fails at once; reliability: 0 to 6 and 5 installed sessions of 12 (the 6 sessions of the item were the first observation, and the measurement used a sample of 12), every footnote time inside its sources, and a FILE block with the example slug fails check 1, so a copied example is never installed; security n/a; maintainability: one `dated` option on the shared `numberExchanges`, the digest prompt unchanged. clones not rerun: the diff adds one option and no function.
- [ ] **Topic backlog drain** — 1,332 sessions are due since `EPISODIC_MEMORY_TOPICS_SINCE`, at 3 sessions for each sync run. Measure the time for each session, then decide the limit for each run.
- [x] **Learn agent runner: cwd, poll cost, stale pid file** — the SDK child inherits the learn process cwd (`C:\Windows\System32` under a scheduled task) and scans it; `listAgentProcesses` starts a Windows PowerShell per poll per agent (615 starts in 8 minutes); `.learn.pids` keeps a dead pid after a crash.
- [x] **Tests inherit the machine `EPISODIC_MEMORY_*` env** — 2 tests failed locally and passed in CI: `EPISODIC_MEMORY_OLLAMA_FALLBACK_MODEL` sent a failed-Ollama test to a real Claude call. `test/setup-env.ts` deletes every variable that `test/test-env.ts` does not pin; the config dir points to a temporary folder. Five axes: reliability (no live model call from a test), security (no write to the live data); clones unchanged.
- [x] **Tests race the first model download on Windows** — with an empty cache every worker downloaded bge-small at once and the rename of the temporary file failed with EPERM (9 errors, 10 failed tests in 11 files). `test/global-setup.ts` loads the model once before the workers start; two empty-cache runs then passed in full. Five axes: stability (no first-run failures), reliability (a failed download stops the run at once with one error).
- [ ] **Vitest fail-fast guard for a missing fake** — a test that gives no fake judge, agent runner or text model reaches the real model and stalls to its timeout. Make the default fail at once in tests.
- [x] **Digest keeps raw numeric citations** — stored digest text keeps marks such as `[2]` and `[3]`. Reproduce with a test, then fix where the text is stored.
- [ ] **STE pass over the old prose of CLAUDE.md, docs/SCHEMA.md (learn section) and MCP-TOOLS.md (digest, skills)** - 2026-11-12: `repo-tools ste` still reports long sentences and unclear references in text that the topic docs did not touch.
- [ ] **Embedding-heavy tests time out under load** — 2026-11-12 full run: 3 failures near 12 s (`DO NOT INDEX marker`, `search` project filter, `learnSearch` hidden id), all pass alone and on the next full run (1165 of 1165). Find the shared cause (per-test timeout vs cold embedder per worker) and fix it at the root. Two more load failures on 2026-11-12, both fixed at the cause in topic Task 6: `relay-task6-findings` "spend outgrows the prechecked baseline" timed out at 30 s because its recall answers reached the default judge, a real Claude learn-model call (a probe counted 1 judge call per run, and it was the only default-judge call in the 508 learn tests); the test now passes a fake judge. `digest-hook` "finishes well under 2 s" timed the Node start too (2072 ms under load; idle: start 50 ms, hook 30 ms); it now subtracts a bare Node start and holds the hook to 1000 ms. The embedding-heavy timeouts above stay open.
- 2026-11-12 five-axis (topic Tasks 1-3 fixes): speed n/a; stability: the flake above is recorded; reliability: a valid document with a code fence is no longer refused, a stale link slug no longer blocks a regroup; security: a source that is not an exchange id can no longer be stored silently; maintainability: one FTS query builder and one reference pattern. clones 3 exact, 2 text, 12 near before and after, none in this diff.
- [ ] **Declutter: `repo-tools clones` groups** — 2026-11-12 run: 3 exact, 2 text, 12 near groups (none in the digest-fix diff). Read both bodies of each pair; merge real duplicates, tests first.
- 2026-11-12 five-axis (digest Ollama fix): speed n/a; stability: suite no longer reads the machine's Ollama model; reliability: digest writes again on Ollama, stale bundle rebuilt, CI dist-freshness gate; security n/a; maintainability: one flaky run of the `search` project-filter test (10.3 s, passed twice after) left to watch. clones 17 groups before and after, none in this diff.
- [x] **Digest silent on Ollama since 2026-10-19** — `callOllama` refused every reply without `<summary>`; digest and learn calls now pass `requireSummaryBlock: false`. Also: stale committed bundle (old zod) rebuilt and a CI freshness check added; the suite no longer reads the machine's Ollama model.
- [x] **Self-improving memory (Recursa)** — design spec at `docs/superpowers/specs/2026-11-05-recursa-self-improving-memory-design.md`, plan at `docs/superpowers/plans/2026-11-05-recursa-self-improving-memory.md` (11 tasks: knowledge store, gates, `skills` tool, archive-graded task generation + grading, in-process tool server + solver, `learn` CLI, bootstrap, leaf learner, recursive learner, export/approval/doctor, docs). All 11 tasks shipped 2026-11-06 (Tasks 0–10 as PRs #21–#30, Task 11 as the docs PR). Originally backed by `@danielsimonjr/memoryjs` (spec decision 10); replaced by a native `better-sqlite3` store on 2026-11-06 (PRs #34–#35), same on-disk layout. Flag `EPISODIC_MEMORY_LEARN`, off by default; Node floor 22.12. Remaining for the owner, both human steps from the plan: the dual-machine plugin-cache install check (Step 3) and the live-archive smoke run plus `learn approve` decision (Step 5).

- [x] **Combined memory digest** — shipped in v1.7.0 (#13, #14): `src/digest-*.ts` (storage, validation, prompts, session job, day/week compression, injection hook, `digest` tool). Spec phases 1-5 done: `EPISODIC_MEMORY_DIGEST=1` is set on both machines, and the EVO sync logs written entries.

- [x] **CI RED: `bun audit --audit-level=critical` fails (2026-10-07 22:14)** — 3 new critical advisories: proxy-addr 2.0.7 (via claude-agent-sdk > MCP sdk > express) and tinypool 1.1.1 (via vitest). Found on docs PR #10; main last ran green 2026-09-24, before the advisories. Fix at the parent with `bun audit fix`, verify the resolved lockfile and the full suite, then merge so #10 can go green. DONE: merged in #11 (130c5d0); `bun audit --audit-level=critical` reports none; typecheck clean, 72 files / 355 tests pass.

### Immediate (next session-or-two)

- [x] **Swap install source from upstream → fork** — done: `installed_plugins.json` lists only `episodic-memory@local-marketplace`.
- [x] **Verify fork install works end-to-end** — done: the fork serves the MCP tools on both machines, and the scheduled sync runs the installed version with rc 0.
- [x] **Monitor obra/episodic-memory#95 for merges** — closed upstream: #95 is a closed issue, fixed by upstream commits `32c8382` and `a3438a6` (v1.4.2). The upstream sync row below owns what is left.

### Short-term (1-3 months, mirrors `docs/roadmap/now.md`)

- [x] **SessionStart sync failures should not be silent** (upstream #94) — `cli/sync-hook.js` logs to `sync-errors.log` and always exits 0; `doctor` surfaces last 5 errors.
- [x] **`doctor` Windows diagnostics** — default `episodic-memory doctor` reports plugin/node_modules sentinels, DB stats, hook errors, EMBEDDING_VERSION drift; `--json` supported.
- [x] **Search-result summary visibility** (upstream #74) — summaries in markdown + MCP JSON + multi-concept; `EPISODIC_MEMORY_INCLUDE_SUMMARY` flag.
- [ ] **Upstream sync: triage the 40 obra commits since the fork point (v1.4.2 to v1.6.0)** — no fork patch went upstream as a PR, so the original trigger cannot happen. Classify each commit as already in the fork, port, or skip, with evidence. Port by cherry-pick, one PR per fix. Do not merge `upstream/main`: the fork diverged in the summarizer, sync and indexer.
- [x] **`.gitattributes` eol normalization** — done in `5dd7e3d`: `* text=auto eol=lf` plus `"newLine": "lf"` in tsconfig, so a Windows build leaves `dist/` clean.

### Medium-term (3-6 months, mirrors `docs/roadmap/next.md`)

Themes (not individual tasks; promote into tasks here as plans firm up):

- [ ] **Theme 1: Better first-run install story** — progress reporting, doctor install command, failure recovery hints
- [ ] **Theme 2: Search quality experiments** — the archive-graded eval harness shipped with Recursa (`learn tasks` + `learn solve` + `learn report`: held-out `test` split, pass rate per kind and tier before and after). Remaining: label ≥50 real "find that conversation where I…" queries on top of it, then ship one quality improvement (summary visibility or rank fusion) with a measured win; LEANN feasibility study
- [ ] **Theme 3: Embedding pipeline modernization** — compare bge-small / gte-small / mxbai-embed-large against the current bge-small-en-v1.5 (q8, 384 dims); reversible upgrade if winner emerges
- [ ] **Theme 4: Observability & debugging UX** — structured sync log, `doctor` expansion, DEBUG=episodic:* flag, local metrics counters
- [ ] **Theme 5: Cross-harness integration polish** — harness detection metadata, summarization fallback chain
- [ ] **Theme 6: Multi-machine foundation (import/export)** — per-machine identity tagging, bundle export/import; full sync deferred to `later.md`
- [x] **Theme 7: Security hardening sweep** — `docs/security.md` written; secret redaction + MCP realpath/`read` caps + dir modes + optional `EPISODIC_MEMORY_MCP_TOKEN` shipped. Residual: SQLCipher opt-in (documented as filesystem encryption).

---

## Deferred (from prior work)

### Items that were considered but not pursued this cycle

- [ ] **`: any` type tightening** — 16 sites in `src/` use `any` at DB-row + JSONL-payload trust boundaries. Tightening to `unknown` + type guards is a real refactor. Defer until a quality reason exists; don't churn for cosmetics.
- [ ] **Major dep bumps** — typescript 5→6, marked 16→18, @types/node 24→25. All cross-major; each needs its own evaluation. vitest is already on 4. The dependency-minimization plan (row in the Active queue) owns the dependency list.
- [x] **Parser TODO** at `src/parser.ts:207` — Claude `tool_result` now matches `tool_use_id` the same way Codex matches `call_id`.

### Upstream behavior we're tracking but not contributing to

- [ ] **LEANN integration** (upstream #46) — interesting but speculative for now; reconsider after the eval harness from `next.md` Theme 2 exists
- [ ] **AWS Bedrock support** (upstream #44) — fork doesn't need it; track upstream, contribute if direction matches

---

## Conventions

### Repo state

- **Repo:** `~/Github/episodic-memory` (local working dir)
- **Origin:** `danielsimonjr/episodic-memory` (a fork)
- **Upstream:** `obra/episodic-memory`
- **Default branch:** `main` is protected (required CI check `build`): every change goes on a branch and a pull request.
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

- **stdio MCP servers MUST log to stderr.** `console.log` from any module reachable from `mcp-server.ts` corrupts JSON-RPC. The reachable modules are listed in the first rule of the stderr-only section of `CLAUDE.md`.
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
