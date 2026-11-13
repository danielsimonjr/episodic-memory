# Components

This document describes each module in `src/` and `cli/`. Paths are relative to the repository root. Module groups follow the dependency direction: leaf utilities first, entry points last.

## Leaf utilities

These modules import nothing from the repository, or only other leaf modules. A caller can import them before the heavy native stack loads.

| Module | Role |
|---|---|
| `src/reentrancy.ts` | Exports `SUMMARIZER_GUARD_ENV` and `shouldSkipReentrantSync()`. A child process that the summarizer started carries the variable, and `sync` exits when it sees it. |
| `src/node-floor.ts` | Holds the minimum Node.js version. `assertNodeFloor()` returns one message when the runtime is older than the floor, and null otherwise. The launchers print the message and exit. |
| `src/deps-health.ts` | Checks that `node_modules` is complete. The module tests for the JS sentinel files (`@huggingface/transformers`, `onnxruntime-common`, `onnxruntime-node`) and for the `onnxruntime-node` binding of the running platform, not only for the folder. The MCP wrapper, the sync hook and `doctor` share the module. |
| `src/lockfile.ts` | A cross-process file lock. A lock is stale when its holder process is gone or when the lock is older than a set age. The holder writes the PID after the holder creates the file, so a file with no PID is stale only after 10 seconds. `isLockHeld` answers the same question without taking the lock. `acquireRefreshedLock` takes the lock. The function refreshes the times of the lock file four times in each stale window. A holder that runs longer than the window therefore keeps the lock. The sync worker, the `index` commands, the backfill and the learn run take their locks this way. `releaseLock` stops the refresh. |
| `src/constants.ts` | The marker text that identifies summarizer conversations, and the length cap for indexed text (`truncateForIndex`). |
| `src/content-text.ts` | Reads the message content of a transcript line. `extractContentText` returns the text of a content. `safeParseJson` returns the input when the text is not valid JSON. `parser.ts` and `show.ts` both use the module. The module imports nothing. |
| `src/redact.ts` | Opt-in secret redaction. `maybeRedactSecrets(text)` returns the text unchanged unless `EPISODIC_MEMORY_REDACT_SECRETS` is on. |
| `src/paths.ts` | Resolves every directory and file the plugin uses: the config directory, the archive, the index, the database, the learned-knowledge files, and the exclusion list. It creates directories with mode `0o700`. `findJsonlFiles` walks a project folder. `statIfExists` returns `null` for an entry that a walk cannot read, for example a link whose target is gone. |
| `src/api-endpoint.ts` | Validates a custom summarizer base URL so that a bad environment value cannot send transcripts to a hostile proxy. |
| `src/gpu-reservation.ts` | Reads the fleet GPU reservation file. `gpuReservationBlock()` says whether another agent holds the GPU. |
| `src/priority.ts` | Detects the detached background worker and lowers its process priority. |
| `src/logging.ts` | Writes the log of session-start hook failures. |
| `src/sync-banner.ts` | Formats the message for a sync that a GPU reservation deferred. |
| `src/orphan-reaper.ts` | `selectOrphans` picks the processes that a summarizer call leaves behind, so the sync hook can end them. |
| `src/mcp-auth.ts` | `getRequiredMcpToken`, `tokensEqual` and `assertMcpAuthorized`. The comparison runs in constant time. |
| `src/types.ts` | Shared types: `ConversationExchange`, `SearchResult`, `MultiConceptResult`, tool-call records. |

## Data layer

### `src/sqlite.ts`

The adapter over the `node:sqlite` built-in. Only this module imports `node:sqlite`. The built-in loads at the first `new Database(...)`, not when the module loads. The `Database` class keeps the better-sqlite3 method names. `prepare`, `exec`, `close`, `function`, `pragma` and `transaction` have the same shapes. Other modules import `Database` and the `Statement` type from this module.

The adapter differs from better-sqlite3 in these ways:

- A safe integer binds as `INTEGER`. better-sqlite3 binds every number as `REAL`. An `undefined` value binds as `NULL`.
- A single plain object binds named values. A buffer, an array or a class instance does not.
- `transaction(fn)` runs `BEGIN`, or `BEGIN DEFERRED`, `BEGIN IMMEDIATE` or `BEGIN EXCLUSIVE` for the matching method. A call inside an open transaction runs as `SAVEPOINT tx_N`. An async function throws a `TypeError` when it is wrapped. A function that returns a promise rolls back and throws a `TypeError`.
- `pragma(text)` runs `PRAGMA text` and returns the rows. With `{ simple: true }` it returns the first column of the first row.
- `new Database(path, { readonly })` opens the file read-only when `readonly` is set. A read-only open of a missing file throws.
- Every connection turns on foreign key enforcement.
- The first load of `node:sqlite` writes an experimental warning. The adapter drops that one warning and passes every other warning through.

