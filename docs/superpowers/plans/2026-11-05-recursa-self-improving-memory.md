# Recursa Self-Improving Memory: Subagent-Driven Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement
> this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Each task below is one
> dispatch: an **implementer** subagent gets the task's brief verbatim plus the Global Constraints, a
> **spec reviewer** subagent checks the diff against the task's Interfaces and the spec section it names,
> and a **code reviewer** subagent (`pr-review-toolkit:code-reviewer` or `/code-review high`) runs on the
> diff before the commit. Findings at or above confidence 70 are fixed before the commit. A task is done
> when its gate passes, not when its code is written.

**Goal:** Give the plugin a knowledge repository (instructions, skills, reflections) that the system's own
model bootstraps from the conversation archive and refines through validated, parallel self-improvement,
following Recursa (arXiv:2611.04035), with every learned line cited and nothing ever deleted.

**Architecture:** Four new tables (`knowledge_entry` with FTS mirror, `learning_run`, `learning_task`,
`learning_attempt`, `knowledge_snapshot`). A `learn` CLI with `bootstrap`, `improve`, `tasks`, `solve`,
`status`, `report`, `approve`, `export`. Solver, leaf learner and bootstrapper agents run as Claude Agent
SDK subprocesses with the plugin's tools served in-process through `createSdkMcpServer`; the learner
orchestrator (split, validate, merge, reflect) is Node code. A `skills` MCP tool and a bounded learned
block in the digest hook deliver the result into sessions.

**Tech Stack:** TypeScript ESM, Bun (install, test, typecheck, bundle), Node at runtime, `better-sqlite3`,
`@anthropic-ai/claude-agent-sdk` 0.3.299 (`query`, `createSdkMcpServer`, `tool`, `allowedTools`,
`maxTurns`, `maxBudgetUsd`, `settingSources`, `persistSession`), vitest 4.

**Spec:** `docs/superpowers/specs/2026-11-05-recursa-self-improving-memory-design.md`

## Global Constraints

Every implementer receives this list with its task.

- Plugin name, id, install path, hooks list and existing tools stay as they are.
- Source is TypeScript ESM under `src/learn/` (new) plus the named edits to existing files. Shipped entry
  points run on `node`; no `bun` at runtime.
- Feature flag `EPISODIC_MEMORY_LEARN` defaults off. Flag off: the digest hook output is byte-identical to
  today, the `skills` tool answers that learning is off, every `learn` subcommand exits 0 with that message.
  The schema migration runs regardless, as every migration does.
- Additive only: no code path deletes a knowledge entry, task, attempt, snapshot, digest entry, exchange or
  file. Revision inserts and sets `superseded_by`; retirement sets `status`. The export directory is the one
  exception: it is regenerated from the database and is not a source of truth.
- All text built from exchanges passes `redactSecrets` (`src/redact.ts`) before a model sees it and again
  before storage; the hook and the `skills` tool re-apply it on output.
- A body line without a valid citation is dropped by `parseCitedLines` (`src/digest-validate.ts`); an entry
  with no surviving line is not stored. Reflections may also cite attempt ids as `[@id]`.
- The injection screen (`screenLearnedText`) runs on every body before storage and on the hook's output.
- Instructions and skills are `candidate` until validation shows at least one gain and no regression;
  instructions additionally need `learn approve` under the default `EPISODIC_MEMORY_LEARN_APPROVE=instructions`.
- Every SDK subprocess gets `env: getApiEnv()` (which sets `EPISODIC_MEMORY_SUMMARIZER_GUARD=1`),
  `settingSources: []`, `persistSession: false`, `mcpServers` holding only the in-process plugin server,
  `allowedTools` naming only that server's tools, `maxTurns`, `maxBudgetUsd`, and an `AbortController`
  timeout. Nothing else is reachable.
- Every `learn` entry point and the hook call `shouldSkipReentrantSync()` before any heavy import (`src/
  reentrancy.ts`; pattern in `src/sync-cli.ts`). `learn` also calls `gpuReservationBlock()` and exits
  `deferred` when it names a holder.
- One learning run at a time: `.learn.lock` in `getIndexDir()` through `acquireLock`/`releaseLock`.
- Budgets: `EPISODIC_MEMORY_LEARN_MAX_CALLS` 200, `EPISODIC_MEMORY_LEARN_MAX_USD` 5,
  `EPISODIC_MEMORY_LEARN_MAX_MINUTES` 60, `EPISODIC_MEMORY_LEARN_CONCURRENCY` 3,
  `EPISODIC_MEMORY_LEARN_ROUNDS` 3, solver `maxTurns` 12, learner `maxTurns` 30. A spent budget ends the run
  with status `stopped` and keeps everything validated so far.
- The `test` split is excluded from every learner prompt by SQL predicate, never by convention. The split
  seed is stored on the run.
