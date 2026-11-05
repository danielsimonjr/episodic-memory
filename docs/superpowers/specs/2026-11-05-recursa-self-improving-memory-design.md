# Recursa for episodic-memory: a self-improving knowledge repository over the conversation archive

Status: draft for review. Implementation plan beside this file:
`docs/superpowers/plans/2026-11-05-recursa-self-improving-memory.md`.

Source paper: Zhu, Lin, Shi, Lin, Zhou. *Recursa: Toward Recursively Self-Improving Foundation Model
Systems.* arXiv:2611.04035, November 2026.

## 1. Purpose

The plugin today stores two things: a complete, searched-on-demand **index** of past conversations, and a
small, cited, always-loaded **digest** of recent sessions. Both are *episodic*: they say what happened.
Neither says how to use the archive well. Every session rediscovers which project key holds which work,
which search mode finds release decisions, which terms the user used for a concept, and which old
conversations are superseded. The `search-conversations` agent reads the same fixed prompt it read in
May.

Recursa names this the **knowledge gap** (the system does not know the domain's facts, terms, or where its
materials are) and the **behavior gap** (the system has the facts and applies them wrongly). It closes both
with a **knowledge repository** of three learnable parts, *instructions*, *skills* and *memory*, that the
system's own model bootstraps from the corpus and then refines from task experience, with parallel
learners whose edits are validated before they are kept, and with no human expert or stronger model
writing the revisions.

This design adds that repository to the plugin. The corpus is the user's own conversation archive. The
training tasks are generated from the archive itself, and the archive supplies the grade: a task built from a
held-out exchange has a known source, so a solver's answer can be checked without a rubric author. The
result is a plugin whose recall gets better with use, and whose every learned fact cites the conversations
it came from.

The plugin name, id, install path, hooks and existing tools do not change. Everything here is behind a
feature flag that defaults to off.

## 2. Scope

In scope:

- A **knowledge store** for instructions, skills and reflections, beside the digest, with citations,
  versions, status and an additive-only rule.
- A **bootstrapping job** that builds a navigation skill and exploration notes per project from the
  archive, with parallel per-project learner agents and one merging orchestrator (paper §4).
- A **self-practice task generator** that makes graded retrieval and recall tasks from held-out exchanges
  (paper §4.2), with a stratified train/test split that learners never see.
- A **recursive self-improvement job**: `LEARN(D, K)` with solvers, leaf learners, splitting, merging,
  validation and reflection (paper §5, Algorithm 1).
- A **learning trace** (runs, tasks, attempts, snapshots) that `learn report` reads and that the eval
  harness of roadmap theme 2 reuses.
- **Delivery into sessions**: a bounded instructions block in the SessionStart hook, a skills index in the
  same hook, a `skills` MCP tool for on-demand loading, and an export of active skills in the Agent Skills
  format.
- Safety: feature flag, reentrancy guard, GPU reservation, redaction, citation gates, prompt-injection
  screening of learned text, approval mode, budgets, locks.

Out of scope:

- A Python REPL harness or any change to how Claude Code executes tools. Claude Code and Codex are the
  harness. The paper's harness contributions (tool composition, programmatic context management) are
  mapped onto what already exists, see §4.3, and are not rebuilt.
- Training foundation model weights. The paper also defers this.
- Any change to archiving, parsing, embedding or the digest's own tiers.
- Any deletion of exchanges, digest entries or knowledge entries.
- Learning from a Codex-only install in the first release. Codex transcripts are indexed and searched as
  today; the learner and solver agents run on the Claude Agent SDK, which is already the summarizer's
  default backend. The ollama backend is a text-only model call and cannot drive a tool-using solver; see
  §12 decision 3.

## 3. What exists today (verified in `src/` on 2026-11-05)