A failed load of `node:sqlite` below the floor throws the floor message (`sqliteLoadError`); below Node 22.13.0 the module needs a flag. The constructor calls `requireTransactionState`. A Node version below 22.16.0 has no `DatabaseSync.isTransaction`. The constructor then closes the handle and throws an error that names the floor.

### `src/db.ts`

Opens the database and owns the schema. `initDatabase` creates the tables `exchanges`, `tool_calls` and `exchange_vectors`, the virtual table `exchanges_fts` (full text), and the indexes. The module then runs the schema migrations. `exchange_vectors` holds one 384-value float32 vector for each exchange. `registerVectorFunctions` registers the SQL function `vec_distance_l2` on a connection. `migrateVec0Vectors` copies the valid vectors of an earlier sqlite-vec index into `exchange_vectors` during a migrating open. The copy runs in one `BEGIN IMMEDIATE` transaction, and only when a valid vector is not yet copied. An exchange without a vector gets `embedding_version` 0, so the embedding migration embeds it again. `deleteExchangesForArchive` deletes every exchange of one archive file in one transaction, with the vector rows, full-text rows and tool-call rows of each exchange. `getSharedReaderDatabase` returns a shared read connection that the MCP server uses, so each call does not re-run the schema step. A caller that knows the schema is current can pass `migrate: false`. The migrations log to standard error.

### `src/digest-db.ts`

Creates the digest tables (`digest_entry`, `digest_fts`). Entries are never deleted. Compression sets `superseded_by` on the entries it replaces.

### `src/learn/knowledge-store.ts` and `src/learn/learning-store.ts`

`knowledge-store.ts` is the only module that knows the row layout of `knowledge.db` (tables `entities` and `relations`). It opens the file through the `Database` adapter in `src/sqlite.ts`, and every read-modify-write runs under the write lock. `learning-store.ts` opens `learning.sqlite`, which holds the learning trace and the rendered learned blocks. The hook opens this file read-only.

## Ingest and index

### `src/parser.ts`

`parseConversation` turns a transcript into exchanges. `parseConversationFile(filePath)` takes the project name from the folder of the file with `path.basename(path.dirname(...))`, so it works on Windows paths. It reads the metadata of each exchange: session id, working directory, git branch, model, and thinking settings.

### `src/embeddings.ts`

Loads the embedding pipeline once (`Xenova/bge-small-en-v1.5`, quantized `q8`). `generateEmbedding` and `generateEmbeddings` embed passages. `generateQueryEmbedding` adds the query prefix first. `formatExchangeEmbeddingText` builds the text of one exchange, and `generateExchangeEmbedding(s)` embeds it. `initEmbeddings` imports `@huggingface/transformers` at the first load, not when the module loads. A native binding that cannot load therefore makes only `initEmbeddings` fail. `initEmbeddings` then throws `EmbeddingsUnavailableError`, and `cause` holds the load error.

### `src/embedding-migration.ts`

Holds `EMBEDDING_VERSION`. It finds rows with an older version and rows with no vector in `exchange_vectors`, and re-embeds them in batches behind a lock file.

### `src/indexer.ts`

`indexConversations`, `indexSession` and `indexUnprocessed` write exchanges, tool calls and vectors to the database. They can call the summarizer for conversations that lack a summary. Each function scans the source transcript with `scanExclusionMarkers` after the parse. A transcript with an exclusion marker keeps its archive copy and gets no summary. The function deletes the index rows that an earlier run wrote for that transcript. The function skips a transcript that the scan cannot read. The rows of the transcript stay.

### `src/sync.ts`