- The digest hook stays on its fast path: `better-sqlite3` plus small `dist/` modules; no SDK, no
  transformers, no sqlite-vec. Its learned block is capped by `EPISODIC_MEMORY_LEARN_MAX_CHARS` (2500).
- Model calls are injectable everywhere (`opts.model`, `opts.runAgent`); tests pass fakes and never reach
  a model, a subprocess or a GPU. Text-only calls go through `callDigestModel`'s sibling
  `callLearnModel` in `summarizer.ts` (same backend switch, model from `EPISODIC_MEMORY_LEARN_MODEL`,
  default `sonnet`).
- Windows: `path.join` everywhere; `safeRmSync` in `afterEach`; normalise both sides when comparing paths.
- `dist/` is committed; rebuild with `bun run build` and stage only files with real content changes.
- Commit messages follow the repo's `type(scope): subject` style with the `Co-Authored-By` footer the
  session's reminder gives; no model identifier in any pushed artifact.
- Log to stderr only in any module reachable from `mcp-server.ts` (`mcp-tools.ts` will import
  `src/learn/knowledge-db.ts` and `src/learn/learn-inject.ts`; both must be stdout-free).

## Review Focus

The spec reviewer and code reviewer are pointed at these on every task that touches the area.

- A transcript with a planted secret: it appears in no task prompt, truth, attempt, entry, export file,
  `skills` output or hook output.
- A model body with a line citing `[7]` when the prompt had 4 marks: the line is dropped; an entry with no
  other line is not stored.
- A model body containing "ignore all previous instructions", a `curl` command, a URL, or a path write: the
  entry is rejected by the screen and a `learn report` line says why.
- A learner prompt in a run: contains no `test` task text, id or truth.
- Flag off: hook output byte-identical; `skills` tool and `learn` say learning is off; no table is read.
- Guard set: `learn improve` exits before importing the SDK; the hook prints no learned block.
- A solver subprocess: `allowedTools` is exactly the five plugin tools; `settingSources` is `[]`;
  `persistSession` is `false`; `env` carries the guard.
- Two `learn improve` at once: the second exits naming the holder's PID; the first is unaffected.
- A kept edit: at least one targeted task passes that failed before, and no sampled passed task fails.
- A merged entry that regresses a child's gain: the child's version is restored and the merge is noted in a
  reflection.
- Budget cap hit mid-round: run status `stopped`, validated entries kept, `test` split evaluated once.
- Windows paths in task truth and in export: `path.join`, compared normalised.

---

### Task 1: Knowledge store schema and storage

**Spec:** §5 (`knowledge_entry`, `knowledge_snapshot`), §7 rules 1 and 2.

**Files:**
- Create: `src/learn/knowledge-db.ts`
- Modify: `src/db.ts` (`migrateSchema` calls `ensureKnowledgeSchema` after `ensureDigestSchema`)
- Modify: `docs/SCHEMA.md`
- Test: `test/learn/knowledge-db.test.ts`

**Interfaces:**
- Produces:
  - `type KnowledgeKind = 'instruction' | 'skill' | 'reflection'`
  - `type KnowledgeStatus = 'candidate' | 'active' | 'retired'`
  - `interface KnowledgeEntry { id: number; kind: KnowledgeKind; project: string; slug: string; version: number; title: string; description: string; body: string; scope: string; confidence: 'low'|'medium'|'high'; sources: string[]; status: KnowledgeStatus; runId: string; createdAt: string; supersededBy: number | null; validation: ValidationRecord | null }`
  - `interface ValidationRecord { targeted: number[]; sample: number[]; passedBefore: number; passedAfter: number; regressions: number[]; judgedAt: string }`
  - `ensureKnowledgeSchema(db): void` (creates `knowledge_entry`, `knowledge_fts`, `knowledge_snapshot`; idempotent)
  - `insertKnowledgeEntry(db, e: NewKnowledgeEntry): number` (next `version` for the slug is computed inside a transaction; the previous active or candidate version of the same `(kind, project, slug)` gets `superseded_by` set only when the new row becomes `active`, see `activate`)
  - `activate(db, id, validation): void`, `retire(db, id): void`, `setStatus` is not exported
  - `listActive(db, kinds: KnowledgeKind[], project: string): KnowledgeEntry[]` (project entries plus `*` entries, instructions first, then skills by slug)
  - `listCandidates(db, kind?)`, `getEntry(db, id)`, `getBySlug(db, kind, project, slug)`
  - `searchKnowledge(db, query, project?, limit?)` (FTS over title, description, body)
  - `createSnapshot(db, runId): number` (records the active entry ids) and `getSnapshot(db, id)`

