# Components

This document describes each module in `src/` and `cli/`. Paths are relative to the repository root. Module groups follow the dependency direction: leaf utilities first, entry points last.

## Leaf utilities

These modules import nothing from the repository, or only other leaf modules. A caller can import them before the heavy native stack loads.

| Module | Role |
|---|---|
| `src/reentrancy.ts` | Exports `SUMMARIZER_GUARD_ENV` and `shouldSkipReentrantSync()`. A child process that the summarizer started carries the variable, and `sync` exits when it sees it. |
| `src/node-floor.ts` | Holds the minimum Node.js version. `assertNodeFloor()` exits with one line on standard error when the runtime is older. |
| `src/deps-health.ts` | Checks that `node_modules` is complete. It tests for sentinel files, not only for the folder. The MCP wrapper, the sync hook and `doctor` share it. |
| `src/lockfile.ts` | A cross-process file lock. A lock is stale when its holder process is gone or when the lock is older than a set age. `isLockHeld` answers the same question without taking the lock. |
| `src/constants.ts` | The marker text that identifies summarizer conversations, and the length cap for indexed text (`truncateForIndex`). |
| `src/redact.ts` | Opt-in secret redaction. `maybeRedactSecrets(text)` returns the text unchanged unless `EPISODIC_MEMORY_REDACT_SECRETS` is on. |
| `src/paths.ts` | Resolves every directory and file the plugin uses: the config directory, the archive, the index, the database, the learned-knowledge files, and the exclusion list. It creates directories with mode `0o700`. `findJsonlFiles` walks a project folder. |
| `src/api-endpoint.ts` | Validates a custom summarizer base URL so that a bad environment value cannot send transcripts to a hostile proxy. |
| `src/gpu-reservation.ts` | Reads the fleet GPU reservation file. `gpuReservationBlock()` says whether another agent holds the GPU. |
| `src/priority.ts` | Detects the detached background worker and lowers its process priority. |
| `src/logging.ts` | Writes the log of session-start hook failures. |
| `src/sync-banner.ts` | Formats the message for a sync that a GPU reservation deferred. |
| `src/orphan-reaper.ts` | `selectOrphans` picks the processes that a summarizer call leaves behind, so the sync hook can end them. |
| `src/mcp-auth.ts` | `getRequiredMcpToken`, `tokensEqual` and `assertMcpAuthorized`. The comparison runs in constant time. |
| `src/types.ts` | Shared types: `ConversationExchange`, `SearchResult`, `MultiConceptResult`, tool-call records. |

## Data layer

### `src/db.ts`

Opens the database and owns the schema. `initDatabase` creates the tables `exchanges` and `tool_calls`, the virtual tables `vec_exchanges` (vector, 384 dimensions) and `exchanges_fts` (full text), and the indexes. It then runs migrations. `getSharedReaderDatabase` returns a shared read connection that the MCP server uses, so each call does not re-run the schema step. A caller that knows the schema is current can pass `migrate: false`. The migrations log to standard error.

### `src/digest-db.ts`

Creates the digest tables (`digest_entry`, `digest_fts`). Entries are never deleted. Compression sets `superseded_by` on the entries it replaces.

### `src/learn/knowledge-store.ts` and `src/learn/learning-store.ts`

`knowledge-store.ts` is the only module that knows the row layout of `knowledge.db` (tables `entities` and `relations`). It uses `better-sqlite3` directly, and every read-modify-write runs under the write lock. `learning-store.ts` opens `learning.sqlite`, which holds the learning trace and the rendered learned blocks. The hook opens this file read-only.

## Ingest and index

### `src/parser.ts`

`parseConversation` turns a transcript into exchanges. `parseConversationFile(filePath)` takes the project name from the folder of the file with `path.basename(path.dirname(...))`, so it works on Windows paths. It reads the metadata of each exchange: session id, working directory, git branch, model, and thinking settings.

### `src/embeddings.ts`

Loads the embedding pipeline once (`Xenova/bge-small-en-v1.5`, quantized `q8`). `generateEmbedding` and `generateEmbeddings` embed passages. `generateQueryEmbedding` adds the query prefix first. `formatExchangeEmbeddingText` builds the text of one exchange, and `generateExchangeEmbedding(s)` embeds it.

### `src/embedding-migration.ts`

Holds `EMBEDDING_VERSION`. It finds rows with an older version and re-embeds them in batches behind a lock file.

### `src/indexer.ts`

`indexConversations`, `indexSession` and `indexUnprocessed` write exchanges, tool calls and vectors to the database. They can call the summarizer for conversations that lack a summary.