| Part | File | Use in this design |
|---|---|---|
| Exchange table with `id`, `project`, `session_id`, `timestamp`, `archive_path`, `line_start`, `line_end` | `db.ts`, `docs/SCHEMA.md` | Source of every task, every citation, every grade |
| Vector and text search, multi-concept AND, metadata filters | `search.ts` | The solver's main tool; the thing the instructions learn to use well |
| `digest_entry` with cited lines, `[#id]` marks, FTS mirror, handoff notes | `digest-db.ts`, `digest-validate.ts`, `digest-prompts.ts` | The **memory** tier already exists. Reflections reuse its citation grammar. |
| `parseCitedLines`, `redactEntryText` | `digest-validate.ts` | Reused unchanged as the citation gate for skills and reflections |
| Summarizer backends and `callModel` with model, fallback, timeout, guard env | `summarizer.ts`, `ollama-backend.ts` | Text-only calls (task paraphrase, judge, merge prompts) go through `callModel` |
| Claude Agent SDK 0.3.299: `query()` with `allowedTools`, `mcpServers`, `maxTurns`, `maxBudgetUsd`, `settingSources`, `persistSession`, `createSdkMcpServer`, `tool` | `node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts` | Tool-using solver and learner agents, with the plugin's tools served in-process |
| Reentrancy guard | `reentrancy.ts` | Every SDK subprocess inherits it; every learner entry point checks it first |
| GPU reservation | `gpu-reservation.ts` | The learner honours it the way the digest does |
| Lock file with PID liveness and stale recovery | `lockfile.ts` | One learning run at a time |
| Redaction | `redact.ts` | All text in, all text out |
| Archive-confined `read`, `digest` tool, tool dispatch and Zod schemas | `mcp-tools.ts`, `mcp-schemas.ts`, `archive-path.ts` | Add `skills`; expose the same handlers in-process to solvers |
| SessionStart hooks (`sync-hook.js`, `digest-hook.js`), fast path with no embedding imports | `hooks/hooks.json`, `cli/digest-hook.js` | The instructions block and skills index ride on the digest hook |
| Search agent and skill | `agents/search-conversations.md`, `skills/remembering-conversations/` | Taught to consult the skills index and load a skill before searching |
| Umbrella CLI | `cli/episodic-memory.js` | Add the `learn` subcommand |
| `doctor` | `doctor.ts` | Reports knowledge store size, last run, pending approvals |

## 4. Mapping the paper onto the plugin

### 4.1 Learnable components `K`

| Recursa | episodic-memory | Loaded |
|---|---|---|
| **Instructions**: system prompt, guardrails, guidance present at every step | `knowledge_entry` rows of kind `instruction`, scoped to a project or global. Short lines on *how to search this archive*: which mode, which filters, which terms, which project keys, known traps. | Always, by the SessionStart hook, under a character budget, after the digest |
| **Skills**: reusable procedural packages loaded on demand, Agent Skills format | `knowledge_entry` rows of kind `skill`, each a `SKILL.md`-shaped body with name, description (when to use), scope, confidence, sources. Two forms from the paper: a **navigation skill** per project (map of sessions, periods, topics, where things are, what is absent) and **procedure skills** (how to answer a class of question against this archive). | On demand: the hook prints a one-line index; the `skills` tool returns a body |
| **Memory**: reflections learners record on past executions and learning | `knowledge_entry` rows of kind `reflection`, cited to attempts and exchanges, plus the existing `digest_entry` rows. | By learners at the start of a learning task; never injected into user sessions |
| **Harness** (fixed in the paper) | Claude Code or Codex, plus this plugin's MCP tools | n/a |
| **Foundation models** (fixed) | The configured SDK model for solver, learner and judge; the same model for all three by default, as in the paper | n/a |

### 4.2 Agents

| Recursa role | Here | Runs as |
|---|---|---|
| **Solver** `SOLVE(x, K)` | Answers one task with the current instructions and skills, using `search`, `read`, `digest` and `skills` and nothing else. Returns an answer and a trace. | SDK `query()` subprocess; in-process MCP server; `maxTurns` and `maxBudgetUsd` capped |
| **Leaf learner** | Solve → diagnose → edit → validate loop over one task subset | SDK `query()` subprocess with the same tools plus a `propose_edit` tool that writes *candidate* entries only; validation runs in Node, not in the model |
| **Learner** (splitting) | Splits tasks by project, then by failure category; runs children in parallel; merges; reflects | Node orchestrator (`src/learn/learner.ts`) that spawns leaf learners; the split and merge decisions are model calls with bounded output |
| **Bootstrapper** | Per-project corpus mapping, exploration notes, self-practice tasks | SDK `query()` subprocess per project, in parallel, bounded concurrency |
| **Judge** | Grades a recall answer against the held-out assistant message when the deterministic grade is not enough | Text-only `callModel` |

