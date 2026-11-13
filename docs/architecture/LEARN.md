# Learned knowledge (`src/learn/`)

This document describes the learned-knowledge feature, also called Recursa. The feature has 30 source files in `src/learn/` and 35 test files in `test/learn/`. Every other document gives a summary and points here.

## Purpose

The feature turns the archive of past sessions into short, cited hints. A hint names where to look in past conversations and which skill to load. The feature does not store answers. It stores navigation advice that a measurement showed to be useful.

The feature is off unless `EPISODIC_MEMORY_LEARN` is on. With the flag off, the hook output is the same as without the feature, no store opens, and the learning code does not load.

## The knowledge model

A **knowledge entry** has a kind, a project, a slug, a version and a status.

| Field | Values |
|---|---|
| Kind | `instruction`, `skill`, `reflection` |
| Status | `candidate`, `active`, `retired` |
| Trust | `unverified`, `verified`, `ground-truth` |
| Confidence | `low`, `medium`, `high` |

The slug must match `^[a-z0-9][a-z0-9-]{0,63}$`. The slug becomes part of an entity name and an export directory name, so the gate validates it first.

An entry is **additive**. A revision inserts a new version and marks the older version as superseded. Retirement changes the status. No code path deletes an entry, a task, an attempt or a run. The only code that replaces or removes files is the skill export, and it touches only the exported tree.

Each entry cites its sources. A source is an exchange id or an attempt id. A line of an entry ends with a mark group such as `[#<32 hex id>]`. A reflection can add `[@<attempt id>]` marks.

## Storage

All learned data lives under `<config dir>/learned/`. This folder sits beside `conversation-index/`, so an index reset never reaches it.

| File | Owner module | Content |
|---|---|---|
| `knowledge.db` | `knowledge-store.ts` | Tables `entities` and `relations`. One `entities` row per entry version, named `learned:<kind>:<project>:<slug>:v<n>`. Fields are stored as `key: value` observation lines and as tags. Cited exchanges and attempts are rows that a `cites` relation links. Other records (heuristics, procedures, decisions, failures, reflections, project context) are one row each with a typed JSON payload. |
| `learning.sqlite` | `learning-store.ts`, `learning-db.ts` | Tables `learning_run`, `learning_task`, `learning_attempt`, `knowledge_snapshot` and `learned_block`. |
| `learned-skills/` | `export.ts` | A generated tree of `<project>/<slug>/SKILL.md` files. |
| `.learn.lock`, `.learn.pids` | `learn-lock.ts` | In the index directory. The lock allows one learning run at a time. The pid file lists the child processes of the run. |

`knowledge-store.ts` is the only module that knows how an entry sits on disk. Every other module uses the shapes in `types.ts`. The store reads straight from SQLite, so a write through one handle is visible to every other open handle.

## Safety pipeline

Learned text comes from a model that has just read untrusted archive content. The text then goes into every future session. Every field therefore passes a fixed pipeline before storage, and passes the screen again on the way out.

| Step | Module | Check |
|---|---|---|
| 1 | `types.ts` (`isValidSlug`) | The slug has a valid form. |
| 2 | `knowledge-gate.ts` (`redactLearnedText`) | Secrets are redacted in every text field. |
| 3 | `cited-ids.ts` (`parseIdCitedLines`) | Each line has at least one `#` mark. Every mark resolves to a real exchange. The line shares enough content tokens with a cited exchange. The step also rewrites the marks and yields the stored `sources`. |
| 4 | `pii-redactor.ts` (`redactPii`) | Email, SSN, card, phone and IP patterns are redacted, after the mark group is removed. The patterns lean toward false positives. |
| 5 | `learned-text-screen.ts` (`screenLearnedText`) | An injection screen, after Unicode NFKC normalization and removal of zero-width and bidirectional characters. It rejects instruction-override and authority framing, unlisted tool calls, shell commands, file writes, URLs (also obfuscated ones), email addresses, long base64 runs and credential requests. Its reason strings are the names of the patterns, so a report line can say which rule fired. |
| 6 | `knowledge-gate.ts` (`gateEntry`) | Shape checks: a non-empty scope, a valid confidence, valid procedure steps. |