- [ ] **Step 1: Write failing tests** `creates schema twice without error`, `second insert of a slug gets version 2`, `activate sets superseded_by on the older active version and keeps the row`, `retire hides from listActive and keeps the row`, `listActive returns global and project entries, instructions first`, `searchKnowledge finds a word in body`, `snapshot records active ids at creation and not later ones`, `migrateSchema on a legacy db creates the tables`.
- [ ] **Step 2: Run** `bun run test -- test/learn/knowledge-db.test.ts`. Expected: FAIL (module missing).
- [ ] **Step 3: Implement** per `src/digest-db.ts` style (same row mapping pattern, same transaction use). Add the tables to `docs/SCHEMA.md` with one line per column.
- [ ] **Step 4: Run** the file and `bun run typecheck`. Expected: PASS.
- [ ] **Step 5: Reviews, then commit** `feat(learn): knowledge store schema and storage`.

### Task 2: Gates: citation, redaction, injection screen, config

**Spec:** §7 rules 3, 4, 6, 7; §5 `confidence` and `scope`.

**Files:**
- Create: `src/learn/learn-config.ts`, `src/learn/learned-text-screen.ts`, `src/learn/knowledge-gate.ts`
- Test: `test/learn/learn-config.test.ts`, `test/learn/learned-text-screen.test.ts`, `test/learn/knowledge-gate.test.ts`

**Interfaces:**
- Produces:
  - `learnEnabled(): boolean`, `learnConfig(): { model: string; approve: 'instructions'|'all'|'none'; maxCalls; maxUsd; maxMinutes; concurrency; rounds; solverMaxTurns; learnerMaxTurns; maxChars; leafMax; editsPerRound; validateSample }` with the defaults from Global Constraints, each read from its `EPISODIC_MEMORY_LEARN_*` variable and ignored when not a positive integer (or not in the enum).
  - `screenLearnedText(text: string): { ok: true } | { ok: false; reason: string }`. Rejects, case-insensitively: override phrases (`ignore (all|any|previous|prior|above) instructions`, `disregard .* instructions`, `you are now`, `system prompt`), shell and tool directives (`run `, `execute `, `curl`, `wget`, `bash`, `powershell`, `rm -rf`, `Bash(`, `Write(`, `Edit(`, backtick-fenced commands), file writes (`write to`, `save to`, `create file`, an absolute path followed by a write verb), URLs (`https?://`, `www.`), email addresses, and any text that `redactSecrets` would change. Allowed: the four plugin tool names, `archive_path` values under the archive dir, dates, project keys.
  - `gateEntry(db, proposal: ProposedEntry, marks: ReadonlyMap<number,string>, attemptMarks?: ReadonlyMap<number,number>): { entry: NewKnowledgeEntry } | { rejected: string }`. Pipeline: redact, `parseCitedLines` (plus `[@n]` attempt marks for reflections, resolved against `learning_attempt`), screen, confidence and scope present, then build `NewKnowledgeEntry` with `status: 'candidate'`.

- [ ] **Step 1: Write failing tests** for config defaults and parsing; one test per screen pattern plus `a plain cited line passes` and `the tool names search, read, digest, skills pass`; gate tests `drops an uncited line`, `rejects an entry with no surviving line`, `rejects a screened body`, `resolves [@n] attempt marks for a reflection`, `rejects a reflection with an unknown attempt mark`, `output body contains no planted secret`.
- [ ] **Step 2: Run** the three files. Expected: FAIL.
- [ ] **Step 3: Implement.** The screen is a list of named regexes; the reason names the pattern. Keep `knowledge-gate.ts` free of SDK imports.
- [ ] **Step 4: Run** the files and `bun run typecheck`. Expected: PASS.
- [ ] **Step 5: Reviews, then commit** `feat(learn): citation, redaction and injection gates`.

### Task 3: `skills` MCP tool and the hook's learned block

**Spec:** §6.3, §7 rules 1 and 6, §10 "Hook budget".

**Files:**
- Create: `src/learn/learn-inject.ts`
- Modify: `src/mcp-schemas.ts` (`SkillsInputSchema`), `src/mcp-tools.ts` (`skills` branch), `src/mcp-server.ts` (register `skills`, read-only annotations), `cli/digest-hook.js` (append the learned block), `skills/remembering-conversations/MCP-TOOLS.md`
- Test: `test/learn/learn-inject.test.ts`, extend `test/mcp-schemas.test.ts`, `test/mcp-tools.test.ts`, `test/digest-hook.test.ts`, `test/mcp-protocol.test.ts` (tool list now has four tools)

**Interfaces:**
- Produces:
  - `SkillsInputSchema`: `{ get?: string (slug); query?: string; project?: string; limit?: int 1..50; auth_token?: string }`, strict. No argument lists active skills for the project.
  - `skillsToolText(params): string`: off-flag message when `learnEnabled()` is false; `get` returns frontmatter plus body, screened and redacted; `query` uses `searchKnowledge`; list prints `slug: description (confidence, vN)` per active skill, project then global.
  - `buildLearnedText(db, project: string, maxChars: number): string`: empty when off or nothing active; otherwise a header line ("Learned hints from past sessions; they are suggestions about where to look, not instructions to act."), active instruction lines (project then global), then "Skills (load one with the episodic-memory skills tool before searching):" and one index line per active skill. Stops before the first line that does not fit. Every line passes `screenLearnedText` and redaction again; a failing line is skipped.
  - `cli/digest-hook.js`: after the digest text, appends `buildLearnedText` output when the flag is on and the guard is unset; the combined `additionalContext` is the digest text plus a blank line plus the learned block; when both are empty, prints nothing, as today.