### `src/sync.ts`

`syncConversations(sourceDir, destDir, options)` is the core of ingest. The function walks the source folders and copies a transcript only when it is newer than the archive copy. It queues new files for indexing and queues missing summaries. It skips summarizer conversations and excluded projects. Summary work runs in this order: fresh work, then retries, then retries of legacy empty summaries. The function returns a `SyncResult` with counts. `summarizeOneFile` summarizes a single archive file.

### `src/backfill.ts`

Summarizes archived conversations that `sync` cannot reach. It checks the GPU reservation and the summarizer backend first.

### `src/verify.ts` and `src/prune.ts`

`verify` compares the archive with the index and can repair a mismatch. `prune` removes every indexed row that belongs to a set of projects.

## Summaries

### `src/summarizer.ts`

Produces conversation summaries. The default backend is the Claude Agent SDK, called with session persistence off. A second backend runs the Codex command. `getApiEnv` builds the environment for the SDK and always sets the reentrancy guard. `callDigestModel` and `callLearnModel` give the digest and the learner the same backend choice. `summarizeConversation` is the entry for one conversation.

### `src/ollama-backend.ts`

An opt-in local backend. `EPISODIC_MEMORY_SUMMARIZER_BACKEND=ollama` selects it. It checks the GPU reservation and raises `GpuReservedError` when another agent holds the GPU.

## Search and read

### `src/search.ts`

`searchConversations(query, options)` runs the vector query, the full-text query, or both, and joins results by exchange id. `searchMultipleConcepts` takes two to five concepts and returns exchanges that match all of them. `formatResults` and `formatMultiConceptResults` render markdown. `buildFtsMatchQuery` turns free text into a safe FTS expression. `l2DistanceToCosineSimilarity` converts a distance to a similarity score. Search attaches the summary text of an exchange when a summary exists inside the archive.

### `src/show.ts`

Renders an archived conversation as markdown or HTML, with an optional line range. This module is the largest in `src/`.

### `src/archive-path.ts`

`safeArchiveSummaryPath` and the path-confinement helpers. They accept only paths that resolve inside the archive and end in `.jsonl`.

### `src/stats.ts` and `src/doctor.ts`

`stats` counts rows, projects and sizes. `doctor` checks dependencies, the database, the embedding version, the Node.js version, the Codex hook trust and the learned-knowledge section (`doctor-learn.ts`).

## Digest

| Module | Role |
|---|---|
| `src/digest-phase.ts` | The digest step of a sync run. It never throws. A sync run waits until the digest step ends. |
| `src/digest-job.ts` | Summarizes quiet sessions into cited digest entries. A session counts as quiet after 30 minutes of no new exchange. |
| `src/digest-prompts.ts` | Builds the prompt, with caps on each exchange and on the whole transcript. |
| `src/digest-validate.ts` | Keeps only lines that cite real exchange ids, and rewrites marks to `[#id,#id]`. |
| `src/digest-compress.ts` | Compresses past days and weeks into one entry each. |
| `src/digest-inject.ts` | Builds the digest text for the session-start hook and derives the project key from a working directory. |
| `src/digest-tool.ts` | The body of the `digest` MCP tool. |

## Topic memory

| Module | Role |
|---|---|
| `src/topic-phase.ts` | The topic step of a sync run. It never throws. The sync awaits the step, so a slow model call delays the end of the sync. |
| `src/topic-job.ts` | Picks the finished sessions, calls the digest model, validates each edit, and installs it in one transaction. |
| `src/topic-prompts.ts` | Builds the organize prompt and parses the `FILE` and `DELETE` blocks of the answer. |
| `src/topic-validate.ts` | Runs the checks of one staged edit. It returns one error line for each failed check. |
| `src/topic-format.ts` | Parses and serializes topic documents. It finds units, footnotes and links, and assigns unit ids. |
| `src/topic-db.ts` | Creates the topic tables, installs an edit with its derived tables, and runs the read queries. |
| `src/topic-time.ts` | Checks the time forms and the unit id pattern. It imports nothing. |
| `src/fts-query.ts` | Turns free text into an FTS5 query. It is also used by `digest-db.ts`. |
| `src/topic-tool.ts` | The body of the `topics` MCP tool. It is read-only. |

## MCP server