### 4.3 Harness features the paper relies on, and what stands in for them

| Paper §3 feature | Purpose | Here |
|---|---|---|
| Tool composition in a persistent REPL | Keep intermediate results out of the model's context | Multi-concept `search`, `limit`, `startLine`/`endLine` paging on `read`, and the `search-conversations` subagent that returns a synthesis, not raw results. No REPL is added. |
| Programmatic context management over an append-only event log | Recover past evidence by address | The archive is the event log; `archive_path` plus a line range is the address; the `digest` tool's `expand` turns a `[#id]` mark into that address. Learner traces store addresses, not transcripts. |
| Multi-agent orchestration | Split large work | Node orchestrator plus SDK subagents with bounded concurrency |

### 4.4 Self-practice: tasks the archive can grade

The paper generates practice tasks from the corpus and lets the learner assess attempts. The archive gives a
sharper signal than that: every exchange has a known address. A task is built from one held-out exchange
`e`; the solver never sees `e`'s address or its assistant message; the grade compares what the solver found
to `e`.

| Task kind | Prompt to the solver | Ground truth | Grade |
|---|---|---|---|
| `locate` | "A user once asked: *paraphrase of e.user_message*. Find the conversation where this was addressed. Return its archive path, a line range, and the project." | `e.archive_path`, `[e.line_start, e.line_end]`, `e.project` | **Deterministic.** Pass when the path matches and the ranges overlap. Partial credit when the session matches but the lines do not. |
| `recall` | The `locate` prompt plus "and state the outcome in two sentences". | `e.assistant_message` (redacted) | Deterministic location grade, then a judge call scores the outcome 0 to 1 against the source. Pass requires both. |
| `when` | "When did we last work on *topic from e*? Give the date and project." | `e.timestamp`, `e.project` | Deterministic: same day and project. |
| `multi` | "What did we decide about *A* and what caused *B*?" built from two exchanges in one session | Both addresses | Deterministic: both found. |

Difficulty tiers come from the paraphrase: tier 1 reuses the user's words, tier 2 is a model paraphrase with
no shared rare term, tier 3 adds a wrong-but-plausible detail that must be rejected. The paraphrase is a
text-only `callModel` call made once at generation time and stored with the task.

Selection rules for `e`: a non-sidechain exchange with a user message of at least 80 characters and an
assistant message of at least 200, not a summarizer or digest transcript (the exclusion markers in `sync.ts`
already keep those out of the index), from a project with at least 20 indexed exchanges. Tasks are stratified
by project and tier, split 60/40 into `train` and `test` with a fixed seed stored on the run, and the `test`
split is never read by a learner. A task's source exchange is excluded from the digest text shown to its
solver so that the digest cannot leak the answer.

## 5. Data model

Three new tables and one new FTS table in the same SQLite database. Migrations are idempotent and run from
`migrateSchema` in `db.ts`.

### `knowledge_entry`

| Column | Meaning |
|---|---|
| `id` | Primary key |
| `kind` | `instruction`, `skill` or `reflection` |
| `project` | Project key as in `exchanges.project`, or `*` for all projects |
| `slug` | Stable name; for a skill, its directory name in the export |
| `version` | Integer from 1; a revision inserts a new row and sets `superseded_by` on the old one |
| `title` | One line |
| `description` | When to use it, one or two lines (the Agent Skills `description`) |
| `body` | Instruction lines, the `SKILL.md` body, or the reflection text. Every fact line ends in `[#id,...]` marks in the digest grammar. |
| `scope` | Where it applies and where it does not, one or two lines (paper §4.1: every entry states its applicable scope) |
| `confidence` | `low`, `medium` or `high` (paper §4.1: every entry states its uncertainty) |
| `sources` | JSON array of `exchanges.id` values cited by the body |
| `status` | `candidate`, `active`, `retired` |
| `run_id` | The learning run that wrote it |
| `created_at` | Creation time |
| `superseded_by` | Id of the newer version, or null |
| `validation` | JSON: tasks checked, passed before, passed after, regressions |

