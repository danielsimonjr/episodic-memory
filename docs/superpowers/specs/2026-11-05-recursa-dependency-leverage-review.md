# Dependency-leverage review of the Recursa spec and plan

Status: review, 2026-11-05. Input to decision 10 in the design spec. Verified against the installed
dependency tree of this repo and the published `@danielsimonjr/memoryjs@4.5.0` package (downloaded and
its type declarations read; nothing run).

## 1. What was and was not reviewed before this

The first two reviews (adversarial design, plan executability) checked the documents for defects and for
agreement with this repo's code. Neither asked whether the design reinvents something an existing
dependency, or the user's own `memoryjs` library, already provides. This review does that.

## 2. Dependencies already in `package.json`, and what the spec does with them

| Dependency (installed) | Used by the spec | Not yet used, and should be |
|---|---|---|
| `@anthropic-ai/claude-agent-sdk` 0.3.299 | `query()`, `createSdkMcpServer`, `tool`, `tools: []`, `strictMcpConfig`, `canUseTool`, `maxTurns`, `maxBudgetUsd` | **`agents` option.** An `AgentDefinition` carries `tools`, `disallowedTools` (server-level patterns such as `mcp__episodic-learn__*`), `model` and `prompt`. A leaf learner could dispatch its own solver subagents through the SDK's Agent tool, which is the paper's "subagents callable from the harness". The spec keeps solver dispatch in Node so validation stays deterministic and the global semaphore stays in one place; that is the right default, but the plan should name `agents` as the path for a later "learner-driven solving" variant and must add `Agent` to `disallowedTools` now so a learner cannot reach it by accident (already in the Global Constraints). |
| `@huggingface/transformers` 4.2.0 and `src/embeddings.ts` (`generateEmbedding`, `generateQueryEmbedding`, BGE query prefix) | Not used | **Semantic skill selection and semantic grounding.** The grounding gate (spec §7 rule 4) uses token overlap only; a cosine similarity between a body line and its cited exchange, computed at gate time inside the `learn` CLI (never in the hook), is a second, cheap signal. The `skills` tool's `query` runs in the MCP server, which already loads transformers lazily for `search`, so it can rank skills by vector as well as FTS. Skill description vectors would live in a small `vec0` table in `knowledge.sqlite` through `sqlite-vec`. |
| `sqlite-vec` 0.1.9 | Not used | See the row above. Loading the extension on the knowledge database is one call, as `db.ts` does for the index. |
| `better-sqlite3` 13.0.3 | `knowledge.sqlite` through the same pragmas | Nothing more. |
| `zod` 4.4.3 | Tool and proposal schemas | Nothing more. |
| `@modelcontextprotocol/server` 2.0.0 | `skills` tool registration | Nothing more; the in-process server for subprocesses is the SDK's own, not this package. |
| `marked` 16.4.2 | Not used | Not needed; `SKILL.md` is written, not rendered. |
| `src/priority.ts` (`lowerPriorityIfBackgroundWorker`) | Not used | **Gap.** A learning run is a long, heavy local process. Its subprocesses should run at the same lowered priority the background sync uses. Add to the plan's Global Constraints and to `runAgent`. |
| `src/redact.ts` | Every text in and out | **Gap.** It redacts secrets (tokens, keys), not PII. The screen rejects an email address but nothing strips a phone number or a person's address from a skill body built from a transcript. `memoryjs` ships a `PiiRedactor` (email, SSN, credit card, phone, IP) with per-pattern statistics; without memoryjs, a small PII pass belongs in `redactEntryText`. |
| `src/logging.ts` (rotation), `src/lockfile.ts`, `src/gpu-reservation.ts`, `src/reentrancy.ts`, `src/orphan-reaper.ts` | All used | Nothing more. |
| Codex summarizer path (`buildCodexSummarizerCommand`, app-server protocol) | Out of scope | A Codex app-server turn can use tools, so Codex is a plausible second agent backend later. Worth one line in spec §12 decision 3; no change now. |

Also noted: `max_tokens` is passed in `buildSummarizerQueryOptions` today and is not an SDK option; the
learn builder must not copy it (already in the plan).

## 3. `@danielsimonjr/memoryjs` 4.5.0

The user's own MIT library, published independently of `memory-mcp` and sharing its core. Facts from the
package:

