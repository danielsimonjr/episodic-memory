# Recursa for episodic-memory: a self-improving knowledge repository over the conversation archive

Status: approved 2026-11-05 after two rounds of independent review (adversarial design and plan
executability, before and after the memoryjs decision). Implementation plan beside this file:
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
held-out exchange has a known address, so a solver's answer can be checked without a rubric author. The
result is a plugin whose recall gets better with use, and whose every learned fact cites the conversations
it came from.

The plugin name, id, install path, hooks and existing tools do not change. Everything here is behind a
feature flag that defaults to off.

## 2. Scope

In scope:

- A **knowledge store** for instructions, skills and reflections, in its own database file beside the
  index, with citations, versions, status and an additive-only rule.
- A **bootstrapping job** that builds a navigation skill and exploration notes per project from the
  archive, with parallel per-project learner agents and one merging orchestrator (paper §4).
- A **self-practice task generator** that makes archive-graded retrieval tasks from held-out exchanges
  (paper §4.2), with a stratified train/test split that learners never see.
- A **recursive self-improvement job**: `LEARN(D, K)` with solvers, leaf learners, splitting, merging,
  validation and reflection (paper §5, Algorithm 1).
- A **learning trace** (runs, tasks, attempts, snapshots) that `learn report` reads and that the eval
  harness of roadmap theme 2 reuses.
- **Delivery into sessions**: a bounded, labeled learned block in the SessionStart hook, a skills index in
  the same block, a `skills` MCP tool for on-demand loading, and an export of active skills in the Agent
  Skills format.
- Safety: feature flag, real subprocess isolation, reentrancy guard, GPU reservation, redaction, citation
  and grounding gates, prompt-injection screening of every learned field, approval mode with diffs,
  budgets, a global subprocess semaphore, locks, and orphan-reaper coexistence.

Out of scope:

- A Python REPL harness or any change to how Claude Code executes tools. Claude Code and Codex are the
  harness. The paper's harness contributions (tool composition, programmatic context management) are
  mapped onto what already exists, see §4.3, and are not rebuilt.
- Training foundation model weights. The paper also defers this.
- Any change to archiving, parsing, embedding or the digest's own tiers.
- Any deletion of exchanges, digest entries or knowledge entries.
- Learning from a Codex-only install in the first release. Codex transcripts are indexed and searched as
  today; the learner and solver agents run on the Claude Agent SDK. The ollama backend is a text-only model
  call and cannot drive a tool-using solver; see §12 decision 3.

## 3. What exists today (verified in `src/` on 2026-11-05)

| Part | File | Use in this design |
|---|---|---|
| Exchange table with `id`, `project`, `session_id`, `timestamp`, `archive_path`, `line_start`, `line_end`; `id` is `md5(archivePath:userLine-lastAssistantLine)` | `db.ts`, `parser.ts:119`, `docs/SCHEMA.md` | Source of every task and citation. An id is an address, and it changes when a session's last exchange grows; truth therefore stores the address too (§5). |
| Vector and text search, multi-concept AND, metadata filters; result blocks print `archive_path`, line range, date, a 200-char snippet and (by default) the per-file summary | `search.ts` | The solver's main tool, served through a dedicated handler with summaries off and source ids excluded (§4.2) |
| `digest_entry` with cited lines, `[#id]` marks, FTS mirror, `expand` (id to address) and `handoff` (a write) | `digest-db.ts`, `digest-tool.ts` | The **memory** tier already exists. The solver gets a read-only, filtered view of it, never `handoff` (§7 rule 9). |
| `parseCitedLines(raw, marks)` resolves numeric marks through a map built by the prompt builder | `digest-validate.ts` | Reused for text-only prompts that carry a mark map (merge, judge). Tool-using agents see real exchange ids, so a second parser, `parseIdCitedLines`, resolves `[#<32 hex>]` and `[@<attempt>]` against the databases (§7 rule 4). |
| Summarizer backends and `callClaude` with model, fallback, timeout, guard env | `summarizer.ts`, `ollama-backend.ts` | Text-only calls go through a sibling `callLearnModel` with its own model setting |
| Claude Agent SDK 0.3.299 `query()`: `tools` (restricts the tool set; `[]` disables all built-ins), `allowedTools` (auto-approval only, not a restriction), `disallowedTools`, `canUseTool`, `strictMcpConfig` (ignores `.mcp.json`, user settings and plugins), `mcpServers`, `maxTurns`, `maxBudgetUsd`, `settingSources`, `persistSession`, `createSdkMcpServer`, `tool`; `max_tokens` is not an option and is ignored | `node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts` | Real isolation for solver and learner subprocesses (§7 rule 9) |
| Reentrancy guard | `reentrancy.ts` | Every SDK subprocess inherits it; every learner entry point checks it first |
| GPU reservation | `gpu-reservation.ts` | The learner honours it the way the digest does |
| Lock file with PID liveness and stale recovery | `lockfile.ts` | One learning run at a time |
| Orphan reaper: after a sync, kills `claude` processes not in the pre-sync baseline whose command line matches the SDK's fork, pty-host or transient-daemon shapes | `orphan-reaper.ts`, `cli/sync-hook.js` | A learner's SDK subprocesses match the fork shape and would be killed by a concurrent session start; the learner publishes its PIDs and the reaper excludes them (§7 rule 11) |
| `index rebuild` unlinks the index database; `prune` deletes a project's exchanges; `CLAUDE.md` documents `rm -rf conversation-index/` as a reset | `index-cli.ts:80`, `prune.ts`, `CLAUDE.md` | The index database is disposable. Learned knowledge is not. It lives in its own file (§5). |
| Redaction | `redact.ts` | All text in, all text out |
| Archive-confined `read`, tool dispatch and Zod schemas | `mcp-tools.ts`, `mcp-schemas.ts`, `archive-path.ts` | `read` is reused as is; `search` and `digest` get dedicated in-process handlers |
| SessionStart hooks (`sync-hook.js`, `digest-hook.js`), fast path with no embedding imports | `hooks/hooks.json`, `cli/digest-hook.js` | The learned block rides on the digest hook |
| Search agent and skill | `agents/search-conversations.md`, `skills/remembering-conversations/` | Taught to consult the skills index and load a skill before searching |
| Umbrella CLI, `doctor` | `cli/episodic-memory.js`, `doctor.ts` | Add the `learn` subcommand; report the knowledge store |

