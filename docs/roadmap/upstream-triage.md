# Upstream triage: obra commits after the fork point

This ledger classifies the 40 commits of `obra/episodic-memory` between the fork point and `upstream/main`
7e06519 (v1.4.2 to v1.6.0, plus three later fixes). The fork side was read at fork `main` 5c4cef1.

Each commit has one class:

- **In fork**: the fork has the same behaviour. A different implementation with the same effect counts.
- **Port**: the fork lacks a real fix. The `todo.md` row of the port names the failing test.
- **Partial**: the fork has a part of the change. The missing part is a port.
- **Skip**: a release, a version or `dist/` rebuild, or a change that the fork does not need. The row gives the reason.
- **Decision**: a product choice, not a fix. The fork does not port it without a decision.

Most ports are hand ports. The fork changed the summarizer, the sync loop and the indexer, so most upstream
hunks do not apply. The upstream commit is the reference for the intent and for the tests. A cherry-pick is
possible only where the row says so.

## Summarizer

| Commit | Upstream change | Class | Fork evidence and port |
|---|---|---|---|
| 2fbb2ad (#99) | `getCodexModel` stops reading the model from history and reads `EPISODIC_MEMORY_CODEX_MODEL`. | Port | `getCodexModel` in `src/summarizer.ts` returns the model of the first Codex exchange. A history model such as `gpt-5.2-codex` gets a 400 from the Codex app server. |
| 4e89881 (#93) | Pass the session `cwd`, and retry without `resume` when a resume fails. | Skip | The fork never resumes a session. `buildSummarizerQueryOptions` takes no session id, and the short path sends the transcript text. Fork commit bdd520a removed the resume path. |
| de11f90 (#96) | An `__ERRORED__` sentinel makes a failed summary retryable after one hour. | Partial | The fork has its own retry design: the `-summary.failed` record and `EPISODIC_MEMORY_MAX_SUMMARY_ATTEMPTS` in `src/sync.ts` (fork commits bdd520a, 903c709). Do not port `summary-sentinel.ts`. Port: `getIndexStats` in `src/stats.ts` counts an empty give-up summary as a summary. |
| 41e135a (#108) | Run the summary with no tools (`tools: []`). | Partial | `buildSummarizerQueryOptions` sets `settingSources: []` and `mcpServers: {}`, but no `tools: []`. Port together with 58363b2. |
| 58363b2 (#149) | Add `strictMcpConfig: true`, so the summary process loads no MCP server of the user. | Partial | The fork lacks `strictMcpConfig`. Port together with 41e135a. |
| f06748a (#110, #145, #147, #122, #160, #104) | Keep the SDK error text, stop the batch on an auth failure, add a time limit, and warn once when `ANTHROPIC_API_KEY` bills a metered API. | Partial | The fork has a time limit (`EPISODIC_MEMORY_API_TIMEOUT_MS`) and no resume path. Port: `callClaude` throws `Summarizer SDK call failed (subtype=...)` and drops the result text, so a 401 is not visible. Each auth failure counts as one attempt, so a bad login gives up on every queued conversation. The metered warning is optional. Redact the result text before it reaches a failure record. |
| 28f0933 (#158, #166) | Send `excludeTurns: true` in the Codex `thread/fork` request. | Port | The fork request has no `excludeTurns`. codex-cli 0.150 and later refuses the ephemeral fork, and the summary falls back to the transcript text. A cherry-pick applies. |
| 07ff8f9 (#44) | Document and test the AWS Bedrock passthrough. | In fork | `getApiEnv` copies `process.env`, so the Bedrock variables reach the SDK. The upstream test is optional. |

## Sync, indexer and paths

| Commit | Upstream change | Class | Fork evidence and port |
|---|---|---|---|
| 6303454 (#97) | A single-instance lock for `sync --background`. | In fork | `src/sync-cli.ts` calls `acquireLock(getSyncLockPath())` (`src/lockfile.ts`). Test: `test/sync-cli-lock.test.ts`. |
| f5e85f3 (#101) | `busy_timeout` and `foreign_keys` in `db.ts`. | In fork | `initDatabase` and the shared reader set `busy_timeout` (`EPISODIC_MEMORY_DB_BUSY_TIMEOUT_MS`) and `foreign_keys = ON`. |
| c26c4d1 | Make the upstream single-instance lock test deterministic. | Skip | The fork has neither `src/file-lock.ts` nor that test. |
| f1bcef6 (#156) | `index` commands take the sync lock, so they cannot run beside a background sync. | Port | `src/index-cli.ts` takes no lock. |
| cff1946 (#143) | `statIfExists` skips a dangling project link instead of aborting the walk. | Port | Six raw `fs.statSync(...)` calls remain in `src/indexer.ts`, `src/sync.ts`, `src/verify.ts` and `src/index-cli.ts`. |
| 5bc902b (#132) | Skip a transcript that disappears between the listing and the copy. | Port | The copy and the parse in `indexConversations`, `indexSession` and `indexUnprocessed` (`src/indexer.ts`) have no guard. |
| 7e0a415 (#137) | When the embedding backend cannot load, sync records an error and still copies and summarizes. | Port | `syncConversations` calls `initEmbeddings()` in a `try/finally` with no `catch`, so a load failure stops the sync before the summaries. `src/sync-cli.ts` imports `embeddings.js` at the top level. |
| 6dcfed1 (#152) | A: index only the new exchanges of a grown transcript. B: find the DO NOT INDEX marker anywhere in a large file. | Partial | A is in the fork (`getMaxIndexedLine`). Port B: `shouldSkipConversation` reads only the first `SKIP_MARKER_SCAN_BYTES`, but `README.md` says that the marker works anywhere in the content. |
| 20f6da4 (#139) | Skip a message above `EPISODIC_MEMORY_MAX_MESSAGE_BYTES` (256 KB). | In fork | `MAX_INDEXED_MESSAGE_BYTES` in `src/constants.ts` reads the same variable with the same default. `truncateForIndex` cuts the message instead of dropping it (fork commit 9331084). |
| c8d0e3f (#159) | `EPISODIC_MEMORY_SKIP_SUMMARIES` turns off the summary step of a sync. | Port | The fork has no such variable. |
| fd8f839 (#163) | `EPISODIC_MEMORY_DISABLE_AUTO_SYNC` turns off the sync that the SessionStart hook starts. | Port | The fork has no such variable. |

## Search

| Commit | Upstream change | Class | Fork evidence and port |
|---|---|---|---|
| 4248fe3 (#144) | A multi-word text query matches each word, not the whole phrase. | Partial | `buildFtsMatchQuery` in `src/search.ts` quotes the whole query as one phrase, and the LIKE fallback matches `%query%`. `toFtsQuery` in `src/fts-query.ts` already quotes each word, but only the digest and topic searches use it. `test/security-speed-helpers.test.ts` pins the phrase form. |
| 489293b (#128, #126) | Vector search honours the date filters. Sidechain conversations become searchable. | Partial | Port the date fix: `hasMetadataFilters` ignores `after` and `before`, so a date-only vector search takes `limit` neighbours before the date filter and can return nothing. Decision: the fork excludes sidechains in all three search paths. Including them changes the default results and adds an MCP input. |

## Install, build and dependencies

| Commit | Upstream change | Class | Fork evidence and port |
|---|---|---|---|
| 32c8382 (#95) | Check the manifest of each required package before the MCP server starts. | In fork | `JS_SENTINELS` and `repairPlan` in `src/deps-health.ts`, with the repair in `cli/ensure-deps.js` (fork commits 1ae7457, bdd520a). |
| a3438a6 (#95) | A cross-platform `postinstall` script. | In fork | `postinstall` runs `node scripts/rebuild-native.mjs`, which exits 0. |
| cbc4881 (#150) | Load the native binding to verify it, and fall back to a node-gyp build. | Partial | `scripts/rebuild-native.mjs` loads the binding and retries `npm rebuild`. The node-gyp fallback is missing. Upstream says that `npm rebuild` can exit 0 and build nothing; the fork has not reproduced that. Port only after a reproduction. |
| ea0a29e (#161) | Kill an orphaned `npm install` child and prevent a second install. | Partial | The second-install half is in the fork (`REPAIR_LOCK` in `cli/ensure-deps.js`). The orphan kill is missing: `runNpm` uses `spawnSync`, so the npm child outlives a killed wrapper. The port is large for its value. |
| cd8dc33 (#167) | `allowScripts` for better-sqlite3 and onnxruntime-node. | Skip | The fork denies the onnxruntime-node install script on purpose (fork commit f660cec) and pins better-sqlite3. Porting would undo that decision. |
| dd5815f (#124) | Cap the onnxruntime threads on Apple Silicon (`EPISODIC_MEMORY_EMBED_THREADS`). | Skip | The default cap applies only on darwin-arm64. The fork machines are Windows x64, and the fork embeds in batches. |

## Tests, CI and harnesses

| Commit | Upstream change | Class | Fork evidence and port |
|---|---|---|---|
| 22a82a5 (#131) | Tests use a temporary folder for the config, Claude and Codex directories. | Partial | `test/test-env.ts` pins `EPISODIC_MEMORY_CONFIG_DIR`. Port: it does not pin `CLAUDE_CONFIG_DIR` or `CODEX_HOME`, so a test that reads the source directories without its own values reads the real `~/.claude` and `~/.codex` (`src/paths.ts`). |
| 8b261ea (#157) | MCP integration tests through the SDK client. | Skip | `test/mcp-protocol.test.ts` already drives the wrapper over stdio, `tools/call` included. The fork has no MCP client dependency, so the upstream file does not import. |
| 7e06519 (#169) | Pin a show test to en-US and UTC. | Skip | The fork has no test that asserts that timestamp. |
| 06d8213 (#164) | CI on every PR, on Node 22 and 24. | In fork | The fork CI runs on `pull_request`, on Node 24 only. A Node 22 leg is optional: 22 is the floor. |
| 30916f8 (#113, #117) | Cursor and opencode harnesses. | Decision | The fork reads Claude Code and Codex only (`src/types.ts`, `src/paths.ts`). A new harness is a product choice. |
| 115a767 (#148) | Oh My Pi harness. | Decision | It builds on the multi-harness code of 30916f8. |

## Releases, documentation and bundle rebuilds

| Commit | Upstream change | Class | Reason |
|---|---|---|---|
| 4825609 | Regenerate `dist/version.*`. | Skip | The fork has its own versions. |
| 1075769 | Release v1.4.2. | Skip | Version bump. |
| 34ed356 | Rebuild `dist/`. | Skip | The fork builds its own `dist/`. |
| f156416 | Rebuild `dist/`. | Skip | The fork builds its own `dist/`. |
| 7632cd8 | README text for the summary time limit, the metered warning and sidechain search. | Skip | Each paragraph goes with the port of its feature. |
| 50f06e1 | Release v1.5.0. | Skip | Version bump. |
| 2741503 | Release v1.6.0. | Skip | Version bump and bundle rebuild. |

## Totals

skip 13, partial 10, port 8, in fork 7, decision 2. Each of the 40 commits has one row.