`gateEntry` is pure. The caller supplies the resolvers, the redactor and the configuration, so the gate loads in a test or in a hook. A rejected proposal is recorded on the run with its reason. The code does not retry or repair it.

The screen is a barrier, not a proof. The approval mode and the grounding check stand behind it.

## Self-practice tasks

`tasks.ts` builds practice tasks from the archive. The archive is both the corpus and the answer key.

1. `selectSourceExchanges` picks held-out exchanges. A source needs a minimum of user and assistant text (`MIN_USER_CHARS` 80, `MIN_ASSISTANT_CHARS` 200). A project needs at least `MIN_PER_PROJECT` (20) sources.
2. One model call returns a paraphrase at three tiers. The prompt carries redacted exchange text. `promptLeaksAnswerKey` rejects a prompt that leaks the answer key. The learned-text screen rejects an unsafe prompt.
3. The truth of a task is an address (a path and a line range), not a copied transcript. A re-index that moves a line marks the task `stale`. A stale task is excluded from every read and every metric.
4. A seeded, stratified split gives 60 percent `train` and 40 percent `test` for each project and tier. The seed is stored on the run, so the held-out split is comparable across runs.

Task kinds are `locate`, `recall`, `when` and `multi`. The signal kinds are `locate`, `when` and `multi`, at tiers 2 and 3. The `recall` kind needs a model judge. Its score is reported and never decides whether an edit stays.

`listTasks` is the only function that reads tasks. Its `split` argument is mandatory. The SQL predicate, not a convention, keeps the `test` split out of every learner prompt.

## Solving and grading

`solver.ts` answers one task with the knowledge that a snapshot held.

- The solver runs in an isolated agent subprocess (`agent-runner.ts`). The subprocess has no built-in tools, no settings sources, no `.mcp.json`, no saved session and exactly one MCP server, the in-process `episodic-learn` server.
- The server (`sdk-tools.ts`) serves `search`, `read`, `digest` and `skills`. These handlers (`learn-handlers.ts`) are read-only. They hide the source exchange ids of the task. Search excludes those ids and turns summaries off. The digest filters any line that cites a hidden id, and it refuses to expand one. A solver has no `handoff`. Only learners and bootstrappers also get `propose_entry`, which hands a proposal to the orchestrator and stores nothing.
- The system prompt comes from the snapshot, not from the live store. A snapshot is the knowledge at one moment. A solver that saw a later edit would make the before and after comparison meaningless.
- `solveTask` always stores the attempt. An attempt outcome is `graded`, `aborted`, `killed` or `error`. The learner excludes the last three from diagnosis, because they show that the run stopped early and do not show that the solver failed.
- `grade.ts` grades by rule: `gradeLocate`, `gradeWhen` and `gradeMulti` compare the answer with the stored address. Only `gradeRecall` calls a model, through an injected judge.

A `CallBudget` counts model calls. `BudgetExhausted` stops a run, and the attempts already stored stay.

## Bootstrap

`runBootstrap` in `bootstrap.ts` proposes the first knowledge. The function has four stages.

1. One isolated bootstrapper per eligible project maps its corpus. It proposes one `navigation` skill and one `exploration-notes` skill.
2. Every proposal passes `gateEntry`. The cited lines of the two skills are also copied to the project context. That copy feeds learner prompts only. It never enters the rendered block.
3. One text call merges the candidates into a single global instruction. Each line of it is also a heuristic.
4. The run measures. It solves the signal train tasks with an empty snapshot, and then with the candidates. Both sides must grade the same number of tasks. The pass rate must not fall. Either mean turns or cost per task must fall by at least `EPISODIC_MEMORY_LEARN_MIN_SAVING` percent. A candidate that meets all three rules is kept. An unmeasured or partly measured candidate stays a candidate.