- Node `>=22.12.0` (this repo declares `>=20`; CI runs Node 24; this container runs 22.23; both of the
  user's machines run 24 per `CHANGELOG.md`).
- Dependencies: `better-sqlite3 ^13.0.3` (same major and same native binding as this repo's exact pin),
  `zod ^4.6.6` (this repo has `^4.4.2`; Bun would resolve one `zod` 4.6.x that satisfies both and the
  SDK's `^4.0.0` peer), `chalk`, `commander`, `cli-table3`, `async-mutex`, `chrono-node`,
  `@danielsimonjr/workerpool`. Optional peers: `@huggingface/transformers ^4.3.1` (this repo has
  4.2.0; only needed if memoryjs's own embedding provider is used, which this design would not) and `pg`.
- `dist/` is 41 MB. Entry points: `.`, `./sqlite`, `./core`, `./search`, `./agent`, `./security`,
  `./types`.
- Storage: `new ManagerContext({ storageType: 'sqlite', path, defaultProjectId })`, one SQLite file of
  entities, relations and observations with FTS5 and WAL. That is exactly the "separate `knowledge.sqlite`"
  decision 8 of the spec, obtained for free.

### 3.1 What the spec reinvents that memoryjs already has

| Spec concept | memoryjs API (verified in `dist/**/*.d.ts`) | Fit |
|---|---|---|
| `instruction` entries in a `condition: action` template grammar, with confidence, validated by gain, conflicts detected at merge | `HeuristicManager.add({ condition, action, initialConfidence, priority })`, `reinforce(id)`, `recordContradiction(id)`, `detectConflicts()`, `list()` | **Strong.** Validation outcomes map one to one: a kept edit reinforces, a regression records a contradiction, the merge step's conflict detection is a call. |
| Navigation skill and exploration notes per project (terms, conventions, periods, what is absent) | `ProjectContextManager.upsert(projectId, { facts, conventions, commands, glossary })`, `appendGlossaryTerm`, `forContext(projectId)` (formats a block for injection) | **Strong** for exploration notes. `forContext` is close to what the hook's learned block prints. |
| Procedure skills (how to answer a class of question) | `ProcedureManager.addProcedure({ name, description, steps[{ action, parameters }], triggers })`, `matchProcedure(context, candidates)`, `refineProcedure(id, { succeeded, notes })` with EWMA success rate | **Partial.** memoryjs procedures are ordered action steps; Recursa skills are prose `SKILL.md` packages. A procedure skill's "search text mode for X, then read, then check Y" fits steps; the free-text parts go in observations. `matchProcedure` gives task-to-skill selection by trigger overlap, which the spec does not have at all. |
| `reflection` entries, additive, cited to attempts and exchanges | `AgentReflectionManager.create({ scope, evidence })` with sha256 content-hash dedup over scope plus sorted evidence, `getRelevantForSession`, `archive` (never delete) | **Strong.** Dedup of repeated reflections across rounds is a real gap in the spec. |
| Failure categories assigned by one model call over failed traces (spec §6.2 step 3) | `FailureManager.record(input)`, `lookupForTask(taskContext)` with applicability hints, `markResolved` | **Strong.** The paper's "categories of failure cases and strategies for addressing them" is this manager; the learner's diagnose step can look up prior failures for a task before calling the model. |
| `candidate` / `active` / `retired` plus `confidence` | `TrustLevel` `ground-truth` / `verified` / `inferred` / `unverified`, `inferTrustLevel(source)`, `Entity.supersededBy`, bitemporal `invalidateEntity` / `entityAsOf` / `entityTimeline` | **Strong.** `entityAsOf` gives `K^(t)` snapshots without a snapshot table. |
| Versioned entries with `superseded_by` and optimistic updates | `updateEntity(name, updates, { expectedVersion })`, version chains (`parentEntityName`, `rootEntityName`) | **Strong.** |
| Learner edit decisions and the merge step's conflict notes | `DecisionManager.propose` / `accept` / `reject` / `supersede` / `exportAsAdrMarkdown` | **Useful.** Every kept or dropped edit becomes a decision record with its reason; `learn report` can print the chain. |
| PII in learned text | `PiiRedactor.redact` / `redactWithStats` | **Fills a gap** (§2 above). |
| Tamper evidence for learned changes | `auditLog` SHA-256 hash chain with `verifyChain()`, enforced governance | **Useful** for the "learned text is untrusted" posture: `doctor` can verify the chain. |
| `knowledge_fts` and the `skills` tool's `query` | `hybridSearchManager.search(graph, query, { explain: true })` with evidence paths, BM25, fuzzy | **Useful.** Evidence paths say why a skill matched, which the trace can store. |
| Export to `SKILL.md` | `ioManager.exportGraph('markdown' | 'json' | ...)` | **Weak.** The Agent Skills layout is specific; keep the spec's exporter. |
| Bootstrapper agents reading the corpus | `ioManager.ingest(input, { mode, keepSourceText })` with source-chunk provenance | **Unclear** without reading its implementation; it may extract entities without a model. Not relied on. |

### 3.2 What memoryjs does not have, which the spec must keep

- Archive-graded tasks, attempts, snapshots-per-run metrics: the eval harness (`learning_run`,
  `learning_task`, `learning_attempt`). memoryjs has sessions and episodic memory, not graded tasks.
- The citation grammar against `exchanges.id`, the grounding check, the injection screen, the template
  grammar, approval mode with diffs. memoryjs trusts its writer; this design does not.
- The isolated SDK subprocess runner, the in-process read-only tool server, the semaphore, the PID file.
- The `SKILL.md` exporter and the hook's fenced block.

### 3.3 Costs of adopting memoryjs

1. **Engine floor.** `engines.node` must move from `>=20` to `>=22.12`. CI and both machines satisfy it;
   upstream `obra/episodic-memory` does not require it, so this is a fork-only divergence to note in
   `docs/roadmap/upstream-sync.md`.
2. **Install surface.** This fork exists partly because first-run `npm install` on Windows was fragile.
   memoryjs adds seven runtime dependencies and 41 MB. It shares the `better-sqlite3` major, so no second
   native binding. The wrapper's sentinel check should gain one memoryjs sentinel.
3. **Hook fast path.** The SessionStart hook must keep its sub-second start. Importing memoryjs's
   `ManagerContext` eagerly initialises its core managers; the hook should read the learned block from a
   small pre-rendered table or file that the `learn` CLI writes, not open memoryjs at session start.
   This is a design change the plan's Task 3 must carry regardless.
4. **Two memory models in one process.** memoryjs's entities and observations are a different data model
   from `exchanges`. The adapter in `knowledge-store.ts` is the only place both meet; every citation still
   stores the exchange address, never a memoryjs entity name.
5. **Coupling to a fast-moving library.** 4.5.0 today; the user maintains it, which cuts both ways: API
   changes are the user's own, and this plugin becomes a second consumer that exercises the agent-memory
   managers for real.
6. **`zod` resolution** moves to 4.6.x. The SDK's peer range allows it; `bun install` and the full suite
   must confirm.

### 3.4 Recommendation

Adopt memoryjs for the **knowledge repository** (instructions as heuristics, exploration notes as project
context, procedure skills as procedures plus observations, reflections as reflection memory, failure
categories as failure memory, trust levels and version chains as the lifecycle, decisions for the edit
log, `PiiRedactor` in the redaction pass), behind the `KnowledgeStore` adapter the plan already places in
`src/learn/knowledge-store.ts`, so solver, learner, gates and CLI code do not see memoryjs types.

Keep the **learning trace** (runs, tasks, attempts, snapshots as explicit id lists) as plain tables in
the same SQLite file memoryjs opens, through the `better-sqlite3` handle it exposes, or in a sibling
`learning.sqlite` if that handle is not exposed. Keep every gate, the isolation runner and the exporter.

Reasons: it removes roughly half of Task 1 and parts of Tasks 7 to 9 (versioning, dedup, conflict
detection, failure lookup, trust), fills two gaps the spec has (reflection dedup, PII), matches the
paper's memory model more closely than the spec's flat `knowledge_entry` table, and makes the fork a real
consumer of the user's own library. The costs are an engine floor the user's machines already meet and an
install surface the wrapper already knows how to check.

If the user prefers no new dependency, the spec as written stands, with three additions taken from this
review regardless: lowered process priority for subprocesses, a PII pass in `redactEntryText`, and
content-hash dedup of reflections.

### 3.5 What changes in the documents if adopted

- Spec §5: `knowledge_entry` becomes the adapter's view over memoryjs entities; `knowledge_snapshot`
  stays as an explicit id list; `learning_*` tables unchanged. §7 rule 3 gains PII. §8 gains the hook's
  pre-rendered block and the engine floor. §12 gains decision 10.
- Plan Task 1: `knowledge-store.ts` wraps `ManagerContext` (`storageType: 'sqlite'`); `knowledge-db.ts`
  becomes the adapter with the same exported signatures; tests run against a temp memoryjs store.
  Task 2: `redactEntryText` adds `PiiRedactor`. Task 3: the hook reads a `learned_block` table or file
  written by the CLI. Task 7: exploration notes go through `ProjectContextManager`; `matchProcedure`
  selects skills for a task. Task 8: `reinforce` / `recordContradiction` on validation; `FailureManager`
  in diagnose. Task 9: `detectConflicts` in merge; `DecisionManager` records every kept or dropped edit.
  Task 11: `engines.node >= 22.12`, wrapper sentinel, `upstream-sync.md` note.

## 4. Gaps found in this pass that apply either way

1. Subprocess priority (`src/priority.ts`) is not applied to learner subprocesses.
2. PII is not redacted from learned bodies; only secrets are.
3. Reflections are not deduplicated across rounds or runs.
4. Skill selection for a task is by a one-line index the model reads; there is no ranking by trigger or
   vector. `matchProcedure` or a `vec0` table over skill descriptions fixes this.
5. The SDK `agents` option is the natural later path to learner-driven solving; `Agent` must stay in
   `disallowedTools` until then.