Unique on `(kind, project, slug, version)`. `knowledge_fts` mirrors `title`, `description` and `body`.

### `learning_run`

| Column | Meaning |
|---|---|
| `id` | Text id, `run-<timestamp>-<random>` |
| `phase` | `bootstrap` or `improve` |
| `parent_run_id` | For child learners; null for the top-level run |
| `project` | The subset's project, or `*` |
| `status` | `running`, `done`, `stopped`, `failed`, `deferred` |
| `started_at`, `finished_at` | Times |
| `budget` | JSON: calls, USD, wall clock, rounds, concurrency, and what was used |
| `metrics` | JSON: pass rate before and after on train and on test, per tier |
| `seed` | The split seed |

### `learning_task`

| Column | Meaning |
|---|---|
| `id` | Primary key |
| `run_id` | The run that generated it. Tasks are reused by later runs. |
| `kind` | `locate`, `recall`, `when`, `multi` |
| `tier` | 1, 2 or 3 |
| `split` | `train` or `test` |
| `project` | Project of the source exchange |
| `prompt` | The redacted text given to the solver |
| `truth` | JSON: source exchange ids, paths, line ranges, timestamp, redacted assistant message |

### `learning_attempt`

| Column | Meaning |
|---|---|
| `id` | Primary key |
| `task_id`, `run_id` | Keys |
| `snapshot_id` | The `knowledge_snapshot` the solver ran with |
| `role` | `solve`, `validate`, `merge-check` |
| `passed` | 0 or 1 |
| `score` | 0 to 1 |
| `answer` | Redacted, capped at 4000 characters |
| `trace` | JSON list of tool calls as `{tool, args, resultAddress}`; result text is not stored, only addresses and sizes |
| `cost` | JSON: turns, input tokens, output tokens, USD when known |
| `created_at` | Time |

### `knowledge_snapshot`

`id`, `run_id`, `created_at`, `entry_ids` (JSON). A snapshot is `K^(t)`: the set of active entries a solver
ran with. Metrics compare snapshots, and `learn report` names them.

### Export

Active skills are written to `<configDir>/learned-skills/<project>/<slug>/SKILL.md` with frontmatter
`name`, `description`, and a `metadata` map holding `scope`, `confidence`, `sources`, `version`, `run`. The
directory is regenerated from the database on every change; the database is the source of truth. An
optional `learn export --to <dir>` copies the same tree into a project's `.claude/skills/` so that Claude
Code's native skill loader can see them. That copy is explicit and user-run; nothing writes into a project
directory on its own.

## 6. Data flow

### 6.1 Bootstrapping (`episodic-memory learn bootstrap`)

1. Acquire `.learn.lock`. Check the flag, the guard, the GPU reservation. Create a `bootstrap` run.
2. List projects with at least 20 indexed exchanges. For each, in parallel up to `concurrency`, start one
   **bootstrapper** subprocess with the tools `search`, `read`, `digest`, `skills` and `propose_entry`. Its
   brief: map this project. Read the digest, sample sessions across the whole time span, name the periods
   of work, the topics, the terms the user uses, the sessions that supersede others, what is absent, and
   the boundaries of the corpus. Write one `skill` of slug `navigation` and one `skill` of slug
   `exploration-notes`, each line cited.
3. Each proposed entry passes the gates of §7 and is stored as `candidate`.
4. The orchestrator merges: it reads all candidates, asks the model for one global `instruction` entry
   (how to search this archive as a whole: project keys, time spans, which mode for what) with the
   candidates as evidence, and stores it as `candidate`.
5. Self-practice: generate tasks (§4.4) for every eligible project. Store them. Run the solver on the
   `train` split with no knowledge (snapshot `K^(0)` empty) and again with the bootstrapped candidates.
   Record both pass rates on the run. Activate the candidates that do not lower the train pass rate. This
   is the paper's Figure 4 check: bootstrapping should cut turns and tokens without lowering accuracy.
6. Write a `reflection` entry for the run (what mapping worked, what did not, with attempt ids as sources).
   Release the lock. Print the report.

### 6.2 Recursive self-improvement (`episodic-memory learn improve`)