## The learning loop

`runLearn` in `learner.ts` runs rounds. Each round has five moves.

1. **Solve** every train signal task with the current snapshot. The result is both the measurement and the failure set.
2. **Split** the failures. A single project whose failures fit `leafMax` gets one leaf learner. Otherwise the failures are cut by project. A project that is still too large is cut again by failure category. One model call makes the second cut. The code accepts the answer only when it is a partition of exactly the failed task ids. Each subset becomes a child run with a parent run id.
3. **Learn.** The leaf learners run in parallel. The concurrency setting and the global semaphore bound them.
4. **Merge.** When two children keep the same kind, project and slug, one model call writes the merged body. The body passes the same gates. A seeded sample of the signal tasks of each child is solved again against the merged snapshot. A child whose gains regress gets its own text back, and the merged version is retired. `detectHeuristicConflicts` names instruction lines that now contradict each other. One more model call can resolve them. The code retires the lines that stay unresolved and writes the conflict into the reflection.
5. **Reflect.** One screened reflection per round cites the attempt ids and exchange ids of the round.

The loop stops when a round keeps nothing, when the round limit is reached, or when the call budget is spent. The run then solves the `test` split once, with the final snapshot.

### Leaf learner

`runLeafLearner` owns one subset of train signal tasks. Each round it solves the subset and keeps the graded failures. It marks a task `suspect` when two solvers fail it while each commits to a different address. A suspect task is task noise, and no validation set includes it. One learner subprocess then reads the failed traces by address, the active entries, earlier failures and earlier reflections. It proposes edits through `propose_entry`. Each proposal passes `gateEntry`, becomes a candidate, and goes to `validateCandidate`.

### Validation

`validateCandidate` decides in Node and never in the model. A candidate stays only when at least one task that it targeted now passes and no task that passed before starts to fail. A gain with a regression, no gain, or an unmeasurable run leaves the row a candidate with its validation record. `learn status` lists it as awaiting approval. The evaluation snapshot is every active entry, minus the version that the candidate replaces, plus the candidate.

### Approval

The approval mode (`EPISODIC_MEMORY_LEARN_APPROVE`) is `instructions` (default), `all` or `none`. A skill becomes `active` when it passes validation. Under the default, an instruction entry stays `candidate`, because it loads into every session. `learn approve <name>` shows the entry, its validation record and a diff against the version it revises. The command refuses an entry with no measurement, with a recorded regression, or with a lower pass count. A human can still approve a measured candidate that misses the gain. A bootstrap run that measures no task stores no validation record. The record holds `gradedAfter`, the number of tasks with a graded attempt after the change. A bootstrap record also holds `gradedBefore`, the number before the change. When the two totals differ, the command compares the pass rates instead of the pass counts. Then the command activates the entry.

## Injection into sessions

`learned-block.ts` renders the active entries for each project that has them, plus one shared row, and stores the text in `learning.sqlite`. `learn-inject.ts` holds the render and cap functions. The session-start hook reads the stored text with `readLearnedBlockCapped`. The hook never opens the knowledge store, and `learn-inject.ts` imports only types, the screen and `redact.ts` to keep that path fast.

The block is data and not instructions. It sits inside a fence that says so (`LEARNED_FENCE_OPEN`) and it re-screens and re-redacts its text on the way out. The block has a character cap.

The `skills` MCP tool (`skills-tool.ts`) lists, searches and loads active skills. It opens a store for each call and closes it in `finally`, so a long-running server never holds a handle on `knowledge.db`.

## Export

`exportSkills` in `export.ts` writes the active skills as a tree of `SKILL.md` files. The default mode builds the whole tree in a sibling temporary folder, then renames the old root aside and the new tree into place. A rename that keeps failing with `EPERM` or `EBUSY` leaves the old tree alone and reports a warning. The copy mode (`--to <dir>`) writes file by file and removes nothing. Every field is screened and redacted again on the way out.

