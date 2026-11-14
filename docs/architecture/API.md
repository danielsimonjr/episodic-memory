# API

This document lists the public surface of the package. There are four surfaces: the MCP tools, the command line, the library barrel, and the environment variables.

## MCP tools

The server name is `episodic-memory`. It registers five tools in `src/mcp-server.ts`. Every input schema is strict, and an unknown field is an error. When `EPISODIC_MEMORY_MCP_TOKEN` is set, every call must also carry `auth_token`.

### `search`

Find past conversations.

| Field | Type | Rule |
|---|---|---|
| `query` | string, or array of 2 to 5 strings | A string needs at least 2 characters. An array runs a multi-concept AND search. |
| `mode` | `vector`, `text` or `both` | Default `both`. Used for a single string only. |
| `limit` | integer 1 to 50 | Default 10. |
| `after`, `before` | `YYYY-MM-DD` | Optional date bounds. |
| `project`, `session_id`, `git_branch` | string | Exact-match filters. |
| `response_format` | `markdown` or `json` | Default `markdown`. |
| `auth_token` | string | Required when the token variable is set. |

### `read`

Read an archived conversation.

| Field | Type | Rule |
|---|---|---|
| `path` | string | The `archive_path` of a search result. It must lie inside the archive and end in `.jsonl`. |
| `startLine`, `endLine` | integer, 1-indexed, inclusive | Optional range. |
| `auth_token` | string | As above. |

### `digest`

Read or search the cited digest, or store a note.

| Field | Type | Rule |
|---|---|---|
| `query` | string | Search the digest instead of showing it. |
| `project` | string | Project key. Defaults to the key of the working directory. |
| `limit` | integer 1 to 50 | Default 10. |
| `expand` | string | An exchange id from a `[#id]` mark. Returns the archive path and line range to pass to `read`. |
| `handoff` | string, at most 2000 characters | Store a one-line note for the next session. The tool caps it at 500 characters and redacts it. |
| `auth_token` | string | As above. |

### `skills`

List learned skills, search them, or load one. It reads the knowledge store only when `EPISODIC_MEMORY_LEARN` is on.

| Field | Type | Rule |
|---|---|---|
| `get` | string | The slug of one skill. Returns its front matter and body. |
| `query` | string | Search the skills instead of listing them. |
| `project` | string | Project key. |
| `limit` | integer 1 to 50 | Default 10. |
| `auth_token` | string | As above. |

### `topics`

Read the topic memory documents of a project. The tool has five actions. The tool never writes. The tool opens the index read-only. When the index or a topic table is missing, the tool answers that topic memory has no documents yet. The tool does not read `EPISODIC_MEMORY_TOPICS`.

| Field | Type | Rule |
|---|---|---|
| `action` | string | Required. One of `list`, `read`, `search`, `links`, `timeline`. |
| `project` | string | Project key. Default: the key for the working directory. |
| `slug` | string | Required for `read`. |
| `query` | string | Required for `search`. Every word must match. |
| `unit` | string | Required for `links`. 8 lowercase hex characters. |
| `from`, `to` | string | Optional `YYYY`, `YYYY-MM` or `YYYY-MM-DD`. Used by `search` and `timeline`. `to` must not be before `from`. |
| `limit` | integer 1 to 50 | Search hits (default 10) or timeline events (default 50). |
| `auth_token` | string | As above. |

## Command line

`package.json` declares four `bin` entries.

| Binary | Target |
|---|---|
| `episodic-memory` | `cli/episodic-memory.js`, the dispatcher |
| `episodic-memory-index` | `cli/index-conversations.js` |
| `episodic-memory-search` | `cli/search-conversations` |
| `episodic-memory-mcp-server` | `cli/mcp-server` |

The dispatcher takes a command as its first argument.

| Command | Purpose |
|---|---|
| `sync` | Copy new transcripts to the archive and index them. `--background` detaches the work. |
| `index` | Subcommands `index-all`, `index-session`, `index-cleanup`, `verify`, `repair`, `rebuild`, `prune` and `vacuum`. Options include `--concurrency` and `--no-summaries`. An unknown command or option exits 2 before any work. Every command takes the sync lock first. While a sync or another index command holds the lock, the command exits 75 before any work. `cli/index-conversations.js` passes `prune`, `vacuum` and the other names to `index-cli` unchanged, and asks for confirmation before `rebuild`. `index-cli` runs `rebuild` only with `--yes`, which the wrapper adds after the answer `yes`. Each option must belong to the command. |
| `search` | Search from the terminal. `--limit` takes a positive integer. An unknown option exits 2 before any work. |
| `show` | Print one conversation. `--format markdown` (default) or `--format html`. An unknown option, a second file name or a format other than `markdown` or `html` exits 2 before any work. |
| `stats` | Print index counts. An argument other than `--help` or `-h` exits 2 before any work. |
| `doctor` | Check the install, the data, the embedding model and the learned-knowledge store. |
| `model` | Subcommands `fetch` and `status`. `fetch` downloads each missing or bad model file and checks its sha256. `status` prints the model folder and each file that is missing or bad. |
| `backfill` | Summarize archive conversations that `sync` cannot reach. `--limit` and `--batch` take a positive integer. An unknown option or argument exits 2 before any work. |
| `learn` | The learned-knowledge commands: `tasks`, `solve`, `bootstrap`, `improve`, `status`, `approve`, `export`, `render`, and the report command. When the feature flag is on, an option that the subcommand does not read exits 2 with one line. |