## 4. Mapping the paper onto the plugin

### 4.1 Learnable components `K`

| Recursa | episodic-memory | Loaded |
|---|---|---|
| **Instructions**: system prompt, guardrails, guidance present at every step | `knowledge_entry` rows of kind `instruction`, scoped to a project or global. Each line follows a fixed declarative template (§7 rule 6): a project key, a search mode, a term list, a date range, or an absence, never free prose. | Always, by the SessionStart hook, inside a fenced and labeled data block, under a character budget, after the digest |
| **Skills**: reusable procedural packages loaded on demand, Agent Skills format | `knowledge_entry` rows of kind `skill`, each a `SKILL.md`-shaped body with name, description (when to use), scope, confidence, sources. Two forms from the paper: a **navigation skill** per project (map of sessions, periods, topics, where things are, what is absent) and **procedure skills** (how to answer a class of question against this archive). | On demand: the hook prints a one-line index; the `skills` tool returns a body |
| **Memory**: reflections learners record on past executions and learning | `knowledge_entry` rows of kind `reflection`, cited to attempts and exchanges, plus the existing `digest_entry` rows. Reflections pass the same screen as everything else because every later learner reads them. | By learners at the start of a learning task; never injected into user sessions |
| **Harness** (fixed in the paper) | Claude Code or Codex, plus this plugin's MCP tools | n/a |
| **Foundation models** (fixed) | The configured SDK model for solver, learner and judge; the same model for all three by default, as in the paper | n/a |

### 4.2 Agents