`syncConversations(sourceDir, destDir, options)` is the core of ingest. The function walks the source folders and copies a transcript only when it is newer than the archive copy. It queues new files for indexing and queues missing summaries. It skips summarizer conversations and excluded projects. The index step scans each queued file for an exclusion marker (see `src/exclusion-marker.ts`). The index step deletes the earlier rows of a file with a marker. The index step records an error for a file that the scan cannot read, and re-queues the file. Summary work runs in this order: fresh work, then retries, then retries of legacy empty summaries. A deferral (see `src/deferral.ts`) stops the summary loop and sets `summariesDeferred`. When `initEmbeddings` fails, the function records one `(embeddings)` error and skips the index step. The summaries still run. The function sets the time of each copy of that run to the epoch. The next sync therefore copies the files again and indexes them. The function returns a `SyncResult` with counts. `summarizeOneFile` summarizes a single archive file.

The copy writes a temporary file. The copy renames the temporary file over the archive copy with `renameWithRetry` (see `src/fs-retry.ts`). The rename makes `ARCHIVE_RENAME_ATTEMPTS` (8) attempts, with waits of 2.54 s in total. On Windows any open handle on the archive copy stops the rename. A reader such as the `read` tool can hold the copy for longer than the 300 ms of the default attempts. When every attempt fails, the copy removes the temporary file. The copy then records one error for the transcript. The archive copy keeps its older time, so the next sync copies the file again. The error text says so.

### `src/exclusion-marker.ts`

`scanExclusionMarkers(filePath)` reads the whole file, one 1 MiB chunk at a time, and checks one line at a time. The function joins a line that crosses a chunk boundary before the check. The function parses only a line that holds the bytes of a marker. A marker counts only in the text of a user or assistant message. For Claude Code, that text is the string content or the `text` blocks. For Codex, that text is a `message` from the user or the assistant. Tool uses, tool results, `toolUseResult` and thinking blocks do not count. A line that does not parse counts. The function returns `'marker'`, `'clean'` or `'unreadable'`, and never throws. `shouldSkipConversation(filePath)` returns true for every result except `'clean'`. The three markers are the DO NOT INDEX instruction, the NO_INSIGHTS_FOUND prompt text and `SUMMARIZER_CONTEXT_MARKER`. `src/sync.ts`, `src/indexer.ts`, `src/verify.ts` and `src/backfill.ts` use this module. `src/sync.ts` re-exports `shouldSkipConversation`.

### `src/fs-retry.ts`

On Windows, another process can hold a file open for a moment. A rename over that file then fails with `EPERM` or `EBUSY`. `renameWithRetry(from, to, attempts)` tries the rename `attempts` times. The default is `RETRY_ATTEMPTS` (5). The wait between two attempts starts at 20 ms. The wait doubles after each failed attempt. Any other error stops the retry at once. `sleepSync` waits with `Atomics.wait`. The wait does not use the CPU. `src/sync.ts` and `src/learn/export.ts` use this module.

### `src/backfill.ts`

Summarizes archived conversations that `sync` cannot reach. It checks the GPU reservation and the summarizer backend first.

### `src/verify.ts` and `src/prune.ts`

`verify` compares the archive with the index and can repair a mismatch. `verifyIndex` skips an archive file with an exclusion marker. The index rows of that file therefore count as orphaned, and `repairIndex` deletes the rows. An archive file that the marker scan cannot read keeps its rows, and `verifyIndex` lists the file as corrupted. `repairIndex` skips a listed file with a marker, so the file gets no summary call. `prune` removes every indexed row that belongs to a set of projects.

## Summaries

### `src/summarizer.ts`

Produces conversation summaries. The default backend is the Claude Agent SDK. The SDK call runs with session persistence off. The SDK call offers no built-in tool and starts no MCP server. A second backend runs the Codex command. A Codex app-server that exits or stops reading its input makes the call reject with an error. The error does not stop the process. `getApiEnv` builds the environment for the SDK and always sets the reentrancy guard. `callDigestModel` and `callLearnModel` give the digest and the learner the same backend choice. `summarizeConversation` is the entry for one conversation. A failed SDK call throws an error that names the subtype, the status and the first 300 characters of the result text, after `redactSecrets`. A failed login throws `ClaudeAuthError` instead.

### `src/ollama-backend.ts`

An opt-in local backend. `EPISODIC_MEMORY_SUMMARIZER_BACKEND=ollama` selects it. It checks the GPU reservation and raises `GpuReservedError` when another agent holds the GPU.

### `src/claude-bin.ts`

The module chooses the Claude Code executable that the Agent SDK starts. The module imports only Node built-ins, because `cli/ensure-deps.js` imports the module before an install. `claudeExecutableOption()` returns the executable option of one SDK call:

- When `EPISODIC_MEMORY_CLAUDE_BIN` is unset or blank and the platform package `@anthropic-ai/claude-agent-sdk-<platform>-<arch>` is installed, the function returns an empty object. The SDK runs its bundled binary, and no probe runs.
- When the variable is unset and the platform package is absent, the function throws a `ClaudeBinError`. The error line names the variable. The run never falls back to a path that is not on disk.
- When the variable is set, the function returns `{ pathToClaudeCodeExecutable }` after one probe per process.

`probeClaudeBin` refuses a relative path, a `.cmd`, `.bat` or `.ps1` shim, and a script that needs a loader. `probeClaudeBin` runs `<path> --version` with piped output and a bound of `PROBE_TIMEOUT_MS` (10 seconds). A `.js` or `.mjs` path runs under the running node. The version must be at or above the floor. `sdkFloor` reads the floor from the `version` field of the SDK `manifest.json`, which names the bundled release. The floor is mandatory: an older binary can delete session records (`test/agent-sdk-floor.test.ts`). Each failure line goes to stderr once per process. A failure is kept for the process, except a timeout: the next call probes again.

### `src/deferral.ts`

`deferralDetail(error)` returns the one-line reason of a deferral, or null for an ordinary failure. Three errors defer: `GpuReservedError`, `ClaudeBinError` and `ClaudeAuthError`. `isClaudeAuthFailure(status, text)` finds a failed Claude Code login: status 401, a login phrase, or the `API Error: 401` form of the text. A bare "401" does not match, because a false match would defer the queue at every run. The summary loop of `sync`, the backfill, the digest job, the digest compression and the topic job stop at the first deferral. These steps count no attempt and write no failure record, so the queue is the same at the next run. `summarizeConversation` re-throws a deferral from a chunk or from the synthesis, so the function never stores a partial summary. On the Ollama backend, an unusable Claude fallback or a failed fallback login counts as no fallback: the Ollama error stands, and the attempt counts.

## Search and read

### `src/search.ts`