`learn improve --dry-run` solves and reports without running any learner. `learn approve <name> [--yes]` activates a candidate after review.

## Hooks

`hooks/hooks.json` registers `cli/sync-hook.js` and `cli/digest-hook.js` for the session-start events `startup`, `resume`, `clear` and `compact`.

## Library barrel

`src/index.ts` re-exports nine modules. The table lists the exports of eight of them. The SQLite section lists the exports of the ninth. All of these exports are the public library surface.

| Module | Exports |
|---|---|
| `types` | `ToolCall`, `ConversationHarness`, `ConversationExchange`, `SearchResult`, `MultiConceptResult` |
| `db` | `OpenDatabaseOptions`, `migrateSchema`, `migrateToolCallsCascade`, `registerVectorFunctions`, `ensureVectorTable`, `migrateVec0Vectors`, `ensureFts`, `upsertExchangeFts`, `deleteExchangeFts`, `openDatabase`, `openDatabaseReadonly`, `initDatabase`, `getSharedReaderDatabase`, `closeSharedReaderDatabase`, `insertExchange`, `getAllExchanges`, `getFileLastIndexed`, `getMaxIndexedLine`, `getFreelistInfo`, `vacuumDatabase`, `deleteExchange`, `deleteExchangesForArchive` |
| `embeddings` | `BGE_QUERY_PREFIX`, `initEmbeddings`, `EmbeddingsUnavailableError`, `generateEmbeddings`, `generateEmbedding`, `withQueryPrefix`, `generateQueryEmbedding`, `formatExchangeEmbeddingText`, `generateExchangeEmbedding`, `generateExchangeEmbeddings` |
| `indexer` | `indexConversations`, `indexSession`, `indexUnprocessed` |
| `parser` | `parseConversation`, `parseConversationFile` |
| `search` | `includeSearchSummaries`, `maxSummaryDisplayChars`, `formatSummaryForDisplay`, `SearchOptions`, `interleaveByRank`, `l2DistanceToCosineSimilarity`, `buildFtsMatchQuery`, `searchConversations`, `formatResults`, `searchMultipleConcepts`, `formatMultiConceptResults` |
| `summarizer` | `CodexSummarizerCommand`, `getApiEnv`, `shouldSkipReentrantSync`, `formatConversationText`, `extractSummary`, `buildSummarizerQueryOptions`, `buildCodexSummaryPrompt`, `buildCodexSummarizerCommand`, `getCodexModel`, `promptBudgetChars`, `CallClaudeOptions`, `callDigestModel`, `resolveLearnModels`, `callLearnModel`, `runCodexCommand`, `summarizeConversation` |
| `paths` | `tryChmod`, `getClaudeDir`, `getCodexDir`, `getConversationSourceDirs`, `findJsonlFiles`, `statIfExists`, `getSuperpowersDir`, `superpowersDirPath`, `getArchiveDir`, `archiveDirPath`, `getIndexDir`, `indexDirPath`, `getDbPath`, `getLearnedDir`, `getKnowledgeDbPath`, `getLearningDbPath`, `getExcludeConfigPath`, `getExcludedProjects` |

A `src` export that the barrel does not re-export is internal to the package, even when `repo-tools map` shows no importer for it. Removing an export from the barrel is a breaking change for library callers.

## SQLite adapter and doctor line

`src/index.ts` re-exports `src/sqlite.ts`, so a caller can name the `Database` type that `openDatabase` returns. Only `src/sqlite.ts` imports `node:sqlite`. The `Database` class keeps the better-sqlite3 method names.

| Export | Signature or shape |
|---|---|
| `Database` (class) | `new Database(path: string, options?: DatabaseOptions)`. Properties: `name`, `open` and `inTransaction`. Methods: `prepare(sql): Statement`, `exec(sql): this`, `close(): this`, `function(name, options, fn): this`, `pragma(text, options?): unknown` and `transaction<F>(fn): Transaction<F>`. |
| `requireTransactionState` | `(handle: { isTransaction?: unknown; close(): void }): void`. Closes the handle and throws when the handle has no boolean `isTransaction`. |
| `sqliteLoadError` | `(err: unknown, version: string): Error`. Returns an error that names the Node floor when `version` is below it, else the original error. |
| `BindParams` | `unknown[]`. Positional values, or one plain object of named values. |
| `Row` | `Record<string, SQLOutputValue>`. |
| `RunResult` | `{ changes: number; lastInsertRowid: number }`. |
| `Statement` | Methods `run`, `get<T>`, `all<T>` and `iterate<T>`. Each takes `...params: BindParams`. |
| `DatabaseOptions` | `{ readonly?: boolean; fileMustExist?: boolean }`. |
| `PragmaOptions` | `{ simple?: boolean }`. |
| `SqlFunctionOptions` | `{ deterministic?: boolean; directOnly?: boolean; varargs?: boolean; useBigIntArguments?: boolean }`. |
| `Transaction<F>` | `F` with the properties `deferred`, `immediate` and `exclusive`. Each property has the type `F`. |