| Recursa role | Here | Runs as |
|---|---|---|
| **Solver** `SOLVE(x, K)` | Answers one task with the current instructions and skills, using the four read-only tools of a dedicated in-process server named `episodic-learn` and nothing else: `search` (summaries off, the task's source exchanges excluded by query), `read` (the production handler), `digest` (read-only view and query, with every line citing a source exchange of the task removed and `expand` refused on those ids; no `handoff`), `skills`. Returns an answer and a trace. | SDK `query()` subprocess under §7 rule 9 isolation; `maxTurns` and `maxBudgetUsd` capped |
| **Leaf learner** | Solve → diagnose → edit → validate loop over one task subset | Same subprocess shape plus a `propose_entry` tool that hands proposals to the orchestrator; it writes nothing. Validation runs in Node, not in the model. |
| **Learner** (splitting) | Splits tasks by project, then by failure category; runs children in parallel; merges; reflects | Node orchestrator (`src/learn/learner.ts`) that spawns leaf learners; the split and merge decisions are model calls with bounded output |
| **Bootstrapper** | Per-project corpus mapping, exploration notes | SDK `query()` subprocess per project, in parallel, under one global subprocess semaphore |
| **Judge** | Grades a `recall` outcome against the held-out assistant message | Text-only `callLearnModel`; reported, never a learning signal (§4.4) |

### 4.3 Harness features the paper relies on, and what stands in for them

| Paper §3 feature | Purpose | Here |
|---|---|---|
| Tool composition in a persistent REPL | Keep intermediate results out of the model's context | Multi-concept `search`, `limit`, `startLine`/`endLine` paging on `read`, and the `search-conversations` subagent that returns a synthesis, not raw results. No REPL is added. |
| Programmatic context management over an append-only event log | Recover past evidence by address | The archive is the event log; `archive_path` plus a line range is the address; the `digest` tool's `expand` turns a `[#id]` mark into that address. Learner traces store addresses, not transcripts. |
| Multi-agent orchestration | Split large work | Node orchestrator plus SDK subagents under one global concurrency cap |

### 4.4 Self-practice: tasks the archive can grade

The paper generates practice tasks from the corpus and lets the learner assess attempts. The archive gives a
sharper signal than that: every exchange has a known address. A task is built from one held-out exchange
`e`; the solver never sees `e`'s address or its assistant message; the grade compares what the solver found
to `e`.

| Task kind | Prompt to the solver | Ground truth | Grade | Role |
|---|---|---|---|---|
| `locate` | "A user once asked: *paraphrase of e.user_message*. Find the conversation where this was addressed. Return its archive path, a line range, and the project." | `e`'s address and session | **Deterministic.** 1.0 when the normalised path matches and the ranges overlap; 0.5 when the session matches; 0 otherwise. | Learning signal at tiers 2 and 3 |
| `when` | "When was the conversation in which *topic from e* was worked on? Give the date and project." | The session's date range (min and max `timestamp` over its exchanges, as UTC dates) and project | Deterministic: project matches and the answered UTC date falls inside the range widened by one day on each side. | Learning signal at tiers 2 and 3 |
| `multi` | "What did we decide about *A* and what caused *B*?" built from two exchanges of one session | Both addresses | Deterministic: both located. | Learning signal at tiers 2 and 3 |
| `recall` | The `locate` prompt plus "and state the outcome in two sentences" | `e.assistant_message` (redacted) | Location grade, then a judge score 0 to 1 against the source; pass needs both. | Reported per run; never used to keep or drop an edit, because once the solver has located the range it can read it and the judge grades transcription. |

Difficulty tiers come from the paraphrase: tier 1 reuses the user's words, tier 2 is a model paraphrase with
no shared rare term, tier 3 adds a wrong-but-plausible detail that must be rejected. Tier 1 is solved by one
text-mode search of the stored snippet and measures nothing about knowledge; it is generated and reported as
a smoke baseline and excluded from validation sets and from the run's headline metric. Metrics are always
reported per kind and per tier so a gain on one cannot mask a loss on another.

The paraphrase is a text-only `callLearnModel` call made once at generation time and stored with the task.
Selection rules for `e`: a non-sidechain exchange with a user message of at least 80 characters and an
assistant message of at least 200, not a summarizer or digest transcript (the exclusion markers in `sync.ts`
already keep those out of the index), from a project with at least 20 indexed exchanges. Tasks are stratified
by project and tier, split 60/40 into `train` and `test` with a fixed seed stored on the run, and the `test`
split is never read by a learner. The number of tasks per run is capped by `EPISODIC_MEMORY_LEARN_MAX_TASKS`
(default 120, sampled per stratum from the seed), and a run refuses to start when its baseline alone would
exceed the call budget. Before any run, `learn tasks --check` marks tasks whose source address no longer
resolves (a re-indexed session, a pruned project) as `stale`; stale tasks are excluded, not scored as fails.

The search handler served to solvers excludes the task's source exchange ids by query, prints no per-file
summary, and the digest view removes every line citing a source id, so neither the digest nor the search
results can leak the answer. The solver may still `read` any archive file: finding the right one is the task.

## 5. Data model

### 5.1 Two files in `<configDir>/learned/`, a sibling of the index directory

- **`learned/knowledge.db`**: the knowledge repository, a `@danielsimonjr/memoryjs` SQLite store
  (`new ManagerContext({ storagePath: '<that file>', storageType: 'sqlite', defaultProjectId: '*' })`;
  memoryjs's `storagePath` is a file path and it places small sidecar files beside it, so the whole
  `learned/` directory is the unit). memoryjs owns this file and its schema; production code never opens
  it with its own `better-sqlite3`, because the store keeps its handle private.
  - **Environment scoping.** memoryjs reads many `MEMORY_*` variables at construction and gives them
    precedence over explicit options: `MEMORY_STORAGE_TYPE` (would turn the store into JSONL),
    `MEMORY_SQLITE_DRIVER` (swaps the driver), `MEMORY_OBSERVATION_DEDUP` (fuzzy-drops near-duplicate
    observation lines, which would silently delete body lines that differ only in their marks),
    `MEMORY_EMBEDDING_PROVIDER` (defaults to a local Transformers.js model that downloads from the
    network), `MEMORY_AUTO_*`, `MEMORY_GOVERNANCE_ENABLED`, `MEMORY_VALIDATE_ON_STORE`,
    `MEMORY_SQLITE_READ_POOL_SIZE`. The user runs `memory-mcp` on the same machine and may set any of
    them. The adapter therefore saves and removes every `process.env` key matching `^MEMORY_`, sets
    exactly `MEMORY_STORAGE_TYPE=sqlite` and `MEMORY_EMBEDDING_PROVIDER=none`, constructs the context,
    restores the environment, and asserts that the storage is the SQLite class and that
    `ctx.semanticSearch` is null.
  - **No semantic or hybrid search.** The adapter never touches `hybridSearchManager` or
    `semanticSearch`: their getters build an embedding service that imports `@huggingface/transformers`
    and fetches a model from huggingface.co, a new network target (rule 14) and a GPU user (rule 12).
    Text search over entries is `rankedSearch` (BM25) only.
  - **In-memory cache, one context per unit of work.** memoryjs loads the whole graph into memory once
    per context and serves every read from that cache, so a long-lived context never sees another
    process's writes. The `learn` CLI holds one context for the run and closes it on every exit path.
    The `skills` MCP tool constructs a context per call and closes it in `finally` (construction opens
    the file and builds facades; it starts no timers). The hook never opens the store at all (§6.3).
    Each context opens one writer and a small read pool; Windows refuses to rename or unlink an open
    `knowledge.db-wal`, which is one more reason every path closes.
- **`learned/learning.sqlite`**: the learning trace (runs, tasks, attempts, snapshots), opened by this
  plugin with the same pragmas and directory modes as the index database and its own idempotent
  `migrateLearningSchema`. It also holds the **rendered learned block** (§6.3) so the SessionStart hook
  reads one small table and never loads memoryjs.

`learned/` is outside `conversation-index/`, so `index rebuild`, `prune` and the `rm -rf
conversation-index/` reset recipe cannot reach it; the reset recipe in `CLAUDE.md` is amended to say so.
Joins to `exchanges` happen in code against the index database handle. `doctor` reports entries whose
sources no longer resolve.

### 5.2 The knowledge repository in memoryjs terms

The `KnowledgeStore` adapter (`src/learn/knowledge-store.ts`) is the only module that imports memoryjs.
It exposes the `KnowledgeEntry` shape below to every other module and maps it as follows.

| Spec concept | memoryjs representation |
|---|---|
| One entry (any kind) | An entity named `learned:<kind>:<project>:<slug>:v<n>`, `entityType` `learned-<kind>`, `projectId` = the project key or `*`, `lifecycleStatus` `draft` / `published` / `archived` for `candidate` / `active` / `retired`, `importance` from confidence, `tags` `kind:<kind>`, `project:<key>`, `trust:<level>`, `status:<status>`, observations: one line per field (`title:`, `description:`, `scope:`, `confidence:`, `trust:`, `status:`, `version:`, `run:`, `validation:` as JSON, `heuristic:`, `decision:`, `procedure:`, `steps:` when present, then one `body:` line per body line). The logical version `n` lives in the name and the `version:` observation; memoryjs's own `Entity.version` auto-increments on every guarded write and is never read as the logical version. Observation lines are the human-readable form the library expects; the adapter parses them back. |
| Citation | A relation `cites` from the entry entity to a reference entity `exchange:<id>` (`entityType` `exchange-ref`, observations `path:`, `lines:`, `session:`), created before the relation because memoryjs validates both endpoints. A reflection cites `attempt:<id>` the same way. The citation graph is then queryable through `graphTraversal`. |
| Version chain and `superseded_by` | A new version is a new entity with `parentEntityName` = the previous version and `rootEntityName` = v1. Creating it does not mark the parent, so the adapter's `supersede` explicitly sets `supersededBy` and `isLatest: false` on the older entity through `updateEntity(name, patch, { expectedVersion })`, reading `expectedVersion` fresh before each write. `getLatestVersion(root)` backs lookup by slug. |
| `candidate` / `active` / `retired` and trust | `lifecycleStatus` plus the `status:` observation and tag; `status` is the only lifecycle field the gates read. Trust is written explicitly as the agent-memory `source` field, `{ agentId: 'episodic-learn', timestamp, method: 'inferred', reliability, trustLevel }`, with `trustLevel` `unverified` (candidate), `verified` (validated) or `ground-truth` (human-approved), mirrored in the `trust:` observation and tag; memoryjs stores it and filters on nothing. |
| Instruction lifecycle | Each instruction line is also a `heuristicManager.add({ condition, action, priority, initialConfidence })` whose returned id is stored in the entry's `heuristic:` observation. A kept validation calls `reinforce`, a regression `recordContradiction` (both return result strings the adapter maps to booleans), and the merge step calls `detectConflicts()`. |
| Navigation skill and exploration notes | `projectContextManager.upsert(project, { facts, conventions, glossary: [{ term, definition }] })` per project, each string a cited line copied verbatim with its marks, so the record stays checkable. `forContext` output is for learners' prompts only; the rendered learned block is built from entry entities, never from `forContext`, so nothing uncited can reach a session. |
| Procedure skills | When a proposal carries `steps`, `procedureManager.addProcedure({ id: 'proc:<project>:<slug>', name, description, steps: [{ order, action, parameters }], triggers })` beside the entry entity (the id is namespaced because procedure ids are entity names). `ProcedureManager` has no list method, so the adapter enumerates `procedure` entities itself and loads each with `getProcedure` before `matchProcedure(taskPrompt, procedures)`. `refineProcedure(id, { succeeded })` after each graded attempt that loaded the skill updates an in-place success rate that is telemetry: it is not an edit, is never validated, and is never rendered. |
| Reflections | A `learned-reflection` entity (gated, listed and cited like every entry) and a `reflectionManager.create({ scope: 'project' or 'global', evidence: [cited entity names], summary, generalization_confidence, sourceProjectId })` record. memoryjs hashes scope plus sorted evidence only, not the summary, and returns the existing record on a hit without an error, so two different conclusions over the same evidence would collapse. The adapter keeps its own hash over `(scope, project, sorted evidence, NFKC summary)` as an observation: an exact match is `duplicate`; a same-evidence different-summary reflection is stored with its attempt id appended to `evidence` so the two records stay distinct. |
| Failure categories | `failureManager.record({ context, attempted, failure_mode, root_cause, applicability_hint })` per diagnosed failure category with the task's prompt as context; the diagnose step calls `lookupForTask(prompt, { status: 'open' })` before the model call. |
| Edit log | `decisionManager.propose({ context, decision, alternatives, consequences, sourceProjectId })` per proposal, its id stored as the `decision:` observation; `accept` on keep, `reject(reason)` on drop, `supersede` on a newer version; `learn report` prints `exportAsAdrMarkdown`. |
| PII | `new PiiRedactor().redact(text)` after `redactSecrets`, applied to line bodies after the mark group is parsed off, because its phone and card patterns match any 10 to 19 digit run. |
| Text search over entries | `rankedSearch.searchNodesRanked(query, ['kind:<kind>', ...])` (tags are an any-match prefilter) then a code-side filter on `entityType` prefix, project or `*`, and published status; memoryjs has no entity-type or "project or global" filter. |
| Audit | Not used: memoryjs records its hash chain only under `MEMORY_GOVERNANCE_ENABLED=true`, which this plugin does not set. |

The `KnowledgeEntry` interface below is what every other module sees; the fields are the same whether
or not the adapter is backed by memoryjs, so the learner, gates and CLI never import memoryjs types.

**`KnowledgeEntry` (adapter view)**

| Column | Meaning |
|---|---|
| `id` | Primary key |
| `kind` | `instruction`, `skill` or `reflection` |
| `project` | Project key as in `exchanges.project`, or `*` for all projects |
| `slug` | Stable name matching `^[a-z0-9][a-z0-9-]{0,63}$` and not a Windows reserved device name; for a skill, its directory name in the export |
| `version` | Integer from 1; a revision inserts a new row and sets `superseded_by` on the old one |
| `title` | One line |
| `description` | When to use it, one or two lines (the Agent Skills `description`) |
| `body` | Instruction lines, the `SKILL.md` body, or the reflection text. Every fact line ends in `[#<exchangeId>,...]` marks; a reflection line may add `[@<attemptId>]` marks. |
| `scope` | Where it applies and where it does not (paper §4.1: every entry states its applicable scope) |
| `confidence` | `low`, `medium` or `high` (paper §4.1: every entry states its uncertainty) |
| `sources` | JSON array of `{ id, path, lineStart, lineEnd, sessionId }` for every cited exchange, so a citation survives an id change |
| `status` | `candidate`, `active`, `retired` |
| `run_id` | The learning run that wrote it |
| `created_at` | Creation time |
| `superseded_by` | Id of the newer version, or null |
| `validation` | JSON: tasks checked, pass counts before and after, regressions, mean turns and USD before and after |

Unique on `(kind, project, slug, version)` through the entity name. Entry ids are entity names
(strings); task and attempt ids are integers in `learning.sqlite`.

### 5.3 The learning trace in `learning.sqlite`

**`learning_run`**: `id` (`run-<timestamp>-<random>`), `phase` (`bootstrap`, `improve`), `parent_run_id`,
`project`, `status` (`running`, `done`, `stopped`, `failed`, `deferred`), `started_at`, `finished_at`,
`budget` (JSON: caps and use for calls, USD, wall clock, rounds, concurrency), `metrics` (JSON: pass rates
before and after on train and on test, per kind and tier, plus mean turns and USD), `seed`, `rejections`
(JSON list of `{ slug, reason }`).

**`learning_task`**: `id`, `run_id` (the run that generated it; later runs reuse tasks), `kind`, `tier`,
`split`, `project`, `prompt` (redacted, screened), `truth` (JSON: `exchanges: [{ id, path, lineStart,
lineEnd, sessionId }]`, `sessionDateRange: [from, to]`, `project`, `assistantMessage` redacted), `status`
(`ok` or `stale`).

**`learning_attempt`**: `id`, `task_id`, `run_id`, `snapshot_id`, `role` (`solve`, `validate`,
`merge-check`), `passed`, `score`, `answer` (redacted, capped at 4000 characters), `trace` (JSON list of
`{ tool, args, resultAddress, resultChars }`; result text is never stored), `cost` (JSON: turns, input
tokens, output tokens, USD when known), `outcome` (`graded`, `aborted`, `killed`, `error`; only `graded`
attempts enter diagnosis), `created_at`.

**`knowledge_snapshot`**: `id`, `run_id`, `created_at`, `entry_names` (JSON list of entity names). A
snapshot is `K^(t)`: the set of entries a solver ran with. Metrics compare snapshots, and `learn report`
names them.

**`learned_block`**: `project`, `text`, `rendered_at`. The rendered learned block per project (and `*`),
written by the `learn` CLI after every change to active entries and read by the hook (§6.3).

### 5.4 Export

Active skills are written to `<configDir>/learned-skills/<project>/<slug>/SKILL.md` with frontmatter
`name`, `description`, and a `metadata` map holding `scope`, `confidence`, `sources`, `version`, `run`. The
tree is written to a sibling temporary directory and renamed into place; a rename that fails with `EPERM`
(a file open in a session on Windows) is retried with the same backoff as `safeRmSync` and then reported,
never fatal. The database is the source of truth and the tree is generated output; it is the one place the
feature removes files, and only under that root. An optional `learn export --to <dir>` copies the tree into
a project's `.claude/skills/` and removes nothing there. Nothing writes into a project directory on its own.

## 6. Data flow

### 6.1 Bootstrapping (`episodic-memory learn bootstrap`)

1. Acquire `.learn.lock`. Check the flag, the guard, the GPU reservation. Create a `bootstrap` run. Check
   the budget against the task count (§4.4) and refuse to start if the baseline alone exceeds it.
2. List projects with at least 20 indexed exchanges. For each, under the global semaphore, start one
   **bootstrapper** subprocess with the four tools and `propose_entry`. Its brief: map this project. Read
   the digest, sample sessions across the whole time span, name the periods of work, the topics, the terms
   the user uses, the sessions that supersede others, what is absent, and the boundaries of the corpus.
   Propose one `skill` of slug `navigation` and one `skill` of slug `exploration-notes`, each line cited.
3. Each proposal passes the gates of §7 and is stored as `candidate`; rejections are recorded on the run
   with the reason.
4. The orchestrator merges: it reads all candidates and asks the model for one global `instruction` entry
   in the template form (project keys, time spans, which mode for what) with the candidates as evidence,
   and stores it as `candidate`.
5. Self-practice: generate tasks (§4.4) when none exist. Solve the `train` split (tiers 2 and 3) with no
   knowledge (an empty snapshot) and again with the bootstrapped candidates. Record both on the run. A
   bootstrap candidate is kept when the pass rate does not fall and mean turns or USD per task fall by at
   least `EPISODIC_MEMORY_LEARN_MIN_SAVING` (default 10 percent); this is the paper's Figure 4 result,
   where bootstrapping cuts turns and tokens at equal accuracy. Skills that pass activate; the instruction
   stays `candidate` for approval under the default mode.
6. Write a `reflection` entry for the run (what mapping worked, what did not, with attempt ids as sources).
   Export. Release the lock. Print the report.

### 6.2 Recursive self-improvement (`episodic-memory learn improve`)

Implements Algorithm 1 with `D` = the `train` tasks of tiers 2 and 3 and `K` = the active entries.

1. Lock, flag, guard, reservation, budget precheck, run row, snapshot `K^(t)`.
2. **Solve.** Run solvers on all of `D` under the global semaphore. Record attempts.
3. **Split.** If the failing tasks span more than one project, or more than `leafMax` tasks (default 12),
   the learner splits: first by project, then by failure category assigned by one model call over the
   failed traces (for example "wrong project", "right session wrong lines", "right text wrong date",
   "paraphrase not matched", "rejected a correct result"); an answer that is not a partition of the failed
   ids falls back to by-project. Each subset becomes a child run with `parent_run_id`.
4. **Leaf learner loop** on a subset, repeated up to `rounds` (default 3) or until no edit passes:
   - *Diagnose.* Read the subset's graded failed attempts (traces by address, not transcripts), the current
     instructions and skills, and the screened reflections from earlier runs. Separate solver error from
     task noise: a task that two solvers fail in different ways with a confident answer each is marked
     `suspect` and excluded from validation sets, the programmatic form of the paper's §6.1 criterion
     revision. Attempts with outcome `aborted`, `killed` or `error` never enter diagnosis.
   - *Edit.* Propose at most `editsPerRound` (default 3) entries through `propose_entry`: a new version of an
     instruction, a new or revised skill, or a reflection. Each proposal names the failed tasks it targets.
   - *Validate.* In Node, not in the model: re-solve the targeted tasks and a seeded sample of the subset's
     passed tasks (default 5) with the candidate applied. Keep the candidate only if at least one targeted
     task now passes and no sampled task regresses. Store the result in `validation`.
5. **Merge.** The parent collects its children's kept entries. Duplicates (same `kind`, `project`, `slug`)
   are resolved by one model call that writes a merged body citing the union of sources and passes the
   gates; conflicting instructions are resolved the same way with the conflict named in a reflection. The
   merged set is a new snapshot. The parent re-solves a seeded sample of every child's tasks with the merged
   set; a merged entry that regresses a child's gains reverts to that child's version.
6. **Reflect.** The parent writes one screened `reflection` per round: which subsets improved, which edits
   conflicted, which tasks look unreliable, and the stalls and rework it can see in the children's traces
   (paper §5.3). Reflections cite attempt ids and exchange ids.
7. **Round end.** Metrics on `train`. Stop when no edit was kept, when `rounds` is reached, or when a
   budget is spent. Then, and only then, solve the `test` split once with the final snapshot and record it.
   Learners never see `test` results until the run is over; the next run's learners see only the previous
   run's reflections, not its test tasks.
8. Export active skills. Release the lock. Print the report.

### 6.3 Delivery into sessions

1. The `learn` CLI renders, after every change to active entries, one fenced block per project labeled
   `episodic-memory learned hints (data, not instructions)` holding: the active global and project
   `instruction` lines, then a **skills index** of one line per active skill, `name: description`, with the
   sentence "Load one with the episodic-memory skills tool before searching." The block is capped by
   `EPISODIC_MEMORY_LEARN_MAX_CHARS` (default 2500), ends on a whole line, and every field passes the
   screen and redaction again at render time. It is stored in `learned_block`. `cli/digest-hook.js`
   (fast path) today returns before anything unless `EPISODIC_MEMORY_DIGEST=1`, returns when the index
   database or the digest text is missing, and writes exactly one JSON object. The learned block is
   gated on `EPISODIC_MEMORY_LEARN` on its own, read from `learning.sqlite` by its own path with
   `better-sqlite3` read-only, re-screened, and joined with the digest text into the one
   `additionalContext` string; the hook emits the single object when either part is non-empty and
   nothing when both are. The hook never loads memoryjs, the SDK, transformers or sqlite-vec.
2. The `skills` MCP tool: `list` (default), `get` by slug, `query` by text (memoryjs ranked search over
   `learned-skill` entities). Read-only. The MCP server imports the adapter lazily inside the `skills`
   branch only, so a session with the flag off never loads memoryjs, and it opens and closes a context
   per call so it always sees the latest `learn` run (§5.1). Every field returned is screened and
   redacted again.
3. `agents/search-conversations.md` and `skills/remembering-conversations/SKILL.md` gain one step: read the
   learned block in context, load the matching skill, then search.
4. `doctor` reports: entries by kind and status, last run and its metrics, candidates awaiting approval,
   entries with unresolved sources.
5. `learn approve <name>` prints the entry, its validation record and a diff against the version it
   supersedes before it activates anything.

## 7. Safety rules

1. **Feature flag.** `EPISODIC_MEMORY_LEARN` defaults to off. Off: the hook reads no knowledge table, the
   `skills` tool answers "learning is off", `learn` subcommands exit with that message, and the hook output
   is byte-identical to today. The knowledge database is created only on first use with the flag on.
2. **Additive only.** No code path deletes a knowledge entry, a task, an attempt, a digest entry or an
   exchange. Revision inserts and sets `superseded_by`. Retirement sets `status`. The export tree under
   `learned-skills/` is generated output and is the only place files are replaced or removed.
3. **Redact first and last.** Every prompt built from exchanges passes `redactSecrets`. Every stored field,
   answer and trace passes it again, followed by memoryjs's `PiiRedactor` (email, phone, SSN, card, IP).
   The hook, the `skills` tool and the export re-apply both on output.
4. **Cite, ground, or drop.** Tool-using agents cite real ids: `parseIdCitedLines` keeps a body line only
   when it ends in `[#<32 hex>,...]` marks (plus `[@<n>]` for reflections) and every id resolves against
   `exchanges` or `learning_attempt` at gate time. A kept line must also share at least
   `EPISODIC_MEMORY_LEARN_MIN_GROUNDING` (default 3) distinct content tokens of four or more characters with
   the text of one cited exchange, so a real id cannot be pinned to an unrelated sentence. Text-only
   prompts that carry a mark map keep using `parseCitedLines`. An entry with no surviving line is not stored.
5. **Validate or drop.** A proposed instruction or skill is `candidate` until its validation record shows
   the gain its kind requires (§6.1 step 5 for bootstrap entries; at least one targeted pass and no
   regression for learned edits), or until a human runs `learn approve`.
6. **Injection screen.** Learned text comes from a model reading untrusted archive content, and it is
   injected into every future session, exported to disk, and read by every later learner. Before storage,
   `screenLearnedText` runs on every field of every kind (title, description, scope, body, slug, and
   reflections too), after Unicode NFKC normalisation and removal of control, zero-width and
   bidirectional-override characters. It rejects: requests to ignore, override or replace instructions or a
   system prompt, and authority framing ("the user's standing rule", "always do X before"); any tool
   invocation other than the exact allowlisted phrases the plugin itself prints ("episodic-memory skills
   tool", "digest tool", "search tool", "read tool"); shell commands, `mcp__` names outside the plugin's,
   file writes; URLs including obfuscated forms (`dot com`, `hxxp`), email addresses, base64 runs over 40
   characters; requests for credentials; and any text the redaction patterns would change. Instruction
   lines must additionally match the template grammar: `project <key>: <statement>`, `mode <vector|text|
   both> for <topic>`, `terms for <topic>: <list>`, `period <YYYY-MM>..<YYYY-MM>: <statement>`, or
   `absent: <statement>`. The same screen runs on the hook's and the `skills` tool's output. The screen is a
   barrier, not a proof; approval mode and the grounding check stand behind it.
7. **Approval mode.** `EPISODIC_MEMORY_LEARN_APPROVE` defaults to `instructions`: skills activate on
   validation; instructions stay `candidate` until `learn approve <name>`, which shows the diff, because
   instructions are always loaded and skills are loaded by choice. `all` holds both; `none` activates both.
8. **Reentrancy.** Every subprocess inherits `EPISODIC_MEMORY_SUMMARIZER_GUARD=1` through `getApiEnv()`
   (which spreads `process.env`, so the guard survives the SDK's env replacement). Every `learn` entry
   point and the hook check `shouldSkipReentrantSync()` first, before heavy imports.
9. **Isolation.** Solver and learner subprocesses run with `tools: []` (no built-in tools at all),
   `disallowedTools` naming the built-ins anyway, `strictMcpConfig: true` (no `.mcp.json`, user settings or
   plugin servers, so no second stdio server per subprocess), `settingSources: []`, `persistSession:
   false`, `mcpServers` holding only the in-process `episodic-learn` server, `allowedTools:
   ['mcp__episodic-learn__*']`, a `canUseTool` that denies everything else, and a custom string
   `systemPrompt`. The served tools are read-only: `search` and `digest` are dedicated handlers (summaries
   off, source ids excluded, no `handoff`, project passed explicitly), `read` is the production handler,
   `skills` is read-only. `propose_entry` hands a proposal to the orchestrator and writes nothing. A test
   reads the subprocess's init message and asserts its tool list equals the served names exactly.
10. **Priority.** The `learn` CLI lowers its own priority the way the background sync does
    (`lowerPriorityIfBackgroundWorker`), and every subprocess inherits the marker through `getApiEnv()`.
10a. **Budgets and one semaphore.** Per run: `EPISODIC_MEMORY_LEARN_MAX_CALLS` (default 200 subprocesses),
    `EPISODIC_MEMORY_LEARN_MAX_USD` (default 5), `EPISODIC_MEMORY_LEARN_MAX_MINUTES` (default 60),
    `EPISODIC_MEMORY_LEARN_MAX_TASKS` (default 120), rounds (default 3), and **one** global subprocess
    semaphore `EPISODIC_MEMORY_LEARN_CONCURRENCY` (default 3) shared by every level (bootstrappers, child
    learners, solvers, validations), so depth never multiplies processes. Per subprocess: `maxTurns`
    (solver 12, learner 30), `maxBudgetUsd`, and an `AbortController` timeout. A spent budget stops the run
    with status `stopped` and keeps everything validated so far; the baseline cost is computed first and a
    run that cannot afford it does not start.
11. **One run at a time, and coexistence with sync.** `.learn.lock` in the index directory through
    `lockfile.ts`. The learner writes the PIDs of its live subprocesses to `.learn.pids` beside the lock;
    `selectOrphans` in `orphan-reaper.ts` excludes PIDs listed there, so a session start during a run does
    not kill the run's agents. An attempt whose subprocess dies by signal is stored with outcome `killed`
    and never enters diagnosis.
12. **GPU reservation.** When the reservation file names a holder, `learn` exits with `deferred`, as the
    digest does, because a learning run is a heavy local process and the fleet rule is "do not compete".
13. **Test split integrity.** `test` tasks are excluded from every learner prompt by query, never by
    convention; the run records the seed; `learn tasks --check` marks tasks whose address no longer resolves
    as `stale` and excludes them.
14. **No new network target.** All model calls go through `getApiEnv()` and the existing base-URL check.
    The memoryjs adapter opens the store with no embedding provider and never uses semantic or hybrid
    search, so memoryjs itself never fetches a model (§5.1).
15. **Never from a hook.** No SessionStart hook starts a learning run.
16. **Durability.** Learned knowledge lives in the memoryjs store and the trace in `learning.sqlite`;
    no index reset touches either (§5.1).
17. **Dedup.** A reflection whose scope and evidence match an existing one is rejected by memoryjs's
    content hash and reported as `duplicate`; a proposal whose `(kind, project, slug)` exists with an
    identical body is rejected the same way before a new version is made.

## 8. Runtime and build

- TypeScript ESM under `src/learn/`; bundled with the rest by `bun run build`; `dist/` committed.
  `@danielsimonjr/memoryjs` is a runtime dependency, marked external in the esbuild bundle like the other
  native-backed packages, and listed in the wrapper's dependency sentinels.
- **One `better-sqlite3`.** This repo pins `better-sqlite3` exactly; memoryjs declares a caret range on
  the same major. The day a newer patch publishes, a fresh plugin install (which skips install scripts)
  would nest a binding-less copy under memoryjs, the top-level sentinel would still pass, and memoryjs
  would fail to load or fall back to a different driver: the install failure class this fork exists to
  prevent. So `package.json` adds an npm `overrides` entry pinning `better-sqlite3` to the same exact
  version (Bun honours the top-level pin; npm in the plugin cache honours `overrides`), `repairPlan`
  fails when a nested `node_modules/@danielsimonjr/memoryjs/node_modules/better-sqlite3` exists, and
  `doctor` checks that `better-sqlite3` resolves to the top-level copy from memoryjs's directory.
  memoryjs's `postinstall` runs a native rebuild check; under the wrapper's `npm install` it may run
  and is install-time only.
- **Engine floor enforced at launch.** `engines` is not enforced by Node, so `cli/mcp-server-wrapper.js`
  and `cli/episodic-memory.js learn` check `process.versions.node` against `22.12.0` and exit with one
  stderr line naming the floor when below it.
- `engines.node` becomes `>=22.12.0` (memoryjs's floor); CI's Bun moves to 1.4.2 (memoryjs's Bun floor);
  the repo's `zod` range moves to `^4.6.6` so one copy resolves. CI runs Node 24; both of the user's
  machines run 24. This is a fork-only divergence from upstream, recorded in `docs/roadmap/upstream-sync.md`.
- memoryjs is imported from its package root only: `tsconfig` uses node10 module resolution, which
  ignores the package `exports` map, so subpath imports would not typecheck.
- Entry points run on `node`. The hook stays on its fast path: it imports `better-sqlite3` and small
  `dist/` modules only; no memoryjs, no SDK, no transformers, no sqlite-vec.
- `cli/episodic-memory.js learn <bootstrap|improve|tasks|solve|status|report|approve|export>` dispatches to
  `dist/learn-cli.js`, which checks the guard and flag before any heavy import, as `sync-cli.ts` does.
- The in-process server is built with the SDK's `createSdkMcpServer` and `tool`; `read` and `skills` call
  the production handlers, `search` and `digest` call dedicated read-only handlers that share the
  production query code.
- Windows: paths through `path.join`; path comparison through `path.resolve` and the case folding
  `archive-path.ts` already applies on win32, with session id as the fallback; the lock, PID file and
  export directory under the config dir; `safeRmSync` in tests.

## 9. Licensing and provenance

The paper is a method description. No code is published with it that this design copies. Prompts, table
names and tests are written from this document. The Agent Skills format is an open specification and the
export follows its `SKILL.md` layout.

## 10. Test plan

Tests come first. Each safety rule in §7 has a failing test before its code. All model and agent calls are
injectable and tests pass fakes; no test reaches a model or a GPU (the vitest config already pins a closed
backend). Child-process tests of the hook, the CLI early exits and the MCP server are allowed.

- Schema: the knowledge database migrates twice without error; `index rebuild` on a fixture leaves it in
  place; the unique key rejects a duplicate version; a slug outside the grammar or a reserved name is
  rejected.
- Citation and grounding: a line with no mark, an unknown id, or fewer than the minimum shared tokens with
  its cited exchange is dropped; an entry with no surviving line is not stored; `[@n]` resolves against
  attempts; `parseCitedLines` callers see no change.
- Injection screen: each listed pattern, on each field, is rejected, including NFKC and zero-width
  disguises; the allowlisted phrases pass; a template-valid instruction passes and a free-prose one fails;
  the hook and `skills` output of a planted bad entry omit it.
- Redaction: a planted token in an exchange appears in no task prompt, truth, attempt, entry, export file
  or output.
- Task generation: selection rules hold; the split is stratified and reproducible from the seed; the task
  cap samples per stratum; a task's source ids are absent from the search results and the digest view the
  solver's tools return; `--check` marks a task whose address moved as `stale`.
- Grading: `locate` on normalised path and overlap, 0.5 on session match; `when` inside the widened
  session range in UTC; `multi` needs every address; `recall` needs location plus judge and is excluded
  from validation; tier 1 is excluded from validation and from the headline metric.
- Isolation: `buildAgentQueryOptions` sets `tools: []`, `strictMcpConfig`, `settingSources: []`,
  `persistSession: false`, the guard env, the single server and the wildcard `allowedTools`; the served
  tool set has no `handoff`; a `propose_entry` call writes nothing.
- memoryjs scoping: with `MEMORY_STORAGE_TYPE=jsonl` and `MEMORY_OBSERVATION_DEDUP=true` in the test
  environment, the store opens as SQLite, two near-identical body lines both persist, the environment is
  restored afterwards, and `semanticSearch` is null; a store written through one context is not seen by
  a second context opened earlier, and is seen by a context opened afterwards (the per-call rule);
  the hook with digest off and learn on prints the block, and with both on prints exactly one JSON object.
- Leaf loop: with a fake solver whose pass set is a function of the active entries, an edit that fixes a
  target and regresses nothing is kept; one that regresses a sampled task is dropped; a round with no kept
  edit ends the loop; `killed` and `aborted` attempts do not enter diagnosis.
- Split and merge: failures in two projects produce two child runs; a non-partition split answer falls
  back; duplicate slugs merge into one entry citing the union; a merged entry that regresses a child's
  gains reverts.
- Budgets: the global semaphore bounds concurrent subprocesses across nested levels; the call cap stops the
  run with `stopped` and keeps validated entries; a run whose baseline exceeds the budget refuses to start.
- Orphan reaper: a PID listed in `.learn.pids` is never selected.
- Reentrancy, flag off, approval (with diff), export (temp-and-rename, EPERM tolerated, `--to` removes
  nothing), lock (second instance names the holder), hook budget and ordering: as in the plan's tests.

## 11. Phases

1. Knowledge database, gates, screen, flag, `skills` tool, hook block. Flag off. Nothing learns yet.
2. Task generation, grading, isolated solver runner, `learn tasks` and `learn solve` (a baseline-only run).
   This is the eval harness of roadmap theme 2 and is useful on its own.
3. Bootstrapping with parallel bootstrappers and the merge step.
4. Leaf learner loop with validation.
5. Splitting, merging, reflection, test-split evaluation, `learn report`.
6. Export, agent and skill prompt updates, `doctor`, README, CHANGELOG, build, install check on both
   machines, then enable the flag and run `bootstrap` on the live archive.

## 12. Decisions on open questions

1. **Same model for solver, learner and judge** (`EPISODIC_MEMORY_LEARN_MODEL`, default `sonnet`; the
   summarizer's `haiku` default is too weak to diagnose traces). The paper's thesis is improvement without
   a stronger model; keeping one model makes that claim testable here.
2. **The archive grades, not a rubric.** Deterministic location grades at tiers 2 and 3 carry the whole
   learning signal; `recall` and tier 1 are reported only. This differs from the paper, whose tasks need a
   rubric and a judge model, and it is the reason the method fits this plugin: supervision is free.
3. **Claude SDK backend only for agents in release 1.** The ollama backend stays for text-only calls when
   configured. Tool-using solvers on ollama need a tool-calling loop that does not exist in
   `ollama-backend.ts`; it is a later theme.
4. **Reflections live in `knowledge_entry`, not `digest_entry`**, and are screened like everything else.
5. **Instructions need approval by default; skills do not.** See §7 rule 7.
6. **Learning never runs from a hook.** See §7 rule 15.
7. **Codex sessions are corpus, not harness.** Their exchanges generate tasks and citations like any other.
8. **Separate files.** The index is disposable by design and documented as such; learned knowledge is
   the product of real model spend and must survive a rebuild.
9. **Real isolation, not auto-approval.** `allowedTools` only pre-approves; `tools: []` plus
   `strictMcpConfig` is what removes built-in tools and other servers from a subprocess.
10. **The knowledge repository is backed by `@danielsimonjr/memoryjs`** (decided 2026-11-05, after the
    dependency-leverage review beside this file). The library already provides heuristics with reinforce,
    contradiction and conflict detection, project context, procedures with trigger matching, reflection
    memory with content-hash dedup, failure memory, trust levels, version chains, decision records and a
    PII redactor; §5.2 maps each. The adapter is the only module that imports it; the learning trace and
    the rendered block live in the plugin's own `learning.sqlite`; every gate, the isolation runner and
    the exporter are unchanged. Cost accepted: Node `>=22.12`, the added install surface (covered by the
    wrapper's sentinels), and the pre-rendered block so the hook never opens memoryjs.