## Concurrency, cost and process control

- **One run at a time.** `withLearnLock` takes `.learn.lock` through the shared lock file code, so the same liveness and age rules as sync recover the lock of a crashed run. A held lock reports the pid of the holder.
- **One subprocess limit.** Every agent subprocess goes through one global semaphore (`globalAgentSemaphore`). Depth does not multiply the number of processes. An awaited nested call reuses the slot of its caller, so nesting cannot deadlock.
- **No orphan kills.** `.learn.pids` lists the live child processes. The session-start orphan reaper reads it and never ends a process of a live run. The reaper ignores the file when the process named in `.learn.lock` is not alive, so a killed run protects nothing. One tracker lists the processes for every concurrent agent of a run, at the `EPISODIC_MEMORY_LEARN_PID_POLL_MS` interval. A PID leaves the file when a listing no longer shows the PID, or when the last agent ends.
- **Budget check first.** A command that spends model calls computes its baseline cost first and refuses to start when the baseline alone exceeds the call limit.
- **Output channels.** Progress goes to standard error. The report goes to standard output.

## Configuration

`learnConfig()` reads these settings from `EPISODIC_MEMORY_LEARN_*` variables. Invalid values fall back to the default.

| Setting | Variable suffix | Default |
|---|---|---|
| Model | `MODEL` | `sonnet` |
| Approval mode | `APPROVE` | `instructions` |
| Call limit | `MAX_CALLS` | 200 |
| Cost limit in USD | `MAX_USD` | 5 |
| Time limit in minutes | `MAX_MINUTES` | 60 |
| Task limit | `MAX_TASKS` | 120 |
| Concurrency | `CONCURRENCY` | 3 |
| Rounds | `ROUNDS` | 3 |
| Minimum saving, percent | `MIN_SAVING` | 10 |
| Minimum grounding | `MIN_GROUNDING` | 3 |
| Solver turn limit | `SOLVER_MAX_TURNS` | 12 |
| Learner turn limit | `LEARNER_MAX_TURNS` | 30 |
| Block size limit, characters | `MAX_CHARS` | 2500 |
| Failures per leaf | `LEAF_MAX` | 12 |
| Edits per round | `EDITS_PER_ROUND` | 3 |
| Validation sample size | `VALIDATE_SAMPLE` | 5 |

## Commands

`episodic-memory learn <command>` runs from `src/learn-cli.ts`. That file owns the early exits (the reentrancy guard, the flag, the GPU reservation and the process priority). `cli-main.ts` then dispatches these commands: `tasks`, `solve`, `bootstrap`, `improve`, `status`, `approve`, `export`, `render` and `report`. `improve --dry-run` solves and reports without a learner. A command that changes knowledge or spends money runs under the learn lock.

## Module reference