`src/doctor.ts` exports `formatSqliteLine(sqliteVersion: string | null, nodeVersion: string): string`. The line starts with `FAIL` when the Node version is below the floor. Otherwise the line reports the SQLite version and the Node version.

## Environment variables

| Variable | Effect |
|---|---|
| `EPISODIC_MEMORY_CONFIG_DIR` | Moves the config, archive, index and learned-knowledge directories. |
| `EPISODIC_MEMORY_DB_PATH` | Overrides the database path. |
| `EPISODIC_MEMORY_DB_BUSY_TIMEOUT_MS` | SQLite busy timeout. |
| `EPISODIC_MEMORY_MCP_TOKEN` | Requires `auth_token` on MCP calls. |
| `EPISODIC_MEMORY_REDACT_SECRETS` | Turns on secret redaction for indexed and returned text. |
| `EPISODIC_MEMORY_INCLUDE_SUMMARY` | Set to `0` to hide summaries in search results. |
| `EPISODIC_MEMORY_MAX_READ_BYTES`, `_MAX_MESSAGE_BYTES`, `_MAX_SUMMARY_BYTES`, `_MAX_SUMMARY_DISPLAY_CHARS`, `_SUMMARY_LIMIT` | Size caps. |
| `EPISODIC_MEMORY_SUMMARIZER_BACKEND` | Selects the summary backend. `ollama` selects the local backend. |
| `EPISODIC_MEMORY_API_MODEL`, `_API_MODEL_FALLBACK`, `_API_BASE_URL`, `_API_TOKEN`, `_API_TIMEOUT_MS` | Summarizer API settings. |
| `EPISODIC_MEMORY_OLLAMA_URL`, `_OLLAMA_MODEL`, `_OLLAMA_MAX_PROMPT_CHARS` | Local backend settings. |
| `EPISODIC_MEMORY_CODEX_BIN`, `_CODEX_MODEL`, `_CODEX_SUMMARY_TIMEOUT_MS` | Codex summarizer settings. `_CODEX_MODEL` selects the model of the Codex fork. Without `_CODEX_MODEL`, the fork sends no model. |
| `EPISODIC_MEMORY_MAX_SUMMARY_ATTEMPTS` | Retry cap for failed summaries. |
| `EPISODIC_MEMORY_MIGRATION_BATCH` | Batch size of the embedding migration. |
| `EPISODIC_MEMORY_MODEL_DIR` | Moves the folder of the embedding model files. |
| `EPISODIC_MEMORY_MODEL_OFFLINE` | Set to `1` to turn off every download of the embedding model. |
| `HF_ENDPOINT` | Selects a mirror of the Hugging Face hub for the model download. |
| `EPISODIC_MEMORY_SUMMARIZER_GUARD` | Set by the plugin on child agent processes. Do not set it by hand. |
| `EPISODIC_MEMORY_BACKGROUND_WORKER` | Marks the detached background worker. |
| `EPISODIC_MEMORY_DIGEST` | Turns on the digest. `_DIGEST_MAX_SESSIONS`, `_DIGEST_MAX_CHARS`, `_DIGEST_DAY_CAP` and `_DIGEST_WEEK_CAP` tune it. |
| `EPISODIC_MEMORY_TOPICS` | Set to `1` to write the topic documents during sync. `_TOPICS_MAX_SESSIONS`, `_TOPICS_MAX_TRANSCRIPT_CHARS`, `_TOPICS_MAX_DOCS_CHARS`, `_TOPICS_MAX_DOC_CHARS`, `_TOPICS_MAX_DOCS` and `_TOPICS_SINCE` tune it. The MCP server does not read them. |
| `EPISODIC_MEMORY_LEARN` | Turns on the learned-knowledge feature. `_LEARN_MODEL`, `_LEARN_MAX_CALLS`, `_LEARN_MAX_MINUTES` and `_LEARN_MIN_SAVING` tune it. |

## Verification

Generated by `repo-tools map`.
Regenerate: `repo-tools map . --out=<dir>` · Check: `repo-tools check . --docs=docs/architecture`

| Claim | Value | Source |
|---|---|---|
| totalExports | 755 | repo-tools map |
| totalSourceFiles | 326 | repo-tools map |

`totalExports` counts every export in the repository, including test and tool files. The library barrel lists only the exports that `src/index.ts` re-exports. The tool schemas come from `src/mcp-schemas.ts`. The command names come from `cli/episodic-memory.js`. The variable names come from a search for `EPISODIC_MEMORY_` in `src/` and `cli/`. None of these facts is a `repo-tools map` metric.