Implements Algorithm 1 with `D` = the `train` tasks and `K` = the active entries.

1. Lock, flag, guard, reservation, run row, snapshot `K^(t)`.
2. **Solve.** Run solvers on all of `D` in parallel (bounded). Record attempts.
3. **Split.** If the failing tasks span more than one project, or more than `leafMax` tasks (default 12),
   the learner splits: first by project, then by failure category assigned by one model call over the
   failed traces (for example "wrong project", "right session wrong lines", "right text wrong date",
   "paraphrase not matched", "rejected a correct result"). Each subset becomes a child run with its own
   `learning_run` row and `parent_run_id`.
4. **Leaf learner loop** on a subset, repeated up to `rounds` (default 3) or until no edit passes:
   - *Diagnose.* Read the subset's failed attempts (traces, not transcripts), the current instructions and
     skills, and the reflections from earlier runs. Separate solver error from task noise: a task that two
     solvers fail in different ways with a correct-looking answer is marked `suspect` and excluded from the
     edit's validation set; the paper's §6.1 criterion revision is the same move, done by a program here.
   - *Edit.* Propose at most `editsPerRound` (default 3) entries through `propose_entry`: a new version of an
     instruction, a new or revised skill, or a reflection. Each proposal names the failed tasks it targets.
   - *Validate.* In Node, not in the model: re-solve the targeted tasks and a random sample of the subset's
     passed tasks (default 5) with the candidate applied. Keep the candidate only if at least one targeted
     task now passes and no sampled task regresses. Store the result in `validation`.
5. **Merge.** The parent collects its children's kept entries. Duplicates (same `kind`, `project`, `slug`)
   are resolved by one model call that writes a merged body citing the union of sources; conflicting
   instructions are resolved the same way with the conflict named in a reflection. The merged set is a new
   snapshot. The parent re-solves a sample of every child's tasks (default 5 each) with the merged set; a
   merged entry that regresses a child's gains reverts to that child's version.
6. **Reflect.** The parent writes one `reflection` per round: which subsets improved, which edits
   conflicted, which tasks look unreliable, and the stalls and rework it can see in the children's traces
   (paper §5.3). Reflections cite attempt ids and exchange ids.
7. **Round end.** Metrics on `train`. Stop when no edit was kept, when `rounds` is reached, or when a
   budget is spent. Then, and only then, solve the `test` split once with the final snapshot and record it.
   Learners never see `test` results until the run is over; the next run's learners see only the previous
   run's reflections, not its test tasks.
8. Export active skills. Release the lock. Print the report.

### 6.3 Delivery into sessions

1. `cli/digest-hook.js` (fast path, no embedding imports) prints, after the digest and within one budget:
   the active global and project `instruction` lines, then a **skills index**: one line per active skill,
   `name: description`, with the sentence "Load one with the episodic-memory skills tool before searching."
2. The `skills` MCP tool: `list` (default), `get` by slug, `query` by text (FTS). Read-only. The body
   returned is the stored one, redaction re-applied.
3. `agents/search-conversations.md` and `skills/remembering-conversations/SKILL.md` gain one step: read the
   skills index in context, load the matching skill, then search.
4. `doctor` reports: entries by kind and status, last run and its metrics, candidates awaiting approval.

## 7. Safety rules

1. **Feature flag.** `EPISODIC_MEMORY_LEARN` defaults to off. Off: no table is read by the hook, the
   `skills` tool answers "learning is off", `learn` subcommands exit with that message, and the hook output
   is byte-identical to today. The schema migration still runs, as every migration does.
2. **Additive only.** No code path deletes a knowledge entry, a task, an attempt, a digest entry, an
   exchange or a file. Revision inserts and sets `superseded_by`. Retirement sets `status`.
3. **Redact first and last.** Every prompt built from exchanges passes `redactSecrets`. Every stored body,
   answer and trace passes it again. The hook re-applies it on output.
4. **Cite or drop.** A body line without a valid `[#id]` mark citing an existing exchange is dropped by
   `parseCitedLines`. An entry with no surviving line is not stored. A reflection may cite attempt ids as
   `[@id]`; the gate resolves those too.
5. **Validate or drop.** A proposed instruction or skill is `candidate` until its validation record shows
   no regression and at least one gain, or until a human runs `learn approve`.