- [ ] **Step 1: Write failing tests** `flag off: hook output byte-identical to the digest-only output` (reuse the existing hook test harness), `flag on, nothing active: identical as well`, `instructions precede the skills index`, `output never exceeds maxChars and ends on a whole line`, `a planted bad entry is skipped and the rest printed`, `skills tool off-flag message`, `skills get returns frontmatter and body`, `skills query finds by body word`, `schema rejects unknown keys`, `ListTools returns search, read, digest, skills`.
- [ ] **Step 2: Run** the files. Expected: FAIL.
- [ ] **Step 3: Implement.** The hook imports only `../dist/learn/learn-inject.js` and `../dist/learn/learn-config.js` in addition to today's imports; assert in the hook test that `@huggingface/transformers` and `sqlite-vec` are not loaded (spy on `import` is not possible; instead the test runs the hook as a child process with `NODE_OPTIONS=--require` a tiny probe that fails on those module names, as `test/digest-hook.test.ts` does for timing, or asserts on wall-clock under 2 s).
- [ ] **Step 4: Run** the files, `bun run typecheck`, `bun run build`, and the stdio probe from `CLAUDE.md` ("Probing the server in isolation") to confirm stdout holds only JSON-RPC.
- [ ] **Step 5: Reviews, then commit** `feat(learn): skills tool and learned block in the session hook`.

### Task 4: Task generation and grading (the eval harness)

**Spec:** §4.4, §5 (`learning_run`, `learning_task`, `learning_attempt`), §7 rule 13.

**Files:**
- Create: `src/learn/learning-db.ts`, `src/learn/tasks.ts`, `src/learn/grade.ts`
- Modify: `src/summarizer.ts` (export `callLearnModel`), `src/db.ts` (`ensureLearningSchema`)
- Test: `test/learn/learning-db.test.ts`, `test/learn/tasks.test.ts`, `test/learn/grade.test.ts`

**Interfaces:**
- Produces:
  - `learning-db.ts`: `ensureLearningSchema`, `createRun(db, { phase, parentRunId?, project, seed, budget }): string`, `finishRun(db, id, status, metrics)`, `insertTask`, `listTasks(db, { split, project?, kinds?, tiers? })` (the only read path for tasks; `split: 'train'` never returns `test` rows and vice versa), `insertAttempt`, `listAttempts(db, { runId, taskIds?, role? })`, `passRate(db, runId, snapshotId, split)`.
  - `tasks.ts`: `selectSourceExchanges(db, opts: { minPerProject: 20; minUser: 80; minAssistant: 200; perProject: number; seed: number }): ExchangeRow[]` (deterministic from seed; excludes sidechains and projects below the floor), `generateTasks(db, { runId, seed, model: (p: string) => Promise<string>, perProject?: number }): Promise<{ created: number; byKind: Record<string, number> }>` building `locate`, `recall`, `when`, `multi` tasks at tiers 1 to 3, with paraphrases from `model`, stratified 60/40 split by `(project, tier)` from the seed, truth redacted, prompt redacted and screened (a task prompt that fails the screen is not stored).
  - `grade.ts`: `parseSolverAnswer(text): { path?: string; lineStart?: number; lineEnd?: number; project?: string; date?: string; outcome?: string; paths?: Array<...> }` (tolerant of markdown), `gradeLocate(truth, answer): { passed: boolean; score: number }` (1.0 path match and overlap; 0.5 same session; 0 otherwise), `gradeWhen`, `gradeMulti`, `gradeRecall(truth, answer, judge: (p: string) => Promise<string>, threshold = 0.7)` (location grade first; judge prompt compares `outcome` to the redacted truth and returns a number in `<score>` tags; pass needs both).
  - `summarizer.ts`: `callLearnModel(prompt)` uses the backend switch with `EPISODIC_MEMORY_LEARN_MODEL` (default `sonnet`) in place of the summarizer model; everything else identical to `callModel`.

- [ ] **Step 1: Write failing tests** `selection excludes sidechains and small projects and is reproducible`, `split is 60/40 within each (project, tier) cell and reproducible from the seed`, `listTasks train never returns a test row`, `a task prompt holds no planted secret`, `a task whose paraphrase fails the screen is not stored`, `gradeLocate 1.0 on overlap, 0.5 on same session, 0 otherwise`, `gradeWhen needs same day and project`, `gradeMulti needs both`, `gradeRecall fails when location fails even with a high judge score`, `parseSolverAnswer reads a markdown answer with backslash paths`.
- [ ] **Step 2: Run** the files. Expected: FAIL.
- [ ] **Step 3: Implement.** Paths in truth are stored as returned by the exchange row and compared through `path.normalize` on both sides. The paraphrase prompt asks for three tiers in one call and returns them in tagged blocks to save calls.
- [ ] **Step 4: Run** the files and `bun run typecheck`. Expected: PASS.
- [ ] **Step 5: Reviews, then commit** `feat(learn): self-practice task generation and grading`.