`searchConversations(query, options)` runs the vector query, the full-text query, or both, and joins results by exchange id. Every vector search runs one exact scan of `exchange_vectors`. The scan skips sidechain rows, applies the date, project, session, branch and excluded-id filters, computes `vec_distance_l2` for each remaining row, and returns the nearest rows. `searchMultipleConcepts` takes two to five concepts and returns exchanges that match all of them. `formatResults` and `formatMultiConceptResults` render markdown. `buildFtsMatchQuery` turns free text into a safe FTS expression. Each word in the expression must match in any order. When the FTS5 query fails, the LIKE search has one condition for each word. `%`, `_` and `\` in a word match as text. `l2DistanceToCosineSimilarity` converts a distance to a similarity score. The text queries select a `NULL` distance, so a row that only the text step finds has no similarity. Search attaches the summary text of an exchange when a summary exists inside the archive. When `initEmbeddings` throws `EmbeddingsUnavailableError`, a `both` search runs only the text step. The search then sends one notice to `options.onNotice`. Without that option, the search sends one notice to stderr. A `vector` search throws the error.

### `src/show.ts`

Renders an archived conversation as markdown or HTML, with an optional line range. This module is the largest in `src/`. The HTML output sends assistant text and the Codex transcript through `markdownToHtml`.

### `src/markdown-html.ts`

`markdownToHtml(text: string): string` renders Markdown to HTML for `show --html`. `escapeHtml(text: string): string` escapes the five HTML-special characters, and `show.ts` uses it too. The module uses Node built-ins only and imports nothing.

- Supported blocks: ATX headings, paragraphs, hard breaks, fenced code, thematic breaks, blockquotes, lists and GFM tables.
- Supported inline rules: code spans, links, bare `http(s)` links, and `*` and `_` emphasis. Lists can nest, and a list is tight or loose.
- Not supported: indented code, setext headings, images, angle and email autolinks, `www.` links, strikethrough, raw HTML blocks and reference links. A survey of archived assistant text found none of these constructs, except one indented code block.
- Transcript text is untrusted. The module escapes all raw HTML. `safeUrl` is the only path to an `href`. `safeUrl` allows only `http`, `https`, `mailto` and relative destinations. Each `href` is escaped once, so an entity in a destination reaches the browser as text.
- Every block and inline rule is a line or token scan. A backtick index and a per-block budget for link tails keep the run time linear. A cap on padding cells bounds the output of a wide table.

### `src/archive-path.ts`

`safeArchiveSummaryPath` and the path-confinement helpers. They accept only paths that resolve inside the archive and end in `.jsonl`.

### `src/stats.ts` and `src/doctor.ts`

`stats` counts rows, projects and sizes. A conversation counts as summarized only when its summary file holds one byte or more, because an empty file is a sentinel of the sync. `doctor` checks dependencies, the database, the embedding version, the Node.js version, the Codex hook trust and the learned-knowledge section (`doctor-learn.ts`). The hook trust check reports `unknown` at once when the Codex app-server fails, exits or stops reading its input. `formatSqliteLine` writes the `node:sqlite` line: the SQLite version and the Node version, or `FAIL` below the Node floor.

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
| `src/derived-text.ts` | `removeDerivedText` removes the digest lines that cite deleted exchanges. The sync, the `index` commands, `index --repair` and `prune` call `removeDerivedText` after a delete. The function deletes an entry with no line left. The entries that the deleted entry superseded become active again. The function calls no model. |

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
| `src/mcp-tools.ts` | Dispatches a tool call to its handler. It checks the token, validates the path for `read`, and imports the skills tool only when the learned-knowledge flag is on. It imports the topic tool only inside the `topics` branch. A search notice becomes a `Note:` line of the markdown result, or the `notices` array of the JSON result. |

## Command entry points

Each `src/*-cli.ts` file is one command. A shim in `cli/` or the umbrella dispatcher `cli/episodic-memory.js` starts it as a child process.

| Command | Source | Note |
|---|---|---|
| `sync` | `src/sync-cli.ts` | Checks the guard before it imports the native stack. Supports `--background`. With `EPISODIC_MEMORY_DISABLE_AUTO_SYNC=1`, `--background` exits 0. The command starts no worker. `buildSyncOptionsFromEnv` reads `EPISODIC_MEMORY_SKIP_SUMMARIES=1` into `skipSummaries`. |
| `index` | `src/index-cli.ts` | Subcommands `index-all`, `index-session`, `index-cleanup`, `verify`, `repair`, `rebuild`, `prune` and `vacuum`. `index-cli` checks the arguments before any work. `index-cli` exits 2 for an unknown command or option, or for an option of another command. `rebuild` runs only with `--yes`. After the argument check, `index-cli` takes the sync lock (`getSyncLockPath`). When a live holder has the lock, `index-cli` exits 75 and does no work. |
| `search` | `src/search-cli.ts` | Prints search results. |
| `show` | `src/show-cli.ts` | Prints one conversation. |
| `stats` | `src/stats-cli.ts` | Prints counts. |
| `doctor` | `src/doctor-cli.ts` | Prints health checks. |
| `backfill` | `src/backfill-cli.ts` | Summarizes the archive backlog. |
| `learn` | `src/learn-cli.ts` | Runs the learned-knowledge commands. |

The shims in `cli/` are `episodic-memory.js` (dispatcher), `index-conversations.js`, `search-conversations.js`, `sync-hook.js`, `digest-hook.js`, `mcp-server-wrapper.js`, `ensure-deps.js` and `forward-child.js`. `episodic-memory.js` and `index-conversations.js` start a child process with `runChild` of `forward-child.js` and exit with the exit code of the child. A refused argument (code 2) therefore reaches the caller. `runChild` waits for the child. When a signal stops the child, the exit code is 1. `forward-child.js` runs one script as a child. `forward-child.js` then exits with the exit code of the child. When a signal stops the child, `forward-child.js` exits 1. When the child cannot start, `forward-child.js` prints one line and exits 1. `search-conversations.js` and the four files with no extension (`episodic-memory`, `index-conversations`, `mcp-server`, `search-conversations`) use `forward-child.js`.

`ensure-deps.js` runs before the MCP server and the sync hook start. `ensureDeps` repairs `node_modules` when `repairPlan` reports a missing package or binding. The repair runs under a lock file in the plugin root. The MCP wrapper and the sync hook therefore do not repair one tree at the same time. A process waits up to 5 minutes while another live process holds the lock. The process stops waiting when the tree needs no repair. When the process cannot create the lock file, the process repairs without the lock. The repair has two steps, in this order. The first step is `npm install` for a missing package. The second step is a reinstall of `onnxruntime-node` for a missing binding. Before each step, `ensureDeps` calls `repairPlan` again. `npm install` does not restore one missing file inside an installed package. The reinstall therefore moves `node_modules/onnxruntime-node` aside and installs the package again. When the binding is still missing, the reinstall puts the old directory back and writes a failure marker in the plugin root. The next attempt waits 24 hours. A process stop during the reinstall leaves the directory in the plugin root. The next repair moves the directory back first. A failed reinstall does not stop the start: `ensureDeps` returns `onnx-missing`, and the server starts without vector search. The sync hook writes the log line that `depsRepairLogEntry` gives for the result. `onnxBindingState` returns `unshipped` when the installed version has no binding for the running pair, or uses a layout that the check does not know. A reinstall cannot help there, so `repairPlan` reports no repair. On every call, `pruneOptionalWeight` then removes the `onnxruntime-node` binding directories of the other platforms and architectures. The process loads only the `bin/napi-v6/<platform>/<arch>` directory of the running pair. When `EPISODIC_MEMORY_CLAUDE_BIN` is set and its probe passes, `pruneOptionalWeight` also removes every `@anthropic-ai/claude-agent-sdk-<platform>-<arch>` platform package. The SDK package itself stays, and so does another package with the same prefix. A failed probe removes nothing. The prune is best effort. If a removal fails, the function writes one stderr line and stops the prune. The prune never stops the start.

## Hooks

`hooks/hooks.json` registers two commands for the session-start event: `cli/sync-hook.js` and `cli/digest-hook.js`. The sync hook starts a detached background sync and ends leftover summarizer processes. The digest hook prints the digest and the learned block to the session. Both import only small modules from `dist/`.

## Learned-knowledge feature (`src/learn/`)

The feature is off unless `EPISODIC_MEMORY_LEARN` is on. `LEARN.md` gives the full description. This section is a summary only.

| Group | Modules | Role |
|---|---|---|
| Configuration | `learn-config.ts` | The flag and the settings. Imports nothing. |
| Safety | `pii-redactor.ts`, `learned-text-screen.ts`, `cited-ids.ts`, `knowledge-gate.ts` | Redact PII, screen for injection, check citations, and gate each proposal. |
| Storage | `knowledge-store.ts`, `knowledge-db.ts`, `learning-store.ts`, `learning-db.ts`, `types.ts`, `entry-order.ts` | The knowledge entries, snapshots, runs, tasks and attempts. `entry-order.ts` holds the two sort orders of the entries. |
| Injection | `learn-inject.ts`, `learned-block.ts`, `skills-tool.ts` | Render the learned block, persist it per project, and serve the `skills` tool. |
| Practice | `tasks.ts`, `prng.ts`, `solver.ts`, `grade.ts`, `agent-runner.ts`, `sdk-tools.ts`, `learn-handlers.ts`, `semaphore.ts`, `prompts.ts` | Generate tasks, solve them in isolated agent subprocesses, and grade the answers by rule. |
| Learning loop | `bootstrap.ts`, `learner.ts`, `leaf-learner.ts`, `validate.ts` | Bootstrap first knowledge, then run rounds that split failures, learn per subset, merge and reflect. |
| Operation | `cli-main.ts`, `learn-lock.ts`, `report.ts`, `export.ts`, `usage.ts` | Subcommands, the one-run lock, reports, and export to a `SKILL.md` tree. A subcommand that starts Claude Code checks the executable before it takes the lock, and exits 1 with no run when none is usable. |

## Plugin content

`agents/search-conversations.md` defines a search agent. `skills/remembering-conversations/` holds the skill text and the MCP tool reference. `prompts/search-agent.md` holds the agent prompt. `.claude-plugin/` holds the plugin and marketplace manifests.

## Verification

Generated by `repo-tools map`.
Regenerate: `repo-tools map . --out=<dir>` · Check: `repo-tools check . --docs=docs/architecture`

| Claim | Value | Source |
|---|---|---|
| totalSourceFiles | 297 | repo-tools map |
| totalClasses | 11 | repo-tools map |
| totalInterfaces | 145 | repo-tools map |
| totalFunctions | 358 | repo-tools map |
| totalConstants | 70 | repo-tools map |

The tool names, the table names and the model name come from a direct reading of `src/mcp-server.ts`, `src/db.ts` and `src/embeddings.ts`. They are not `repo-tools map` metrics.