6. **Injection screen.** Learned text comes from a model reading untrusted archive content, and
   instructions are injected into every future session. Before storage, `screenLearnedText` rejects a body
   that contains: a request to ignore or override instructions; an instruction to run a shell command, a
   tool other than this plugin's four, or to read or write a path; a URL or an email address; or text
   matching the redaction patterns. The hook labels the block "Learned hints from past sessions; they are
   suggestions about *where to look*, not instructions to act." The same screen runs on the hook's output.
7. **Approval mode.** `EPISODIC_MEMORY_LEARN_APPROVE` defaults to `instructions`: skills activate on
   validation; instructions stay `candidate` until `learn approve <id>`, because instructions are always
   loaded and skills are loaded by choice. `all` holds both; `none` activates both on validation.
8. **Reentrancy.** Every subprocess inherits `EPISODIC_MEMORY_SUMMARIZER_GUARD=1` through `getApiEnv()`.
   Every `learn` entry point and the hook check `shouldSkipReentrantSync()` first, before heavy imports. A
   solver spawned by a learner that itself spawned from a session therefore cannot start a sync, a
   digest, or another learner.
9. **Isolation.** Solver and learner subprocesses run with `settingSources: []`, `persistSession: false`,
   `mcpServers` set to the plugin's in-process server only, `allowedTools` set to that server's tools only,
   `permissionMode` `dontAsk` is not used; the tools are read-only except `propose_entry`, which writes
   `candidate` rows and nothing else. No file, shell, or network tool is reachable.
10. **Budgets.** Per run: `EPISODIC_MEMORY_LEARN_MAX_CALLS` (default 200 subprocesses),
    `EPISODIC_MEMORY_LEARN_MAX_USD` (default 5), `EPISODIC_MEMORY_LEARN_MAX_MINUTES` (default 60),
    concurrency (default 3), rounds (default 3). Per subprocess: `maxTurns` (solver 12, learner 30),
    `maxBudgetUsd`, and an `AbortController` timeout as the summarizer already uses. A spent budget stops
    the run with status `stopped` and keeps everything validated so far.
11. **One run at a time.** `.learn.lock` in the index directory, through `lockfile.ts`. The sync's
    `.sync.lock` is separate; a learning run waits for no sync and a sync waits for no learning run, since
    both only insert rows and SQLite serialises writes under `busy_timeout`.
12. **GPU reservation.** When the reservation file names a holder, `learn` exits with `deferred`, as the
    digest does, even though the Claude backend does not use the GPU, because a learning run is a heavy
    local process and the fleet rule is "do not compete".
13. **Test split integrity.** `test` tasks are excluded from every learner prompt by query, not by
    convention, and the run row records the seed so a later run can prove the split did not move.
14. **No new network target.** All model calls go through `getApiEnv()` and the existing base-URL check.
15. **Never from a hook.** No SessionStart hook starts a learning run. The cost and duration make it a
    deliberate CLI action. A `--background` option may come later behind its own flag.

## 8. Runtime and build

- TypeScript ESM under `src/learn/`; bundled with the rest by `bun run build`; `dist/` committed.
- Entry points run on `node`. The hook stays on its fast path: it imports `better-sqlite3` and small
  `dist/` modules only; no SDK, no transformers, no sqlite-vec.
- `cli/episodic-memory.js learn <bootstrap|improve|status|report|approve|export|tasks>` dispatches to
  `dist/learn-cli.js`, which checks the guard and flag before any heavy import, as `sync-cli.ts` does.
- The in-process MCP server for subprocesses is built with the SDK's `createSdkMcpServer` and `tool` and
  calls `handleToolCall` from `mcp-tools.ts` directly, so solvers use the exact search, read and digest
  code that sessions use, with the same path confinement and redaction.
- Windows: paths through `path.join`; the lock and export directory under the config dir; `safeRmSync` in
  tests.

## 9. Licensing and provenance

The paper is a method description. No code is published with it that this design copies. Prompts, table
names and tests are written from this document. The Agent Skills format is an open specification and the
export follows its `SKILL.md` layout.

## 10. Test plan