### Task 5: In-process tool server and the solver runner

**Spec:** §4.2 Solver, §4.3, §7 rules 8, 9, 10.

**Files:**
- Create: `src/learn/sdk-tools.ts`, `src/learn/agent-runner.ts`, `src/learn/solver.ts`
- Test: `test/learn/sdk-tools.test.ts`, `test/learn/agent-runner.test.ts`, `test/learn/solver.test.ts`

**Interfaces:**
- Produces:
  - `sdk-tools.ts`: `buildPluginToolServer(opts: { db; project; snapshotId; hideExchangeIds: string[]; allowPropose: boolean; onPropose?: (p: ProposedEntry) => void }): McpSdkServerConfigWithInstance` using `createSdkMcpServer` and `tool`. Tools `search`, `read`, `digest`, `skills` delegate to `handleToolCall` in `mcp-tools.ts` (so confinement and redaction are the production code); `hideExchangeIds` filters those ids out of search results and the digest text (§4.4 leak rule). `propose_entry` is registered only when `allowPropose`; it validates the proposal shape with Zod and calls `onPropose`; it never writes. `PLUGIN_TOOL_NAMES = ['mcp__episodic-memory__search', ...]` exported for `allowedTools`.
  - `agent-runner.ts`: `runAgent(opts: { prompt: string; systemPrompt: string; server; allowPropose; maxTurns; maxBudgetUsd; timeoutMs; model }): Promise<{ text: string; trace: TraceStep[]; cost: Cost; aborted: boolean }>`. Builds the `query()` options with `env: getApiEnv()`, `settingSources: []`, `persistSession: false`, `mcpServers: { 'episodic-memory': server }`, `allowedTools: PLUGIN_TOOL_NAMES (+ propose_entry)`, `maxTurns`, `maxBudgetUsd`, `abortController`. Records each tool call as `{ tool, args, resultAddress, resultChars }` from the SDK message stream; stores no tool result text. Exported `buildAgentQueryOptions(opts)` so tests can assert the options without running a subprocess.
  - `solver.ts`: `solveTask(db, task, opts: { snapshotId; runId; role; runAgent?: typeof runAgent; judge?: (p) => Promise<string>; model }): Promise<AttemptRow>`; builds the solver system prompt (role, the active instructions, the skills index, the answer format), grades with Task 4, inserts the attempt, returns it. `solveMany(db, tasks, opts & { concurrency }): Promise<AttemptRow[]>` with a bounded worker pool and a shared call counter that throws `BudgetExhausted` at the cap.

- [ ] **Step 1: Write failing tests** `buildAgentQueryOptions sets settingSources [], persistSession false, the guard env, only the plugin server, allowedTools exactly the plugin tools (+propose_entry only when allowed)`, `tool server search omits hidden exchange ids`, `tool server digest text omits hidden ids`, `propose_entry absent when allowPropose is false`, `propose_entry calls onPropose and writes nothing`, `solveTask with a fake runAgent stores an attempt with a grade and a trace holding addresses and no result text`, `solveMany respects concurrency and stops at the call cap with BudgetExhausted`, `a timed-out agent counts as a failed attempt`.
- [ ] **Step 2: Run** the files. Expected: FAIL.
- [ ] **Step 3: Implement.** Follow `callClaude` in `summarizer.ts` for the `AbortController` timeout and the SDK error handling. Keep `sdk-tools.ts` the only module that imports both the SDK and `mcp-tools.ts`.
- [ ] **Step 4: Run** the files and `bun run typecheck`. Expected: PASS. Then one manual smoke on a copy of the live database with `EPISODIC_MEMORY_LEARN=1`: `learn solve --limit 3` (added in Task 6) returns three graded attempts.
- [ ] **Step 5: Reviews, then commit** `feat(learn): in-process tool server and solver runner`.

### Task 6: `learn` CLI: `tasks`, `solve`, `status`, `report`

**Spec:** §6.1 step 5 (baseline), §7 rules 8, 11, 12, 15, §8.

**Files:**
- Create: `src/learn-cli.ts`, `src/learn/report.ts`, `src/learn/learn-lock.ts`
- Modify: `cli/episodic-memory.js` (`learn` case and help), `src/logging.ts` (`getLearnLogPath`)
- Test: `test/learn/learn-cli.test.ts` (child-process tests as `test/sync-cli-reentrancy.test.ts` does), `test/learn/report.test.ts`