| Module | Lines role and main exports |
|---|---|
| `types.ts` | Shared types and `isValidSlug`. No runtime imports. |
| `learn-config.ts` | `learnEnabled`, `learnConfig`, `LEARN_OFF_MESSAGE`. Imports nothing. |
| `pii-redactor.ts` | `PII_PATTERNS`, `redactPii`. |
| `learned-text-screen.ts` | `screenLearnedText`, `normalizeForScreen`. |
| `cited-ids.ts` | `parseIdCitedLines`, `IdCitationResolver`. Pure. |
| `knowledge-gate.ts` | `gateEntry`, `redactLearnedText`. Pure. |
| `knowledge-store.ts` | `KnowledgeStore`, `openKnowledgeStore`, `parseEntity`, `entryName`, `rootName`, `procedureIdFor`. |
| `knowledge-db.ts` | `insertKnowledgeEntry`, `activate`, `retire`, `listActive`, `listCandidates`, `getEntry`, `getBySlug`, `searchKnowledge`, `createSnapshot`, `getSnapshot`, `DuplicateEntry`, `InvalidEntryName`. |
| `learning-store.ts` | `openLearningDb`, `migrateLearningSchema`, `LEARNING_TABLES`. |
| `learning-db.ts` | `createRun`, `finishRun`, `addRejection`, `getRun`, `latestRun`, `insertTask`, `listTasks`, `markStale`, `insertAttempt`, `listAttempts`, `attemptsExist`, `passRate`. |
| `learn-inject.ts` | `renderLearnedBlock`, `capLearnedBlock`, `readLearnedBlock`, `readLearnedBlockCapped`, `redactKeepingMarks`. |
| `learned-block.ts` | `writeLearnedBlocks`. |
| `skills-tool.ts` | `skillsToolText`, `NO_SKILLS_MESSAGE`. |
| `tasks.ts` | `selectSourceExchanges`, `generateTasks`, `checkTasks`, `paraphrasePrompt`, `parseParaphrase`, `promptLeaksAnswerKey`. |
| `grade.ts` | `parseSolverAnswer`, `gradeLocate`, `gradeWhen`, `gradeMulti`, `gradeRecall`, `parseJudgeScore`, `samePath`. |
| `prompts.ts` | Pure prompt builders: `solverSystemPrompt`, `bootstrapperSystemPrompt`, `bootstrapperBrief`, `mergeInstructionPrompt`, `diagnosePrompt`, `editBrief`, `splitPrompt`, `mergeEntriesPrompt`, `reflectPrompt`. |
| `agent-runner.ts` | `runAgent`, `buildAgentQueryOptions`, `DISALLOWED_TOOLS`, `listAgentProcesses` (async), `isAgentSpawnTree`, `ProcessLister`. One of two modules that import the SDK. |
| `sdk-tools.ts` | `buildLearnToolServer`, `servedToolNames`, `SERVER_NAME`, `PROPOSE_TOOL_NAME`. The other module that imports the SDK. |
| `learn-handlers.ts` | `learnSearch`, `learnRead`, `learnDigest`, `learnSkills`. Read-only handlers. |
| `semaphore.ts` | `createSemaphore`, `globalAgentSemaphore`. |
| `solver.ts` | `solveTask`, `solveMany`, `CallBudget`, `BudgetExhausted`, `promptInputsForSnapshot`. |
| `validate.ts` | `validateCandidate`, `sampleIds`. |
| `bootstrap.ts` | `runBootstrap`, `eligibleProjects`, `bootstrapGain`, `indexExchangeResolver`. |
| `leaf-learner.ts` | `runLeafLearner`, `suspectTaskIds`, `NAVIGATION_SLUG`, `PROCEDURE_MATCH_THRESHOLD`. |
| `learner.ts` | `runLearn`, `splitFailures`, `parseAssignment`, `FAILURE_CATEGORIES`. |
| `learn-lock.ts` | `withLearnLock`, `readLearnPids`, `LearnLockHeld`, `LEARN_LOCK_NAME`, `LEARN_PIDS_NAME`. Imported by the sync hook. |
| `export.ts` | `exportSkills`. |
| `report.ts` | `buildReport`, `formatReport`, `latestRunId`. |
| `cli-main.ts` | `runLearnCli`, `baselineCallCount`, `baselineRefusal`, `unifiedDiff`. |
| `usage.ts` | `LEARN_USAGE`. No imports, so `--help` prints at once. |

## Verification

Generated by `repo-tools map`.
Regenerate: `repo-tools map . --out=<dir>` · Check: `repo-tools check . --docs=docs/architecture`

| Claim | Value | Source |
|---|---|---|
| totalSourceFiles | 276 | repo-tools map |

The file counts, the defaults, the table names and the step orders come from a direct reading of the source and a file listing. None of them is a `repo-tools map` metric.