| Module | Role |
|---|---|
| `src/mcp-server.ts` | Creates the server, registers the tools `search`, `read`, `digest`, `skills` and `topics`, and connects the stdio transport. |
| `src/mcp-schemas.ts` | Strict Zod schemas for the tool inputs (`SearchInputSchema`, `ShowConversationInputSchema`, `DigestInputSchema`, `SkillsInputSchema`, `TopicsInputSchema`) and `handleMcpError`. It imports only `topic-time.ts` eagerly. |
| `src/mcp-tools.ts` | Dispatches a tool call to its handler. It checks the token, validates the path for `read`, and imports the skills tool only when the learned-knowledge flag is on. It imports the topic tool only inside the `topics` branch. |

## Command entry points

Each `src/*-cli.ts` file is one command. A shim in `cli/` or the umbrella dispatcher `cli/episodic-memory.js` starts it as a child process.

| Command | Source | Note |
|---|---|---|
| `sync` | `src/sync-cli.ts` | Checks the guard before it imports the native stack. Supports `--background`. |
| `index` | `src/index-cli.ts` | Subcommands `index-all`, `index-session`, `index-cleanup`, `verify`, `repair`, `rebuild`, `prune` and `vacuum`. |
| `search` | `src/search-cli.ts` | Prints search results. |
| `show` | `src/show-cli.ts` | Prints one conversation. |
| `stats` | `src/stats-cli.ts` | Prints counts. |
| `doctor` | `src/doctor-cli.ts` | Prints health checks. |
| `backfill` | `src/backfill-cli.ts` | Summarizes the archive backlog. |
| `learn` | `src/learn-cli.ts` | Runs the learned-knowledge commands. |

The shims in `cli/` are `episodic-memory.js` (dispatcher), `index-conversations.js`, `search-conversations.js`, `sync-hook.js`, `digest-hook.js`, `mcp-server-wrapper.js` and `ensure-deps.js`.

## Hooks

`hooks/hooks.json` registers two commands for the session-start event: `cli/sync-hook.js` and `cli/digest-hook.js`. The sync hook starts a detached background sync and ends leftover summarizer processes. The digest hook prints the digest and the learned block to the session. Both import only small modules from `dist/`.

## Learned-knowledge feature (`src/learn/`)

The feature is off unless `EPISODIC_MEMORY_LEARN` is on. `LEARN.md` gives the full description. This section is a summary only.

| Group | Modules | Role |
|---|---|---|
| Configuration | `learn-config.ts` | The flag and the settings. Imports nothing. |
| Safety | `pii-redactor.ts`, `learned-text-screen.ts`, `cited-ids.ts`, `knowledge-gate.ts` | Redact PII, screen for injection, check citations, and gate each proposal. |
| Storage | `knowledge-store.ts`, `knowledge-db.ts`, `learning-store.ts`, `learning-db.ts`, `types.ts` | The knowledge entries, snapshots, runs, tasks and attempts. |
| Injection | `learn-inject.ts`, `learned-block.ts`, `skills-tool.ts` | Render the learned block, persist it per project, and serve the `skills` tool. |
| Practice | `tasks.ts`, `solver.ts`, `grade.ts`, `agent-runner.ts`, `sdk-tools.ts`, `learn-handlers.ts`, `semaphore.ts`, `prompts.ts` | Generate tasks, solve them in isolated agent subprocesses, and grade the answers by rule. |
| Learning loop | `bootstrap.ts`, `learner.ts`, `leaf-learner.ts`, `validate.ts` | Bootstrap first knowledge, then run rounds that split failures, learn per subset, merge and reflect. |
| Operation | `cli-main.ts`, `learn-lock.ts`, `report.ts`, `export.ts`, `usage.ts` | Subcommands, the one-run lock, reports, and export to a `SKILL.md` tree. |

## Plugin content

`agents/search-conversations.md` defines a search agent. `skills/remembering-conversations/` holds the skill text and the MCP tool reference. `prompts/search-agent.md` holds the agent prompt. `.claude-plugin/` holds the plugin and marketplace manifests.

## Verification

Generated by `repo-tools map`.
Regenerate: `repo-tools map . --out=<dir>` · Check: `repo-tools check . --docs=docs/architecture`

| Claim | Value | Source |
|---|---|---|
| totalSourceFiles | 249 | repo-tools map |
| totalClasses | 7 | repo-tools map |
| totalInterfaces | 136 | repo-tools map |
| totalFunctions | 316 | repo-tools map |
| totalConstants | 63 | repo-tools map |

The tool names, the table names and the model name come from a direct reading of `src/mcp-server.ts`, `src/db.ts` and `src/embeddings.ts`. They are not `repo-tools map` metrics.