**Interfaces:**
- Produces:
  - `learn-cli.ts`: parses `tasks [--per-project N] [--seed S]`, `solve [--split train|test] [--limit N] [--snapshot ID]`, `status`, `report [--run ID] [--json]`, `bootstrap`, `improve`, `approve <id>`, `export [--to DIR]`. Order of checks: guard, `--help`, flag, GPU reservation, lock (for `tasks`, `solve`, `bootstrap`, `improve`), then lazy `await import()` of the heavy modules.
  - `learn-lock.ts`: `withLearnLock(fn)`, path `getIndexDir()/.learn.lock`, stale after 2 hours, error message names the holder PID.
  - `report.ts`: `buildReport(db, runId): ReportModel` and `formatReport(model, json: boolean): string` with pass rates per split and tier before and after, kept and rejected entries with reasons, budget used, child runs, reflections.

- [ ] **Step 1: Write failing tests** `guard set: exits 0 before importing dist/learn/*` (assert on stderr line and sub-second wall clock), `flag off: exits 0 with the off message`, `reservation held: exits with deferred`, `second instance exits naming the holder PID`, `tasks then solve on a fixture db writes tasks and attempts`, `report lists rejected entries with reasons`.
- [ ] **Step 2: Run** the files. Expected: FAIL.
- [ ] **Step 3: Implement.** The CLI prints progress to stderr and the report to stdout.
- [ ] **Step 4: Run** the files, `bun run typecheck`, `bun run build`. Expected: PASS.
- [ ] **Step 5: Reviews, then commit** `feat(learn): learn CLI with tasks, solve, status and report`.

### Task 7: Bootstrapping

**Spec:** §6.1, §4.1 navigation skill and exploration notes.

**Files:**
- Create: `src/learn/bootstrap.ts`, `src/learn/prompts.ts`
- Modify: `src/learn-cli.ts` (`bootstrap`)
- Test: `test/learn/bootstrap.test.ts`, `test/learn/prompts.test.ts`

**Interfaces:**
- Produces:
  - `prompts.ts`: `bootstrapperSystemPrompt()`, `bootstrapperBrief(project, stats)`, `mergeInstructionPrompt(candidates)`, `solverSystemPrompt(instructions, skillsIndex)`, `diagnosePrompt(...)`, `editBrief(...)`, `splitPrompt(...)`, `mergeEntriesPrompt(...)`, `reflectPrompt(...)`. Every prompt states the citation rule, the scope and confidence rule, the no-URL no-command rule, and the mark numbering it expects. Pure functions; tests check they contain the rules and the marks and no planted secret.
  - `bootstrap.ts`: `runBootstrap(db, opts: { runAgent?; model?; concurrency; perProject?; seed? }): Promise<BootstrapResult>`: run row; eligible projects; parallel bootstrappers (bounded) each with `allowPropose: true`; gate every proposal into `candidate`; orchestrator merge call producing one `*` instruction candidate; `generateTasks` when no tasks exist yet; baseline solve of `train` with an empty snapshot and again with the candidates applied (a snapshot that includes candidates for evaluation only); activation per Global Constraints (skills on no-regression, instructions to candidate pending approval); one reflection entry; `finishRun` with metrics.

- [ ] **Step 1: Write failing tests** with fake `runAgent` and `model`: `one bootstrapper per eligible project, concurrency bounded`, `proposals that fail the gate are rejected with reasons on the run`, `navigation and exploration-notes skills are stored as candidates with sources`, `merge produces one global instruction candidate`, `a candidate skill that lowers the train pass rate stays candidate`, `a candidate skill with no regression becomes active`, `the instruction stays candidate under the default approve mode`, `the reflection cites attempt ids`, `budget cap stops the run with status stopped`.
- [ ] **Step 2: Run** the files. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the files and `bun run typecheck`. Expected: PASS. Manual smoke on a database copy: `learn bootstrap` on one project with `EPISODIC_MEMORY_LEARN_MAX_CALLS=20`, then `learn report`.
- [ ] **Step 5: Reviews, then commit** `feat(learn): bootstrap navigation skills and exploration notes from the archive`.

### Task 8: Leaf learner loop with validation

**Spec:** §6.2 step 4, §7 rule 5.

**Files:**
- Create: `src/learn/leaf-learner.ts`, `src/learn/validate.ts`
- Test: `test/learn/validate.test.ts`, `test/learn/leaf-learner.test.ts`

**Interfaces:**
- Produces:
  - `validate.ts`: `validateCandidate(db, candidateId, opts: { targeted: number[]; sampleFrom: number[]; sampleSize; solve: typeof solveTask; runId }): Promise<ValidationRecord & { keep: boolean }>`. Builds an evaluation snapshot = active entries plus the candidate (and minus the version it supersedes), re-solves the targeted tasks and a seeded random sample of passed tasks, `keep` when at least one targeted task passes and no sampled task regresses. Writes the record on the entry and calls `activate` or leaves it `candidate` with the record (an instruction that passes stays `candidate` under the default approve mode and is listed by `learn status` as awaiting approval).
  - `leaf-learner.ts`: `runLeafLearner(db, opts: { runId; project; taskIds: number[]; rounds; editsPerRound; runAgent?; solve?; model? }): Promise<LeafResult>`. Per round: solve all tasks with the current snapshot; collect failures; mark `suspect` tasks (two attempts in the round with different wrong answers that both parse as confident, or truth path missing from the archive) and exclude them from validation sets; run the learner agent with `allowPropose: true` on the diagnose brief (failed traces by address, active entries, prior reflections); gate each proposal; validate each; stop when no candidate is kept or `rounds` is reached. Returns kept entry ids, rejected proposals with reasons, suspect task ids, per-round pass rates.