Tests come first. Each safety rule in §7 has a failing test before its code. All model calls are injectable
and tests pass fakes; no test reaches a model or a GPU (the vitest config already pins a closed backend).

- Schema: migration creates the four tables twice without error; unique key rejects a duplicate version.
- Citation gate: a skill body line with no mark or an unknown mark is dropped; an entry with no surviving
  line is not stored; `[@attempt]` marks resolve against `learning_attempt`.
- Injection screen: each listed pattern is rejected; a plain cited line passes; the hook output of a
  planted bad entry is empty for that entry.
- Redaction: a planted token in an exchange appears in no task prompt, truth, attempt, entry or hook output.
- Task generation: selection rules hold; split is stratified and reproducible from the seed; a task's
  source exchange is absent from the digest text shown to its solver.
- Grading: `locate` passes on path match and line overlap, partial on session match, fails otherwise;
  `when` on same day and project; `multi` needs both; `recall` needs location plus judge score at or above
  the threshold.
- Leaf loop: with a fake solver whose pass set is a function of the active entries, an edit that fixes a
  target and regresses nothing is kept; one that regresses a sampled task is dropped; a round with no kept
  edit ends the loop.
- Split and merge: failures in two projects produce two child runs; duplicate slugs merge into one entry
  citing the union; a merged entry that regresses a child's gains reverts.
- Test-split integrity: no learner prompt in a run contains a `test` task; the seed on the run reproduces
  the split.
- Budgets: a call cap stops the run with `stopped` and keeps validated entries; a timeout aborts a
  subprocess and counts as a failed attempt.
- Reentrancy: with the guard set, `learn improve` exits before importing the SDK; the hook prints nothing
  for the learned block.
- Flag off: hook output equals the current output byte for byte; `skills` tool reports learning is off.
- Approval: under the default mode an instruction stays `candidate` after validation and a skill becomes
  `active`; `learn approve` activates; `learn approve` on a failed-validation entry refuses.
- Export: the tree matches the active skills; a retired skill's directory is removed on the next export;
  `--to` writes nowhere but the named directory.
- Lock: a second `learn improve` during a run exits with the holder's PID.
- Hook budget: the learned block never exceeds `EPISODIC_MEMORY_LEARN_MAX_CHARS` (default 2500), is
  ordered instructions then index, and ends on a whole line.

## 11. Phases

1. Store, gates, screen, flag, `skills` tool, hook block. Flag off. Nothing learns yet.
2. Task generation, grading, solver runner, `learn tasks` and `learn solve` (a baseline-only run). This is
   the eval harness of roadmap theme 2 and is useful on its own.
3. Bootstrapping with parallel bootstrappers and the merge step.
4. Leaf learner loop with validation.
5. Splitting, merging, reflection, test-split evaluation, `learn report`.
6. Export, agent and skill prompt updates, `doctor`, README, CHANGELOG, build, install check on both
   machines, then enable the flag and run `bootstrap` on the live archive.

## 12. Decisions on open questions

1. **Same model for solver, learner and judge** (`EPISODIC_MEMORY_LEARN_MODEL`, default `sonnet`; the
   summarizer's `haiku` default is too weak to diagnose traces). The paper's thesis is improvement without
   a stronger model; keeping one model makes that claim testable here. A separate judge model is a setting,
   not the default.
2. **The archive grades, not a rubric.** Deterministic location grades carry the signal; the judge is used
   only for `recall` and never alone. This differs from the paper, whose tasks need a rubric and a judge
   model, and it is the reason the method fits this plugin: supervision is free.
3. **Claude SDK backend only for agents in release 1.** The ollama backend stays for text-only calls
   (paraphrase, judge, merge) when configured. Tool-using solvers on ollama need a tool-calling loop that
   does not exist in `ollama-backend.ts`; it is a later theme.
4. **Reflections live in `knowledge_entry`, not `digest_entry`.** The digest's tier check constraint
   cannot be altered in place in SQLite, and reflections are for learners, not for session injection.
5. **Instructions need approval by default; skills do not.** See §7 rule 7.
6. **Learning never runs from a hook.** See §7 rule 15.
7. **Codex sessions are corpus, not harness.** Their exchanges generate tasks and citations like any other;
   the agents run on the Claude SDK.