- [ ] **Step 1: Write failing tests** with a fake `solve` whose pass set is a function of the active entry slugs: `an edit that fixes a target and regresses nothing is kept and activated (skill)`, `an instruction that passes stays candidate under the default mode and is activated under none`, `an edit that regresses a sampled task is dropped with the regression recorded`, `a round with no kept edit ends the loop early`, `suspect tasks are excluded from validation`, `a proposal that fails the gate is rejected and the loop continues`, `rounds cap holds`, `the learner prompt never contains a test task`.
- [ ] **Step 2: Run** the files. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the files and `bun run typecheck`. Expected: PASS.
- [ ] **Step 5: Reviews, then commit** `feat(learn): leaf learner loop with validated edits`.

### Task 9: Learner: split, merge, reflect, test evaluation; `learn improve`

**Spec:** §6.2 steps 3, 5, 6, 7; §7 rules 10, 13.

**Files:**
- Create: `src/learn/learner.ts`
- Modify: `src/learn-cli.ts` (`improve`), `src/learn/report.ts` (child runs, merges, test metrics)
- Test: `test/learn/learner.test.ts`, extend `test/learn/report.test.ts`

**Interfaces:**
- Produces:
  - `learner.ts`: `runLearn(db, opts: { runAgent?; model?; solve?; concurrency; rounds; leafMax }): Promise<LearnResult>` implementing Algorithm 1: snapshot; solve `train`; if failures fit in `leafMax` and one project, run one leaf learner; else split by project then by failure category (one `splitPrompt` call per round, output validated as a partition of the failed task ids; an invalid partition falls back to by-project), create child runs with `parentRunId`, run leaf learners in parallel (bounded), merge (`mergeEntriesPrompt` per duplicate `(kind, project, slug)`; merged bodies pass the gate; conflicts noted), merge check (re-solve a seeded sample of each child's tasks with the merged snapshot; revert a merged entry to the child's version when the child's gains regress), reflection entry per round citing attempt ids and exchange ids, round loop until no kept edit or `rounds` or budget; then one `test` solve with the final snapshot; `finishRun` with train and test metrics per tier; export active skills (Task 10's `exportSkills`, stubbed until then).
  - `learn improve [--rounds N] [--project P] [--dry-run]` in the CLI; `--dry-run` solves and reports without running learners.

- [ ] **Step 1: Write failing tests** with fakes: `failures in two projects produce two child runs with parent_run_id`, `a split answer that is not a partition falls back to by-project`, `duplicate slugs from two children merge into one entry citing the union of sources`, `a merged entry that regresses a child's sample reverts to the child's version and the reflection says so`, `test split is solved exactly once, after the last round, and no learner prompt in the run holds a test task`, `metrics record train and test pass rates per tier before and after`, `call cap mid-round: status stopped, validated entries kept, test still evaluated`, `concurrency of child learners is bounded`.
- [ ] **Step 2: Run** the files. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the files, `bun run typecheck`, `bun run build`. Then a manual smoke on a database copy with `EPISODIC_MEMORY_LEARN_MAX_CALLS=40 EPISODIC_MEMORY_LEARN_ROUNDS=1`: `learn improve` finishes, `learn report` shows a before and after train rate and a test rate. Record the numbers in the PR.
- [ ] **Step 5: Reviews, then commit** `feat(learn): recursive learner with split, merge, reflection and held-out evaluation`.

### Task 10: Export, approval, agent prompts, doctor

**Spec:** §5 Export, §6.3 steps 3 and 4, §7 rule 7.

**Files:**
- Create: `src/learn/export.ts`
- Modify: `src/learn-cli.ts` (`approve`, `export`), `src/doctor.ts` and `src/doctor-cli.ts` (learn section), `agents/search-conversations.md`, `skills/remembering-conversations/SKILL.md`, `prompts/search-agent.md`
- Test: `test/learn/export.test.ts`, extend `test/doctor.test.ts`, `test/search-agent-template.test.ts`, `test/codex-skills.test.ts` if it asserts on skill text

**Interfaces:**
- Produces:
  - `export.ts`: `exportSkills(db, rootDir = path.join(getSuperpowersDir(), 'learned-skills')): { written: string[]; removed: string[] }`. Writes `<root>/<project>/<slug>/SKILL.md` with frontmatter `name`, `description`, `metadata: { scope, confidence, sources, version, run }` for every active skill; removes directories under `<root>` that no active skill owns (the only removal in the feature, of generated files only, inside `<root>` only, with `<root>` resolved and checked to be inside the config dir). `--to DIR` writes the same tree under `DIR` and removes nothing there.
  - `learn approve <id>`: refuses when the entry has no validation record or has regressions; otherwise activates and exports.
  - Doctor: entries by kind and status, last run id, phase, status, metrics summary, candidates awaiting approval, export dir presence; in `--json` too.
  - Agent and skill text: one new step before searching: "If the context holds a learned-hints block, load the matching skill with the `skills` tool, then search as it advises." Keep every existing step.

- [ ] **Step 1: Write failing tests** `export writes one directory per active skill with the frontmatter`, `a retired skill's directory is removed on the next export`, `export never removes outside root and refuses a root outside the config dir`, `--to writes and removes nothing`, `approve refuses without validation or with regressions`, `doctor reports the learn section and the json shape`, `agent and skill files contain the new step and all existing steps`.
- [ ] **Step 2: Run** the files. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the files, `bun run typecheck`. Expected: PASS.
- [ ] **Step 5: Reviews, then commit** `feat(learn): skill export, approval, doctor section and agent guidance`.

### Task 11: Docs, build, full gate, release notes

**Files:**
- Modify: `README.md` (section "Self-improving memory (Recursa)": what it does, every `EPISODIC_MEMORY_LEARN*` setting in a table, the `learn` subcommands, the approval mode, cost expectations), `CHANGELOG.md` (`[Unreleased]`, user-facing), `CLAUDE.md` (MCP tool surface gains `skills`; gotcha list gains "learned text is untrusted: gate it"), `todo.md`, `docs/roadmap/now.md` and `docs/roadmap/focus-areas/search-quality.md` (the eval harness from Task 4 fulfils theme 2's first deliverable), `docs/SCHEMA.md` (done in Tasks 1 and 4; verify)
- Test: `test/version-consistency.test.ts` unchanged; `bun run test` full

- [ ] **Step 1:** Write the docs. `bun run build`; stage `dist/` files with real content changes only.
- [ ] **Step 2:** `bun run typecheck`, `bun run test` (full suite), `bun audit --audit-level=critical`, the stdio probe. All must pass; record counts in the commit body.
- [ ] **Step 3:** Install check on both machines from the plugin cache path per `CLAUDE.md`: `/mcp` shows four tools; the hook prints nothing new with the flag off.
- [ ] **Step 4:** Commit `docs(learn): README, CHANGELOG, roadmap and schema for self-improving memory`.
- [ ] **Step 5:** With the flag on, on the live archive: `learn tasks`, `learn solve --split train` (baseline), `learn bootstrap`, `learn improve`, `learn report`. Paste the report into the PR. Decide activation of instructions with `learn approve`.

## Dispatch order and parallelism

Tasks 1 and 2 have no dependency on each other and run in parallel. Task 3 needs 1 and 2. Task 4 needs 1.
Task 5 needs 3 and 4. Task 6 needs 5. Task 7 needs 6. Task 8 needs 7's prompts and 5's solver. Task 9 needs
8. Task 10 needs 9. Task 11 last. Two implementers at most at a time; one reviewer pair per task; a
merge of parallel tasks is rebased, never squashed into another task's commit.

## Subagent briefs

Each implementer dispatch is built from this template. The spec reviewer and code reviewer get the same
header and the diff.

```
You are implementing Task <N> of docs/superpowers/plans/2026-11-05-recursa-self-improving-memory.md in
/home/user/episodic-memory (or the Windows checkout). Read CLAUDE.md first, then the spec section the task
names, then the task. Follow the Global Constraints and the Review Focus verbatim. TDD strict: write the
named failing tests, run them and show the RED output, implement, show GREEN, run `bun run typecheck`.
Do not touch files the task does not list. Do not run `learn` against the live database. Report: files
changed, test counts before and after, any constraint you could not meet and why. Do not commit; the
orchestrator commits after review.
```

Spec reviewer brief: "Compare the diff to the task's Interfaces and the named spec section. List every
divergence, every missing test from Step 1, and every Review Focus item the diff could violate. Do not
review style." Code reviewer brief: `/code-review high` on the diff with the Review Focus pasted in.

## Validation of the whole (after Task 11)

- Full suite green on Windows and Linux; counts recorded.
- Flag off: `test/digest-hook.test.ts` byte-identity test green; `/mcp` lists four tools; a session starts
  with no new context.
- Flag on, live archive, `learn report`: train pass rate before and after, test pass rate, calls and USD
  used, entries kept and rejected with reasons. The acceptance bar for enabling by default on this machine
  is a test-split gain with no instruction that failed the screen, reviewed by hand through `learn approve`.
- Adversarial review of the live report by the Adam and Eve tier per `todo.md` conventions, text only.
