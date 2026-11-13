## [Unreleased]

### Fixed
- **A row that only the text step of a `both` search finds has no similarity.** The text queries selected `0 as distance`. A distance of 0 converts to a similarity of 1.0. Such a row therefore showed as a 100% match, a higher score than the rows that the vector step found. The text queries now select a `NULL` distance. A row that the vector step finds keeps the similarity of its distance.
- **The archive copy waits up to 2.54 s for a reader before the rename fails.** On Windows any open handle on the archive copy stops the rename that replaces the copy. A reader such as the `read` tool or a search can hold the copy for longer than 300 ms. The copy waited for 300 ms before. The copy now makes 8 attempts (`ARCHIVE_RENAME_ATTEMPTS` of `src/sync.ts`). If every attempt fails, the error says that the next sync copies the file again. `renameWithRetry` takes the number of attempts as a third argument. The other callers keep the 5 attempts.
- **A `both` search returns the text results when the embedding backend cannot load.** Before, `EmbeddingsUnavailableError` failed the default search, although the text step needs no embedder. The search now sends one notice. The notice names the missing vector step. In the markdown result, the `search` tool puts the notice in a `Note:` line. In the JSON result, the `search` tool puts the notice in the `notices` array. These text results have no similarity. A `vector` search and a multi-concept search still fail, because both searches need the embeddings. Any other embedding error still fails the search. The new `onNotice` option of `searchConversations` receives the notice.

## [1.9.0] - 2026-11-13

### Added
- **`EPISODIC_MEMORY_SKIP_SUMMARIES=1` turns off the summary step of a sync.** The sync still copies and indexes the conversations. The sync writes no summary. The sync prints `Summaries: skipped`. The new `buildSyncOptionsFromEnv` of `src/sync.ts` reads the variable. Only the exact value `1` turns the switch on. A summary only decorates a search result, so the switch does not change what a search finds. The switch does not affect the digest, the topic step and `backfill`. `sync --help` lists the variable. Ported from upstream c8d0e3f.
- **`EPISODIC_MEMORY_DISABLE_AUTO_SYNC=1` stops the sync that the SessionStart hook starts.** `sync --background` then writes one stderr line. The command exits 0 and starts no worker. A sync in the foreground still runs, so a manual `episodic-memory sync` and a scheduled task are not affected. Only the exact value `1` turns the switch on. `sync --help` lists the variable. Ported from upstream fd8f839.
- **`docs/roadmap/upstream-triage.md` classifies the 40 obra commits after the fork point.** Each commit is in the fork, a port, a partial port, a skip or a product decision, with the fork evidence. The ledger finds 8 ports and 10 partial ports. `todo.md` has one row for each port.
- **A host can drop the 269 MB bundled Claude Code binary (opt-in, `EPISODIC_MEMORY_CLAUDE_BIN`).** The Agent SDK starts the binary of its platform package, for example `@anthropic-ai/claude-agent-sdk-win32-x64`. A host that sets the variable to an absolute path of its own Claude Code binary uses that binary instead.
  - `src/claude-bin.ts` runs `<path> --version` once per process, with a bound of 10 seconds. A timeout is not kept, so a slow cold start retries at the next call. The version must be at or above the floor in the SDK `manifest.json`, because an older binary can delete session records.
  - When the probe passes, `ensureDeps` removes every `claude-agent-sdk-<platform>-<arch>` platform package. Another package with the same prefix stays. One call removed 269,231,840 bytes from an install at the `bun.lock` versions. With the variable unset, nothing changes.
  - When no usable executable exists, the summaries, the digest, the topic step and the backfill defer (`src/deferral.ts`), as they do for a GPU reservation. They count no attempt and write no failure record. The learn commands that start Claude Code exit 1 before the lock.
  - On the Ollama backend, an unusable Claude fallback counts as no fallback. The Ollama error stands and the attempt counts, so one transcript that Ollama cannot summarize does not hold back the queue.
  - `.mcp.json` passes the variable to the MCP wrapper. A plain `npm install` or `bun install` restores the package, after the variable is removed.
  - The rollback steps of the plan and the CLAUDE.md repair recipe now run `npm install --omit=dev`, as the installer does. Without the flag, a plugin host gets the devDependencies back.
  - `backfill` no longer says "when the GPU is free" for every pause. The message now names no cause, because the deferral detail before it names the cause.
- **Dependency-minimization plan (`docs/roadmap/dependency-minimization.md`).** The plan measures each dependency of the 839.2 MB plugin tree and gives a verdict with a saving, a risk, an acceptance test and a rollback. Five PRs are DO: quick wins, `--omit=dev` on plugin hosts, an `onnxruntime-web` stub override, a prune of the idle `onnxruntime-node` binaries, and an opt-in removal of the Agent SDK platform binary. The default-host saving is 377.2 MB (estimate); an opt-in host saves 269.2 MB more. A direct ONNX embedding path and the move to `node:sqlite` are DO LATER, each with its gate. `docs/roadmap/README.md` links the plan, and `todo.md` lists one row per PR.

### Fixed
- **`stats` no longer counts an empty summary file as a summary.** The sync writes an empty `-summary.txt` for a conversation with no exchanges, and for a summary that the sync gave up on after `EPISODIC_MEMORY_MAX_SUMMARY_ATTEMPTS`. `getIndexStats` counted every existing file, so these conversations counted as summarized. `getIndexStats` now counts a file only when the file holds one byte or more, the same rule that the sync uses for its sentinel. Ported from upstream de11f90. The fork keeps its own retry design. The fork does not port the `__ERRORED__` sentinel.
- **A sync, an `index` command, a backfill or a learn run keeps its lock while it runs.** `acquireLock` treats a lock file older than the stale window as stale, also when the holder is alive. No holder refreshed its lock file. As a result, a sync or an `index --rebuild` that ran longer than 1 hour lost the sync lock. A second sync could then start beside it. A learn run that ran longer than 2 hours lost `.learn.lock` in the same way. The new `acquireRefreshedLock` of `src/lockfile.ts` takes the lock. The function also refreshes the times of the lock file four times in each stale window. The refresh uses the open descriptor, so the refresh never touches a lock file that another process created. The timer does not keep the process alive. `releaseLock` stops the timer before the close. The sync worker, the `index` commands, the backfill and `withLearnLock` take their locks this way. The embedding-migration lock does not change, because a holder keeps that lock for one batch only.
- **The `index` commands take the sync lock.** `index-cli` took no lock. As a result, an `index --rebuild` could delete the database while a background sync wrote to the database, and two runs could index the same files. Every `index` command now takes the lock of the sync worker after the argument check. While a sync or another `index` command holds the lock, the command writes one error line, exits 75 and does no work. Upstream exits 0 there. The fork exits 75, because the exit code of `index` reaches the caller and a skipped rebuild is not a success. The skip message of the sync now says "another sync or index command is running". Ported from upstream f1bcef6.
- **The `index` commands honour the DO NOT INDEX marker.** `indexConversations`, `indexSession` and `indexUnprocessed` never checked the marker. As a result, `index`, `index --rebuild`, `index --cleanup` and `index --session` indexed and summarized a conversation that the sync keeps out. Each function now scans the source transcript after the parse. A conversation with a marker keeps its archive copy and gets no index rows and no summary. Upstream has the same gap. This fix is the fork's.
- **`verify` and `verify --repair` honour the DO NOT INDEX marker.** The sync writes no summary for an excluded conversation, so `verifyIndex` listed each excluded archive file as missing. `repairIndex` then sent the conversation to the summarizer and indexed the conversation. `verifyIndex` now skips an excluded file, so the index rows of that file count as orphaned and a repair deletes the rows. An archive file that the marker scan cannot read keeps its rows, and `verifyIndex` lists the file as corrupted. `repairIndex` also skips a listed file that has the marker. To remove the rows of an excluded conversation that an earlier index run wrote, run `index --repair` or `index --rebuild`. This fix is the fork's.
- **The sync finds the DO NOT INDEX marker anywhere in a transcript.** The README says that the marker works anywhere in a conversation. `shouldSkipConversation` read only the first 256 KiB. As a result, a marker later in a long transcript was not seen, and the sync indexed the conversation. The scan now reads the whole file in 1 MiB chunks and compares bytes. Each chunk starts with the end of the previous chunk, so a marker that crosses a boundary still matches. A file that the scan cannot read now counts as excluded. Ported from upstream 6dcfed1 (part B).
- **The index step records an error for an archive copy that the marker scan cannot read.** With the fail-closed scan of upstream 6dcfed1, the index step skipped such a file and recorded nothing. The file then stayed out of the index until its transcript changed again. The sync now records an error and re-queues the file, so the next sync scans the file again. This fix is the fork's.
- **A sync continues when the embedding backend cannot load.** On some hosts a native binding of `@huggingface/transformers` cannot load, for example the binding of sharp (libvips). `embeddings.ts` imported transformers when the module loaded. As a result, the import of `embeddings.js` threw, `sync-cli` stopped before the sync, and no summary, digest or topic step ran. `initEmbeddings` now imports transformers at the first load and throws `EmbeddingsUnavailableError`, with the load error as `cause`. The sync records one `(embeddings)` error, skips the index step and still runs the summaries. Ported from upstream 7e0a415.
- **The MCP server no longer loads transformers when it starts.** The bundle keeps `@huggingface/transformers` external, so esbuild turned the static import of `embeddings.ts` into a top-level import of `dist/mcp-server.js`. As a result, every server start loaded transformers and its native bindings, although only the `search` tool uses them. A host where a binding cannot load lost every tool. The lazy import of 7e0a415 removes the top-level import. Measured on this machine: a start loaded 5 native libraries before (onnxruntime and sharp with libvips) and 0 after. The median time to the `initialize` answer went from 213 ms to 140 ms, in 5 runs each. `test/mcp-protocol.test.ts` makes the package fail to resolve and checks the handshake, ListTools and a text search.
- **A file that a sync copied but could not index gets its index entry at the next sync.** The sync indexes only the files that it copied in the same run. A transcript that a run copied during a backend failure stayed out of the index until the transcript changed again. The failed run now sets the time of each of its copies to the epoch. The next sync therefore copies the files again and indexes them. This fix is the fork's; upstream 7e0a415 skips the index step only.
- **A vector search with a date filter returns the rows in the date range.** vec0 takes the nearest rows before it applies a WHERE clause. The KNN step took `limit` rows, and the date filter then dropped them. As a result, a search for a date range whose rows were not the nearest rows returned too few rows, or none. A project, session, branch or excluded-id filter took `limit` x3 rows and could also return too few. A vector search with a filter now scans the filtered rows exactly and sorts them by distance. On 13,000 scratch rows, a date filter that keeps half the rows took 38 ms, and a KNN query took 14 ms. Ported from upstream 489293b (the date part).
- **A vector search with no filter fills its limit when the nearest rows are sidechain rows.** A search never returns a sidechain row, and the KNN step took only `limit` rows. As a result, a search could return fewer rows than `limit`. The KNN step now takes `limit` x3 rows, at most 4096, the largest `k` of sqlite-vec. When the result is still short and the KNN step did not read every row, the search uses the exact scan. This fix is the fork's. Upstream 489293b also adds a search of sidechain rows, which stays a product decision.
- **A text search with several words matches each word.** The `text` mode quoted the whole query as one FTS5 phrase, and the LIKE fallback matched the whole query as one substring. As a result, "database refactor" missed "refactor the database layer". `buildFtsMatchQuery` now quotes each word (`toFtsQuery`), so each word must match in any order. The LIKE fallback has one condition for each word, and `%`, `_` and `\` in a word match as text, not as wildcards. Ported from upstream 4248fe3 (obra/episodic-memory#144).
- **A failed Claude Code login defers the summaries instead of using up their attempts.** Each queued conversation made one SDK call, got a 401, and lost one attempt. After three runs every queued conversation gave up with an empty summary. The new `ClaudeAuthError` (`src/deferral.ts`) defers the work: the summary loop, the digest, the topic job and the backfill stop at the first failed call and count no attempt. The detail names the status and says to run `claude auth login`. Ported from upstream f06748a (obra/episodic-memory#145).
- **A failed summary call keeps the cause.** `callClaude` threw `Summarizer SDK call failed (subtype=...)`. `callClaude` dropped the result text. As a result, the failure record did not show the API error. The error now names the status and the first 300 characters of the text, after `redactSecrets`. Ported from upstream f06748a (obra/episodic-memory#110).
- **Tests no longer read the real Claude and Codex transcripts.** `test/test-env.ts` did not pin `CLAUDE_CONFIG_DIR` or `CODEX_HOME`. A test that walked the projects without its own folder therefore read `~/.claude` and `~/.codex` of the machine. Both variables now point to empty temporary folders. Ported from upstream 22a82a5 (obra/episodic-memory#131).
- **An index run skips a transcript that disappears after the listing.** Claude Code can delete a transcript after the walk lists the transcript and before the copy. The copy or the parse then threw ENOENT. The whole run stopped. `indexConversations`, `indexSession` and `indexUnprocessed` now log the file and skip it. Any other error still stops the run. Ported from upstream 5bc902b (obra/episodic-memory#132).
- **An index run closes the database when the run fails.** `indexConversations`, `indexSession` and `indexUnprocessed` closed the database only on the success path. An error left the handle open. An embedding backend that fails to load is one example. On Windows, the open handle locks the database file. Each function now closes the database in a `finally` block.
- **A dangling project link no longer stops a sync, an index run or a verify run.** A storage migration can leave a link whose target is gone in a projects folder or in the archive. `fs.statSync` threw ENOENT on the link. The whole walk stopped. The new `statIfExists` in `src/paths.ts` returns `null` for this type of entry. The six walks in `sync.ts`, `indexer.ts`, `verify.ts` and `index-cli.ts` skip the entry. Ported from upstream cff1946 (obra/episodic-memory#143).
- **A summary call offers no tool and loads no MCP configuration.** The SDK options of the summarizer now set `tools: []` and `strictMcpConfig: true`. Before, the subprocess offered every built-in tool. The SDK documents that `strictMcpConfig` ignores every MCP configuration except the `mcpServers` option. On the Claude backend, the digest, topic and learn text calls use the same options. Ported from upstream 41e135a and 58363b2 (obra/episodic-memory#108, #149).
- **A Codex summary no longer sends the model of the conversation history.** The Codex app server refuses some history models, for example `gpt-5.2-codex`. A `-codex` model also needs an API key. As a result, a ChatGPT login gets a 400 error. The fork request now sends no model. Codex uses the model of its configuration. The new variable `EPISODIC_MEMORY_CODEX_MODEL` selects a model. Ported from upstream 2fbb2ad (obra/episodic-memory#99).
- **A Codex summary uses the native fork path again on codex-cli 0.150 and later.** The `thread/fork` request now sends `excludeTurns: true`. Without the flag, codex-cli 0.150 refuses an ephemeral fork of a paginated thread. Without the flag, the summary fell back to the transcript text. Ported from upstream 28f0933 (obra/episodic-memory#166).
- **An entry of an unknown kind no longer breaks the sort of the knowledge store lists.** The sort of `listActive` and `listCandidates` in `src/learn/knowledge-db.ts` read the kind from a table with no default. An entry with a kind outside the table gave NaN. The sort order was then undefined. The shared order sorts an unknown kind after the three known kinds.
- **A test can no longer reach the real Claude Agent SDK.** A test that passed no fake judge, agent runner or text model started a real Claude Code process. On a machine that is logged in, the call spent usage. On a machine that is not logged in, the call stalled to the test timeout. `test/setup-env.ts` now replaces `query` of `@anthropic-ai/claude-agent-sdk` with the guard of the new `test/real-sdk-guard.ts`. The guard records the call. The guard then throws at once. An `afterEach` then fails the test, also when the code under test catches the error. A test file that mocks the SDK itself keeps its own mock. `test/test-env.ts` also pins `EPISODIC_MEMORY_CODEX_BIN` to a path that does not exist. A Codex summary in a test therefore fails at once. The summary starts no real Codex. The first guarded run found one such test. `repairIndex` in `test/verify.test.ts` wrote a summary with a real model call on every run. The test now passes a fake summarizer. The test also checks the summary file. The new `test/real-sdk-guard.test.ts` has 5 tests. A control test that catches the guard error failed in 3 ms with the guard message.
- **The dependency check finds a missing `onnxruntime-node` binding. The repair installs the package again.** `src/deps-health.ts` checked `onnxruntime-common` and the transformers manifest, not the `onnxruntime-node` binding. A tree without `onnxruntime-node/bin/napi-v6/<platform>/<arch>/onnxruntime_binding.node` passed the check. The first embedding then failed. `npm install` does not restore one missing file inside an installed package. The new `onnxBindingState` returns `present`, `missing` or `unshipped`. `repairPlan` returns the new step `reinstall-onnx` for a `missing` binding. `ensureDeps` then moves `node_modules/onnxruntime-node` aside, runs `npm install --omit=dev --no-audit --no-fund` and checks the binding. When the binding is still missing, `ensureDeps` puts the old directory back. `ensureDeps` then writes `.episodic-memory-onnx-repair-failed` in the plugin root. The next attempt waits 24 hours (`ONNX_RETRY_MS`), so a host with no network does not run a failed install on every start. When `ensureDeps` cannot write the marker, `ensureDeps` writes one stderr line. The next start then tries the reinstall again. A process stop during the reinstall leaves the package directory in the plugin root. The next repair moves the directory back before any other step. A failed reinstall does not stop the start. `ensureDeps` returns `onnx-missing`, and the MCP server starts without vector search. The sync hook logs one error line. The new `depsRepairLogEntry` in `cli/ensure-deps.js` selects that line, so a test covers the choice. Some hosts get no binding from the package (darwin/x64 in 1.24.3). Such a host reads as `unshipped` and gets no repair. A package with no `bin/napi-v6` directory reads as `unshipped` too. `onnxruntime-node/package.json` is now a sentinel, so a missing package gives `install`. `doctor` now tells you to delete `node_modules/onnxruntime-node` before `npm install`. On the scratch npm plugin host (`onnxruntime-node` 1.30.0, Windows x64), the repair of a deleted binding took 2.4 to 5.5 s. The binding loaded after the repair. The prune left one pair. With the registry unreachable and an empty npm cache, the repair took 0.93 to 1.73 s in two runs. The repair put the old directory back and exited 0. The next call skipped the reinstall in 3.3 to 8.6 ms. A package directory that was moved aside by hand came back in 25.5 ms, with no npm call. The new `test/ensure-deps-repair.test.ts` has 22 tests, and `test/deps-health.test.ts` has 9 new tests. The tests cover the states, the order of the steps, the restore, the marker, the stopped reinstall and the lock. Each of 27 mutants fails at least one test.
- **`isLockStealable` no longer steals a lock file at once when the file holds no PID yet.** `acquireLock` creates the lock file and then writes the PID of the process into the file. A second process that read the file between the two steps found no PID. That process could then steal a lock that a live process had just created. `isLockStealable` in `src/lockfile.ts` now steals a file with no valid PID only when the file is older than 10 seconds (`EMPTY_LOCK_GRACE_MS`). The rule applies to every lock of `src/lockfile.ts`: the sync lock, the embedding migration lock, the learn lock and the repair lock. `readLearnPids` reads such a file as held for the same 10 seconds. Two new tests in `test/lockfile.test.ts` cover the new file and the old file.
- **The MCP wrapper and the sync hook no longer repair one tree at the same time.** Both call `ensureDeps` at session start. Nothing serialized the repair. Two `npm install` runs could overlap in one plugin root. With the new reinstall, one process could move the package directory of the other. The repair now runs under `.episodic-memory-repair.lock` in the plugin root (`acquireLock` of `src/lockfile.ts`, with the PID check and the stale-lock rule). A process waits up to 5 minutes (`REPAIR_WAIT_MS`) while another live process holds the lock. The process stops waiting when the tree needs no repair. After the wait, the process repairs nothing and writes one stderr line that names the lock. When the process cannot create the lock file, the process writes one stderr line. The process then repairs without the lock. On the scratch host, two processes that started together ran one install. Both processes exited 0. `.gitignore` lists the lock, the marker and the backup directory, because a repo checkout is a plugin root too.
- **`sync` retries the rename of a transcript copy that Windows holds open.** `copyIfNewer` in `src/sync.ts` copies a transcript to a temporary file. Then `copyIfNewer` renames the temporary file over the archive copy. On Windows another process can hold the archive copy open for a moment. One failed rename was then a sync error for that transcript (`Errors: 1`, `EPERM`). The rename now retries `EPERM` and `EBUSY` up to 5 times. `src/learn/export.ts` had the same retry as a private function. The new module `src/fs-retry.ts` holds the one copy of the retry code. The wait between attempts now uses `Atomics.wait`, not a busy loop.
- **A forwarding entry point in `cli/` exits non-zero when a signal stops its child.** `cli/episodic-memory`, `cli/index-conversations`, `cli/mcp-server`, `cli/search-conversations` and `cli/search-conversations.js` ended with `process.exit(code ?? 0)`. A child that a signal stops has no exit code. These entry points then exited 0, and the caller saw success. The five files had no `error` handler, so a child that could not start ended in a stack trace. The five files now call `forward` in the new `cli/forward-child.js`. When a signal stops the child, the entry point exits 1, as `cli/episodic-memory.js` does. When the child cannot start, the entry point prints `episodic-memory: cannot start <script>: <reason>`. The entry point then exits 1. `package.json` names `cli/search-conversations` and `cli/mcp-server` as `bin` entries, so the files stay.
- **`learn approve` refuses a record that measured no task, or whose pass count fell.** A bootstrap run with the verdict `unmeasured` stored a validation record with no task and no attempt after the change. `learn approve` checked only for a missing record and for listed regressions. So the command read that record as a clean measurement. A bootstrap record lists no per-task result, so a `pass-rate-fell` verdict also stored no regression. Now a bootstrap run that measured nothing stores no record, and the candidate stays unvalidated, as in `validate.ts`. The validation record now holds `gradedAfter`, the number of tasks with a graded attempt after the change. An errored or aborted attempt counts no task. `learn approve` refuses a record with no graded task after the change. A record written before this field existed counts as unmeasured when the record has no attempt after the change. `learn approve` also refuses a record whose pass count fell. A bootstrap record also holds `gradedBefore`, because its two sides can grade different numbers of tasks. When the two graded totals of a bootstrap record differ, the command compares the pass rates instead of the counts. A human can still approve a measured candidate that missed the gain (spec §7 rule 5). An existing empty record stays in the store. `learn approve` refuses that record.
- **`index` refuses an unknown argument, and `index prune`, `index vacuum` and `index rebuild` run.** `dist/index-cli.js` sent any unknown command or option, and `--help`, to its default branch. That branch indexes every source with summaries. `index-cli` now checks the arguments before any work. `index-cli` exits 2 on an unknown command, an unknown option, or a second argument for a command that takes none. It writes the line `episodic-memory index: unknown <kind> <arg>`. `--help` prints the usage. Each option must belong to the command. `--dry-run`, `--excluded` and `--project` apply only to `prune`. `--concurrency`, `-c` and `--no-summaries` apply only to the index commands and `rebuild`. So `index --dry-run` no longer starts a real index. `--concurrency` and `-c` need an integer from 1 to 16. Before, any other value became 1 with no message. `rebuild` deletes the index database and every summary file. `index-cli` now runs it only with `--yes`, so an option before the command, as in `index --no-summaries rebuild`, cannot start the delete without `--yes`. `dist/index-cli.js rebuild` without `--yes` deleted both with no question. `index-session` reads its session id from the second argument that is not an option. So `index-session --concurrency 2` no longer takes `--concurrency` as the id. The wrapper `cli/index-conversations.js` sent every first argument that it did not list to `index-all`. So `episodic-memory index prune --excluded` and `index vacuum` ran a full index. `index rebuild`, the reset recipe of `CLAUDE.md`, also ran a full index and deleted nothing. The wrapper now passes such arguments to `index-cli` unchanged. The wrapper asks for confirmation before `rebuild`, as it does before `--rebuild`, and adds `--yes` after the answer `yes`. A caller with no terminal passes `--yes` and gets no question. Its help lists `prune` and `vacuum`. `cli/episodic-memory.js` and the wrapper made each failure of a child exit 1. They now exit with the code of the child, so `episodic-memory sync --bogus` and `episodic-memory index --bogus` exit 2. A caller that only tests for a non-zero code sees no change. `test/index-cli-args.test.ts` covers each entry point in an empty home.
- **`sync` refuses an unknown option.** `episodic-memory sync --no-summaries` ran a full sync with summaries. The command said nothing about the flag. `sync` now accepts only `--background` and `--help` (or `-h`). Any other argument stops the command with exit 2 and the line `episodic-memory sync: unknown option <arg>`. The check runs after the reentrancy guard and before the background worker starts. The scheduled task and the SessionStart hook pass no other option. `test/sync-cli-args.test.ts` covers the refusal, the refusal next to `--background`, and the help text.
- **The topic step writes documents again.** On 12 sessions of the live index, the step wrote 0 documents. 10 sessions gave no document. 2 sessions failed the footnote checks. The failures had two causes. The footnote rules were ambiguous. The transcript held no dates, so the model could only guess each footnote time. `numberExchanges` now takes `{ dated: true }`. The topic prompt shows the UTC date of each exchange on its user line (`[1] 2026-06-26 User: ...`). The digest prompt is unchanged. The topic rules now state one footnote label for each paragraph and the definition form `[^n]: Time: <time>; Sources: <refs>`. The rules also state that Time is the date of the cited turns. The prompt ends with one complete example block. The example uses the reserved slug `example-topic` (`EXAMPLE_SLUG`). Validation check 1 rejects a FILE block with the reserved slug. A model that copies the example therefore installs no document. A test runs the example through the real parsers and the validator. The test expects only the slug error. Two runs measured the same 12 sessions with the same model. The runs installed 6 and 5 sessions. In each run, 6 sessions gave no document. The runs rejected 0 and 1 session. The baseline installed 0. All 87 footnote times fall inside the dates of their cited exchanges. No answer copied the example date. The one rejection reused a footnote label after the retry with the error list. Topic timelines that the step wrote before this change carry times that the model guessed. The live backlog is 1,332 sessions at 3 sessions for each sync run.
- **A digest entry no longer keeps raw numeric citations such as `[2]`.** The model can write several statements on one line, each with its own mark group. `parseCitedLines` rewrote only the last group of the line, so the other groups stayed as numbers, and these numbers name no exchange after the run. 11 of 694 stored entries held such a number. 3 of the 11 were code, such as `argv[1]`. Each mark group of a kept line now gets the stable form `[#<exchangeId>]`, and its exchanges go into `sources`. A run of groups such as `[2][3]` counts, and so does a group after `(` or a quote. No word character and no `]` comes before a mark group, so `argv[1]` and `matrix[i][1]` do not change. A `(` after the group makes the group a link. `parseCitedLines` drops a line with an unknown number in any group, the same as a line with an unknown number in the last group. `parseCitedLines` therefore reads a number in brackets after a space as a mark: `the index [0]` drops the line. Two readers of the stored text read only the last mark group. Both readers now read every group. `citedExchangeIds` serves the learn filter that hides each line that cites a hidden exchange. Without the change, a line with a hidden exchange in an inner group would reach the learn solver. An unclosed `[` before a mark also hid the mark from that filter, in the old code and the new. A group now holds no `[`, so the filter reads the mark. `buildCompressPrompt` now gives a number to each mark group of a note, so the model of a day or week digest sees no raw exchange id. The stored entries do not change, because the run that wrote them kept no map from number to exchange.
- **The first test run of a fresh checkout no longer fails on Windows.** The model cache was empty, so every vitest worker downloaded the embedding model at the same time. The rename of the temporary model file failed with EPERM, and 10 tests in 11 files failed. `test/global-setup.ts` now loads the model once before the workers start. With an empty cache the suite passed in full, twice. `test/global-setup.test.ts` fails when the config drops the global setup.
- **A local test run no longer reaches a live model.** The tests inherited every `EPISODIC_MEMORY_*` variable of the machine, and `vitest.config.ts` pinned only three variables. With `EPISODIC_MEMORY_OLLAMA_FALLBACK_MODEL` set, a test of a failed Ollama call fell back to a real Claude call and failed. A second test failed the same way. Both tests passed in CI, where the variable is absent. `test/setup-env.ts` now deletes every `EPISODIC_MEMORY_*` variable that `test/test-env.ts` does not pin. `EPISODIC_MEMORY_CONFIG_DIR` points to a temporary folder, so a test that does not set its own folder cannot write to the live data. `test/test-env.test.ts` fails when a machine variable leaks through.
- **The learn agent runner no longer blocks its own event loop.** Each agent ran a synchronous PowerShell process listing every second. One listing takes 757 to 955 ms on Windows, so three concurrent agents kept the event loop blocked: 17 listings in 15 s under one live learn process. `listAgentProcesses` now awaits the listing. One tracker per PID registry now polls for all concurrent runs, and it never starts a listing while one is in flight. `EPISODIC_MEMORY_LEARN_PID_POLL_MS` sets the interval (default 1000, the old interval). A new child is unprotected for no longer than before. A run with no `pids` option lists nothing. A probe ran 3 concurrent agents with a fake query of 15 s and the real listing. The old code started 26 to 28 listings. The event loop lagged up to 5.4 s. The 15 s of work took 21.7 to 23.3 s. The new code started 16 listings. The lag stayed under 20 ms. The work took 15.5 s. A failed registry write in a listing no longer raises an unhandled rejection.
- **A finished agent no longer unprotects the children of a live one.** All concurrent runs have the learn process as parent, so each run registered the children of the other runs. A run that ended removed those PIDs from `.learn.pids` while the run that owned them was still live. The SessionStart reaper could then kill those processes. A PID now leaves the registry when a listing no longer shows it, or when the last run ends.
- **A killed learn run no longer protects dead PIDs.** A console event killed a run, and the run left `.learn.pids` behind. The reaper trusted the file. `readLearnPids` now returns nothing unless the process named in `.learn.lock` is alive. The age of the lock does not count, because one step can run past the two-hour steal age. `withLearnLock` also deletes a left-over file when it takes the lock. `isLockHeld` in `src/lockfile.ts` gives the liveness rule.
- **No change to the agent working directory.** An SDK child in `C:\Windows\System32` and an SDK child in an empty folder reached the init message in the same time (891 to 1013 ms). Three live agents in a git repository started no child process in 12 s.

### Changed
- **The exclusion-marker scan moves to `src/exclusion-marker.ts`.** The sync, the index commands, the verify command and the backfill share the one scan. `src/sync.ts` re-exports `shouldSkipConversation`, so the earlier import path still works.
- **The old prose of CLAUDE.md, docs/SCHEMA.md and MCP-TOOLS.md follows Simplified Technical English.** `repo-tools ste` reported 25 problems in `CLAUDE.md`, 6 in `docs/SCHEMA.md` and 4 in `skills/remembering-conversations/MCP-TOOLS.md`. The problems were long sentences, unclear references and one passive sentence. The rewrite keeps every fact, and the checker now reports 0 problems in the three files. Two paragraphs also became more exact. The `digest` section of `CLAUDE.md` now names the `digest` tool as its subject. The grounding rule now says that the knowledge gate rejects an entry with no grounded line.
- **Each duplicated function now exists once.** `repo-tools clones` found 3 groups of identical functions and 2 more near copies. The new `src/content-text.ts` holds `extractContentText` and `safeParseJson`. These functions replace the copies in `parser.ts` and `show.ts`. The indexed text and the text of the `read` tool therefore come from the same code. The new `src/learn/prng.ts` holds `mulberry32`. This function replaces the copies in `tasks.ts` and `validate.ts`. The new `src/learn/entry-order.ts` holds the two sort orders of learned entries. These orders replace four local copies in `cli-main.ts`, `export.ts`, `knowledge-db.ts` and `learned-block.ts`. `cli/forward-child.js` has the new `runChild`, which replaces the `runScript` copies of `cli/episodic-memory.js` and `cli/index-conversations.js`. Each new module imports nothing. Golden-value and order tests pin the behaviour. A mutation audit broke each shared body once, and the suite caught all 7 changes.
- **A plugin host no longer keeps the `onnxruntime-node` bindings of other platforms.** `onnxruntime-node` ships one binding directory for each platform and architecture pair under `bin/napi-v6/`. The process loads only the directory of `process.platform` and `process.arch`. `ensureDeps` in `cli/ensure-deps.js` now calls the new function `pruneOptionalWeight` on every call, also for a healthy tree. The function removes each pair except the running pair, then each empty platform directory. The function removes nothing when the binding file of the running pair is not on disk. The function skips files. The removal is best effort. `fs.rmSync` retries 5 times at 200 ms. A failure writes one stderr line and stops the prune. A directory that a concurrent call removed first ends the prune without a line. The prune never throws and never changes the return value of `ensureDeps`. `npm install` and `bun install` keep the pruned tree while the installed version satisfies the manifest. To restore the directories, delete `node_modules/onnxruntime-node` and install again. Both installers then restore all five pairs, and the next call prunes the directories again. On Windows x64 at the `bun.lock` versions (`onnxruntime-node` 1.24.3), one call removed 158.1 MB (158,113,768 bytes), the plan figure. On an npm plugin host with no lockfile (`onnxruntime-node` 1.30.0), the call removed 233.9 MB. A second call took at most 1.3 ms and removed nothing. In both pruned trees, `doctor` reports `node_modules: healthy`. The vector search over the fixture index gives the same output as before the prune, with the known passage as hit 1 (65%). The new `test/ensure-deps-prune.test.ts` (12 tests) covers the prune, the second call, an absent binding file, a concurrent call, a locked target and the `ensureDeps` call. Each of ten mutants fails at least one test. This change is step 4 of `docs/roadmap/dependency-minimization.md`.
- **A plugin host no longer installs `onnxruntime-web`.** The node build of `@huggingface/transformers` imports `onnxruntime-node` and `onnxruntime-common`, and never imports `onnxruntime-web`. The transformers package still lists `onnxruntime-web` as a dependency, so every install fetched `onnxruntime-web`. The `overrides` field of `package.json` now replaces `onnxruntime-web` with `vendor/onnxruntime-web-stub`, a private package inside the repo. The stub has no dependencies, and its main file throws `onnxruntime-web is stubbed out; the node build does not use it`. A later transformers release that imports `onnxruntime-web` therefore fails the embedding tests at once. The change publishes no package. npm 11.20 links `node_modules/onnxruntime-web` to the stub. bun 1.4.2 writes the stub into `bun.lock` and installs no `onnxruntime-web` directory. The saving is 18 packages. At the `bun.lock` versions the 18 removed entries are 140.7 MB in the bun install cache. A plugin host installs with npm and no lockfile, and resolves `onnxruntime-web` 1.31.0-dev (145.5 MB). On that host, two fresh npm trees differ by 151.9 MB, and `npm ls` lists 135 packages instead of 152. The after tree loads transformers. A vector search over the fixture index that the before tree built returns the known passage as hit 1 (65%). All 39 vectors have 384 dimensions, and `doctor` exits 0. With `onnxruntime-web` gone, no package reaches `protobufjs`, so the change removes the `protobufjs` override and the `protobufjs` entry of `allowScripts`. `@types/node` also leaves the plugin tree, because only `protobufjs` listed `@types/node` as a dependency. The new `test/onnxruntime-web-stub.test.ts` checks the override, the stub, the lockfile, and that the node build of transformers imports `onnxruntime-node` and not `onnxruntime-web`. This change is step 3 of `docs/roadmap/dependency-minimization.md`.
- **The plugin denies two install scripts that it does not need.** The `allowScripts` field of `package.json` now holds `"onnxruntime-node": false` and `"protobufjs": false`. npm 11.20 skips a denied script. npm 11.20 runs an unlisted script with a notice. A probe package measured both behaviors. The `onnxruntime-node` postinstall installs nothing on win32 and darwin. On linux/x64 it downloads the CUDA 12 provider files, a NuGet package of 236 MB for 1.30.0. The plugin runs the model on the CPU only. The `protobufjs` postinstall only prints a version-scheme warning. A linux/x64 plugin host on npm 11 therefore skips a 236 MB download that the host never uses. npm 10 and older ignore `allowScripts`. The linux saving comes from the script source and the NuGet size. No measurement includes a linux host install.
- **A plugin host no longer installs the build and test tools.** The first-run install in `cli/ensure-deps.js` now passes `--omit=dev`. As a result, vitest, vite, typescript, esbuild and `@types/better-sqlite3` stay out of the plugin cache. A fresh Windows x64 install drops from 1,019.6 MB to 932.1 MB (87.5 MB). The package count drops from 202 to 153. Every package that both trees hold has the same version. The saving is above the 66 MB that the plan estimated, because vite 8 under vitest brings two native binaries. The plan did not list the binaries: `@rolldown/binding-win32-x64-msvc` (23.2 MB) and `lightningcss-win32-x64-msvc` (9.5 MB). `@types/node` stays, because `protobufjs` under `onnxruntime-web` depends on `@types/node`. The `onnxruntime-web` stub entry above removes both. The optional platform packages stay. The new `test/runtime-imports.test.ts` reads every `.js`, `.mjs` and `.cjs` file under `dist/` and in `cli/`, and the postinstall script. The test fails when one of these files imports a package that is not a dependency or a Node built-in. A planted `typescript` import made the test fail. A repo checkout keeps its devDependencies, unless the wrapper repairs the checkout with npm. After the wrapper repairs a broken checkout with npm, run `bun install`. This change is step 2 of `docs/roadmap/dependency-minimization.md`.
- **Two unused devDependencies are gone. The `sqlite-vec` range names a release.** No file uses `tsx`. `marked` 16 ships its own types. The change removes `tsx` and `@types/marked`. `bun.lock` loses 29 entries: `tsx`, the `esbuild` 0.28 copy that only `tsx` uses, the 25 platform packages of that copy, and `@types/marked`. The `sqlite-vec` range moves from `^0.1.7-alpha.2` to `^0.1.9`, the installed version. The old range set only a prerelease floor. A comment in `src/deps-health.ts` said that `test/mcp-protocol.test.ts` checks the first stderr line. The test checks that stderr contains the ready line. The comment now states the ready-line check. This change is step 1 of `docs/roadmap/dependency-minimization.md`.
- **The roadmap docs name roles, not people.** `docs/roadmap/` and its focus areas used a personal first name for the maintainer and the user in 31 places. Each one now says "the maintainer", "the user" or "the fork". The soft-fork option in `upstream-sync.md` suggests `episodic-memory-fork` as the package name. The upstream author lines in the plugin manifests and `LICENSE` stay unchanged, because they are attribution. The four sentences that held a name are split, and `repo-tools ste docs/roadmap` reports 43 problems instead of 48, with none added.
- **Tracker and contributor docs match the repo again.** `CLAUDE.md` and `todo.md` said "direct push" to `main`; `main` requires the CI `build` check, so they now say branch and pull request. The local path is `~/Github/episodic-memory`, not `~/Dropbox/Github/episodic-memory`. `todo.md` closes the shipped rows with evidence: topic Tasks 6-7, the combined digest, the fork install, the eol fix and upstream #95. It also adds the open work that an audit found.

## [1.8.0] - 2026-11-12

### Added
- **`topics` MCP tool, read-only.** It lists the topic documents of a project, reads one, searches their paragraphs, shows the links and backlinks of one paragraph, or lists the dated events. The tool opens the index read-only and creates no file on a fresh install. It answers "no documents yet" until the topic tables exist, because the server never sees `EPISODIC_MEMORY_TOPICS`. A timeline returns at most `limit` events (default 50) and says how many it left out. An unknown unit gets its own message. The tool loads on its first call only: the schema module imports the import-free `src/topic-time.ts`, and the bundle keeps `topic-tool.js` outside the server.

- **Topic memory core (not wired into sync or the MCP server yet).** `src/topic-format.ts` parses and writes topic documents: fenced code is kept verbatim, every footnote reference is kept, malformed `.md` links are listed, and `isValidTime` and `footnoteStatements` are shared. `src/topic-validate.ts` runs checks 1 to 11. A label must be referenced exactly once, a bare mark always fails, and links resolve by unit id. `src/topic-db.ts` installs an edit in one transaction. It throws on a source that is not a `#<exchange id>`, and refuses a range bound that is not a valid time.

- **Topic prompt and answer handling (`src/topic-prompts.ts`).** `buildTopicPrompt` shows the most recently updated documents that fit, and drops the oldest until the prompt fits the budget. `parseTopicAnswer` reads `=== FILE` / `=== DELETE` blocks, treats `===` lines inside a fenced block as text, and reports an unterminated block. `prepareTopicEdit` rewrites marks to exchange ids, redacts secrets outside link targets, assigns new ids, and points each link at the document that now holds its paragraph. A block with a malformed definition keeps the model's text, so validation quotes it.

- **Topic organize job, off by default (`EPISODIC_MEMORY_TOPICS=1`).** `sync` runs `runTopicPhase()` after the digest. The job takes finished sessions oldest first, asks the model for an edit, retries once with the error list, validates and installs it. The prompt always fits `promptBudgetChars()`: it drops shown documents, then shortens the transcript; a session that no prompt can hold is skipped and retried later. A failed call or an edit fault leaves the session pending; the third failure rejects it. The prompt asks for `NOTHING` when the session adds nothing, because Ollama refuses an empty reply.

### Fixed
- **Two load-dependent test failures.** A learn test sent its recall answers to the real learn model, because it gave no fake judge, and stalled to its 30 s timeout under load. The digest hook timing test counted the Node start. Now the learn test passes a fake judge, and the hook test holds the hook's own work to 1000 ms.
- **The digest session prompt was cut silently on Ollama.** The digest built prompts up to 48000 characters and `callOllama` sent the first 24000. The prompt is now built within `promptBudgetChars()`, and `numberExchanges` counts the blank lines between exchanges, so the cap is exact. `ollamaMaxPromptChars()` is the one reader of `EPISODIC_MEMORY_OLLAMA_MAX_PROMPT_CHARS`.
- **Secret redaction ate the next line after a bare `Bearer`.** The bearer rule matched `\s+`, so `Bearer` at the end of a line took the first word of the next line as its value. It now matches spaces and tabs only. This also applies to digest text.

### Changed
- **Docs for topic memory.** README, `docs/SCHEMA.md`, `skills/remembering-conversations/MCP-TOOLS.md`, `CLAUDE.md` and `docs/architecture/` describe the organize step, its settings, the topic tables and the `topics` tool. `CLAUDE.md` now lists the modules that the server loads at start and in each tool branch, from the import graph, and says that the bundle inlines all but `skills-tool.js` and `topic-tool.js`. The architecture docs now say that a sync run waits for the digest step and the topic step. Stale paths, counts and dates are removed.
- **One FTS query builder.** `src/fts-query.ts` holds `toFtsQuery`, which the digest store and the topic store both use.

## [1.7.5] - 2026-11-12

### Added
- **`EPISODIC_MEMORY_OLLAMA_FALLBACK_MODEL`: a Claude retry model for a failed Ollama call.** Set it to `haiku` (for example) and a summary, digest or text-only learning call that fails on Ollama runs once on that model. Unset, the behaviour is unchanged. A `GpuReservedError` is never retried, so a reservation still defers the work.

### Fixed
- **A Windows build no longer marks every `dist/` file modified.** `.gitattributes` checks every text file out as LF and `tsconfig.json` sets `newLine: lf`. Before, `core.autocrlf=true` checked `src/` out as CRLF, `tsc` copied the CRs inside multi-line strings into `dist/`, and each build showed about 25 changed `dist/` files with no real change.

## [1.7.4] - 2026-11-12

### Fixed

- **The digest wrote nothing on the Ollama backend.** `callOllama` refused every reply without a `<summary>` block, and the digest and learn prompts never ask for a `<summary>` block. Every digest call failed with "Ollama reply has no <summary></summary> block"; the live digest wrote no entry after 2026-10-19. `callOllama` takes `requireSummaryBlock` (default true). `callDigestModel` and `callLearnModel` pass false. Their own parsers check the reply.
- **The committed bundle did not match the lockfile.** `dist/mcp-server.js` was built with an older `zod` than the locked 4.6.7, so the plugin ran code that the lockfile does not describe. The bundle is rebuilt. CI now fails when the committed `dist/` differs from a build of the same commit, so a dependency bump merged without a rebuild turns red.
- **The test suite read the machine's `EPISODIC_MEMORY_OLLAMA_MODEL`.** A machine that sets it failed the `callLearnModel` routing test. `vitest.config.ts` now pins `EPISODIC_MEMORY_OLLAMA_MODEL` to blank, as the file pins the backend and the URL.

## [1.7.3] - 2026-11-06

### Added
- **CI runs both doc gates.** After the build, `ci.yml` installs `repo-tools` (pinned to 2.3.0) and runs `repo-tools check . --docs=docs/architecture` and `repo-tools docs check .`. A change that moves a recorded count or leaves an exported symbol undocumented now fails the job.

### Fixed
- **Six `KnowledgeStore` write methods run under the write lock.** `supersede`, `addHeuristic`, `putProcedure`, `proposeDecision`, `recordFailure` and `recordReflectionRecord` now go through `write`, like every other write. `test/learn/knowledge-store-write-lock.test.ts` fails on the old code.
- **`pruneProjects` works on a database that has no `exchanges_fts` table.** The function used to prepare the FTS delete before its guard, so a missing table threw before any row was deleted. It now checks `sqlite_master` first and skips that delete.
- **The package holds no GPU reservation path.** `reservationPath()` returns the value of `FLEET_GPU_RESERVATION` or `null`. The built-in `~/Dropbox/_fleet/gpu-reserved.json` default is gone, so an unset variable means the GPU is free. A deployment that shares a GPU sets the variable.
- **`CLAUDE.md` names the right SessionStart hook.** `hooks/hooks.json` runs `cli/sync-hook.js`, which spawns `sync --background`; the file said the hook ran the dispatcher directly.

### Changed
- **Comments describe the design, not the history.** The dated incident notes in `deps-health.ts`, `sync.ts` and `cli/sync-hook.js` are rewritten as standing reasons. The remaining style findings in doc comments (sentence length, voice, ambiguous pronouns, missing full stops) are fixed, so `repo-tools docs check .` reports no SHOULD issues.

## [1.7.2] - 2026-11-06

### Added
- **Architecture documentation in `docs/architecture/`.** Six written documents (`OVERVIEW`, `ARCHITECTURE`, `COMPONENTS`, `DATAFLOW`, `API` and `LEARN`, which describes the `src/learn/` feature module by module) and the reports that `repo-tools map` generates (`FILE_INVENTORY`, `TEST_COVERAGE`, `DEPENDENCY_GRAPH`, `unused-analysis`, `duplicate-symbols`, plus their JSON data). The README links all of them. `repo-tools check . --docs=docs/architecture` passes (22 claims in 6 documents), and `repo-tools ste docs/architecture` reports 0 problems. The documents state that the map reports 14 files as orphaned and 52 as dormant because the `cli/` shims import from `dist/` and the command files run as separate processes.
- **Doc comments on every exported symbol.** All 431 exported symbols in `src/` now carry a doc comment written in Simplified Technical English, and `repo-tools docs check .` passes with 0 MUST issues. The coverage report is `docs/code-docs/COVERAGE.md`. The change touches comments only; `dist/` is rebuilt to match.
- **The README follows Simplified Technical English.** `repo-tools ste README.md` reports 0 problems. The signed Testimonial stays word for word, set as a block quote.
- **`learn render [--project P]` is implemented.** It rewrites the learned-hints block the SessionStart hook injects from the entries that are active now and lists each block's size; `--project P` prints that project's block. Every run and approval already renders, so the command is for a store edited by hand and for seeing what a session will be shown. The "not implemented" stub and its exit code are gone.

### Removed
- **`@danielsimonjr/memoryjs` is no longer a dependency.** `package.json`, `bun.lock` and the esbuild externals drop it; the plugin install is about 30 packages lighter. With it go the parts of the fork that existed only to police it: the nested-`better-sqlite3` sentinel in `deps-health`, the "memoryjs resolves a different better-sqlite3" doctor warning (the learn section now prints the one resolved path), and the `overrides` pin on `better-sqlite3`, which nothing else pulls in. The Node floor is now the one `better-sqlite3` 13 declares, `>=22.0.0`, enforced at launch as before.

### Changed
- **The knowledge store no longer depends on `@danielsimonjr/memoryjs`.** `src/learn/knowledge-store.ts` now talks to `better-sqlite3` directly, keeping the `entities` / `relations` layout memoryjs created so an existing `learned/knowledge.db` opens unchanged. Learned entries, citations, heuristics, procedures, decisions, failures, reflections and project context keep their public API; the memoryjs-specific knobs (`storageConstructorName`, `semanticSearchIsNull`, the `MEMORY_*` environment scoping) are gone because there is nothing left to scope. Reads go straight to the database, so a write through one handle is visible to every other open handle at once instead of to handles opened afterwards only. Search is a deterministic term-overlap ranking rather than TF-IDF, so a store with one or two entries still answers. PII redaction lives in `src/learn/pii-redactor.ts` with the same five shapes (email, SSN, card, phone, IPv4). The MCP protocol test now proves the lazy-load guarantee against `./learn/skills-tool.js`, the module the flag-on `skills` call imports.

### Fixed
- **`test/digest-hook.test.ts` resolves the repository root with `fileURLToPath`.** `URL.pathname` gave `\C:\...` on Windows, so three tests of the built hook module graph failed there although the built files existed.
- **The plugin manifest passes every runtime setting through to the MCP server.** `.mcp.json` now whitelists `EPISODIC_MEMORY_MCP_TOKEN`, `EPISODIC_MEMORY_REDACT_SECRETS`, `EPISODIC_MEMORY_MAX_READ_BYTES`, `EPISODIC_MEMORY_DIGEST_MAX_CHARS`, `EPISODIC_MEMORY_INCLUDE_SUMMARY` and `EPISODIC_MEMORY_MAX_SUMMARY_DISPLAY_CHARS`. Before, a plugin-launched server never saw them, so `auth_token` could not be required, `read` redaction and its size cap could not be set, and the digest budget was always the default. The `read` tool's description and schema now say the path is a search result's `archive_path`, and the top-level `--help` lists `learn render`.
- **`getApiEnv`'s unsafe-URL test clears `ANTHROPIC_BASE_URL`.** The function spreads `process.env`, so a host that exports that variable (cloud sessions, some CI runners) made the test fail with the code behaving correctly.
- **A merge whose check dies on the call budget is not activated, and instruction conflicts are resolved against the live lines.** `mergeRound` retires the unvalidated merged version and stops with status `stopped`, keeping the children's validated entries. A merge that stands is activated with the merge-check record, never with `validation: null`. Heuristic conflicts are mapped onto the active or newly merged instruction, not onto a superseded child row; a pair the model cannot resolve is retired and named on the run. A round that keeps nothing does not re-solve the whole train set, a leaf that stops on budget still reports the entries it already kept, and the reflection's after-count includes the leaf's validation passes.
- **Bootstrap keep requires the same graded task count on both sides.** `bootstrapGain` refuses a candidate when the after side graded a different number of signal tasks than the baseline, so an aborted solve that only graded the easy tasks cannot activate a skill. A baseline precheck that stops the run is listed on `BootstrapResult.rejected`. A failed merge or reflection text call is recorded as a rejection instead of leaving the run looking complete with that step missing. The reflection prompt cites each attempt's real task kind and omits archive paths.
- **`learn --help` no longer loads the Agent SDK or memoryjs, and a solve that spends past its call budget stops instead of crashing.** Help is printed from `src/learn/usage.ts` before `cli-main` is imported. When `solve` hits `BudgetExhausted` — the signal-task baseline can be smaller than the split actually solved — the run is marked `stopped`, the attempts already stored are kept, and the process exits 0 with a budget message on stderr. A still-running run that owns the tasks being solved is the run that gets that status.
- **The learning subprocess semaphore counts every overlapping body, and an in-flight limiter stays put when concurrency changes.** An awaited nested `run` still shares the caller's slot. A nested `run` that is not awaited takes its own, so a fire-and-forget call cannot slip past the limit. `globalAgentSemaphore()` keeps the live limiter while slots are held. Building the in-process tool server throws if the registered tools drift from `SERVED_TOOL_NAMES` (plus `propose_entry` only when it is enabled), so the `allowedTools` wildcard cannot hide a new tool.
- **Learned-block injection stays inside the fence, re-redacts PII, and drops retired projects.** The hook stops at the closing fence, re-applies a memoryjs-free PII pass (phone, email, SSN, card, IP) on read, and `writeLearnedBlocks` deletes a project row whose render is empty. Flag-off `skills` checks `learnEnabled()` before importing `skills-tool`, so memoryjs stays unloaded. `skills get` only returns the requested project or a `*` skill.
- **A candidate knowledge revision no longer hides the still-active previous version.** `putEntry` no longer clears the parent's `isLatest`; only `supersede` does. `listActive` and snapshots are gated on status and `supersededBy`. `getBySlug` returns the highest logical version. Reflection `generalization_confidence` uses 0.3 / 0.6 / 0.9.

### Added
- **Self-improving memory: `learn`, the `skills` tool, and the learned-hints block (Tasks 0–11 of the
  Recursa plan, including the `@danielsimonjr/memoryjs` knowledge-store dependency).** Off by default behind `EPISODIC_MEMORY_LEARN=1`; with the flag off, hook stdout is
  byte-identical to the digest-only output, `/mcp` still lists four tools, and nothing opens a store.
  On, the archive becomes a source of self-practice: `learn tasks` writes `locate`, `recall`, `when` and
  `multi` questions at three tiers from deterministically sampled exchanges, stratified 60/40 into a
  `train` split and a held-out `test` split that no learner prompt can read; `learn solve` grades answers
  against the archive address and date range; `learn bootstrap` maps each eligible project and measures
  navigation skills before keeping them; `learn improve` runs the recursive learner — solve, split
  failures into leaves, propose and validate edits, merge duplicates across leaves, reflect, then evaluate
  `test` once at the end; `learn report` prints pass rates per split and tier before and after, kept and
  pending entries, rejections with the gate that produced them, calls and USD spent, child runs and
  reflections. `learn approve` shows a candidate instruction, its validation record and a diff against the
  version it revises before activating it, and refuses one with no measurement or a recorded regression.
  `learn export` writes the active skills as a `SKILL.md` tree. Every stored entry is grounded in cited
  exchanges, redacted for secrets and PII, and screened for injected instructions before storage and again
  on every read, export and hook render; learned text is data, never instructions. Knowledge lives in
  `learned/` beside `conversation-index/`, so an index rebuild or reset leaves it alone. The `skills` MCP
  tool lists, searches and loads active skills for the current project. A new "Learn (Recursa)" section in
  `doctor` covers entries by kind and status, the latest run, candidates awaiting approval, unresolved
  sources, and whether `memoryjs` resolves the same `better-sqlite3` copy as the top level. The entries
  below describe the pieces in the order they landed.
- **`learn bootstrap`: navigation skills and exploration notes from the archive (Task 7 of the Recursa
  plan).** One bootstrapper subprocess per project with at least 20 indexed exchanges — bounded by the
  global subprocess semaphore and by `EPISODIC_MEMORY_LEARN_CONCURRENCY` — reads the digest and samples
  the whole time span, then proposes a `navigation` skill and an `exploration-notes` skill. Every
  proposal passes the citation, redaction and injection gates; a rejected one is recorded on the run
  with its reason (including `duplicate`) and nothing is retried or repaired. The two bootstrap skills'
  cited lines are mirrored into the project context, which feeds learner prompts only and is never
  rendered into a session, and a procedure skill's steps become a `proc:` record. One text call then
  merges the candidates into a single global instruction in the template grammar, each of whose lines
  is also a heuristic. Before anything is kept, the run generates self-practice tasks when the archive
  has none, marks stale ones, and solves the signal train set twice — an empty snapshot, then the
  candidates — so the keep decision is the paper's Figure 4 rule: keep when the signal pass rate does
  not fall and mean turns or USD per task fall by at least `EPISODIC_MEMORY_LEARN_MIN_SAVING`. Skills
  that pass activate; the instruction stays a candidate for `learn approve` unless the approval mode is
  `none`. The run closes with one gated reflection citing attempt ids, `finishRun` metrics per kind and
  tier, and a re-render of the learned block. A spend cap stops the run (`stopped`) and keeps
  everything already validated.
- **The `learn` CLI: `tasks`, `solve`, `status` and `report` (Task 6 of the Recursa plan).**
  `episodic-memory learn` now dispatches to `dist/learn-cli.js`, which checks the reentrancy guard,
  the flag and the fleet GPU reservation — and drops to below-normal priority — before it imports the
  SDK, memoryjs or transformers, so a guarded or flag-off invocation costs nothing. `learn tasks`
  generates self-practice tasks (`--per-project`, `--seed`), and `learn tasks --check` marks the tasks
  whose source address no longer resolves as stale. `learn solve` solves a split, storing one graded
  attempt per task, and every command that spends money computes its signal-task baseline first and
  refuses to start when that alone exceeds `EPISODIC_MEMORY_LEARN_MAX_CALLS` (twice the count for
  bootstrap, which solves the same set before and after). `learn status` prints the flag, entries by
  kind and status, the candidates awaiting approval and the latest run. `learn report` prints pass
  rates per split and tier before and after, the entries a run kept, the candidates still pending,
  every rejection with its reason, the budget spent, child runs and reflections — `--json` for the
  same model as JSON, and it defaults to the latest run. `bootstrap`, `improve`, `approve`, `export`
  and `render` are stubs with a distinct not-implemented exit code (Tasks 7 to 10 fill them).
  One run at a time is enforced by `.learn.lock` in the index directory (`learn-lock.ts`), and a
  second instance reports the holder's PID instead of a bare failure; `.learn.pids` lists the
  subprocesses a run owns, so the SessionStart orphan reaper never kills a live run's workers.
  `selectOrphans` gains a `protectedPids` argument for exactly that, `cli/sync-hook.js` reads the run's
  registry at reap time, and `EPISODIC_MEMORY_PROC_LISTER` makes the hook's process enumeration
  testable. Progress goes to stderr and to `logs/learn.log`; the report goes to stdout. The
  learning trace gains `learning_run`, `learning_task` and `learning_attempt`, and three new modules
  make the archive grade itself. `src/learn/tasks.ts` selects source exchanges deterministically from
  a seed (sidechains and projects below the floor excluded), asks a text-only model for a `locate`,
  `recall`, `when` and `multi` prompt at tiers 1 to 3 per exchange, redacts and screens every prompt,
  splits 60/40 inside each `(project, tier)` stratum, and stores truth as an address plus the
  session's date range. A paraphrase that echoes an archive path or a session id is dropped, so the
  answer key never lands in the stored prompt. `src/learn/grade.ts` grades an answer deterministically for `locate`
  (1.0 overlap, 0.5 same session, 0 otherwise), `when` (project plus date inside the session range
  widened one day each side) and `multi` (every address), and gates `recall` on the location before a
  judge score. Answer parsing accepts a numbered-list prefix (`1. path:`), and `samePath` folds `..`
  in Windows-shaped paths the way `path.win32.normalize` does. `listTasks` is the only task read path and its `split` argument is mandatory, so the
  held-out split cannot reach a learner prompt; `passRate({ signalOnly })` restricts to
  `locate`/`when`/`multi` at tiers 2 and 3, so tier 1 and `recall` are reported but never decide
  whether an edit is kept. Also: `callLearnModel` and `resolveLearnModels` in `summarizer.ts` give
  learn calls their own model (`EPISODIC_MEMORY_LEARN_MODEL`, default `sonnet`) without moving the
  digest model, and `callClaude`'s fallback notice now goes to stderr instead of corrupting
  JSON-RPC stdout.
- **`@danielsimonjr/memoryjs` as a runtime dependency, for the `learn` knowledge store (Task 0 of the
  Recursa plan; no learning code yet).** The package is marked external in the esbuild bundle beside
  `better-sqlite3`, and its `package.json` joins the wrapper's dependency sentinels so a plugin-cache
  install that skipped it is repaired instead of failing at an import. Its floor raises the fork's
  supported runtime: `engines.node` becomes `>=22.12.0`, CI's Bun becomes `1.4.2`, and the `zod` range
  becomes `^4.6.6` so one copy resolves. `engines` is advisory, so `src/node-floor.ts` holds the floor
  and `cli/mcp-server-wrapper.js` and `cli/episodic-memory.js learn` exit with one stderr line below it.
  `overrides["better-sqlite3"]` pins the exact version so npm in the plugin cache collapses memoryjs's
  caret range into the single installed copy; a second, nested copy under memoryjs makes `repairPlan`
  answer `install`. The engine-floor divergence from upstream is recorded in
  `docs/roadmap/upstream-sync.md`.

### Changed
- **Docs only.** Recursa spec and implementation plan hardened after an adversarial
  review against `@danielsimonjr/memoryjs@4.5.0` types and this repo's hook/lock/MCP
  contracts: async adapter surfaces, trust stored on observations (core `Entity` has
  no `source`), hook import graph stays memoryjs-free, flag-off byte identity and
  no-migrate readonly opens, spawn-tree PID protection, priority marker sequencing,
  and missing Review Focus tests named on Tasks 0–11. No runtime code.

## [1.7.1] - 2026-10-26

### Fixed
- **The bundled `claude` binary of the summarizer deleted the session record of a live, elevated
  Claude Code session.** `@anthropic-ai/claude-agent-sdk` 0.2.x ships a `claude` binary of version
  2.1.141. When that binary starts at Medium integrity, it removes the session record
  (`~/.claude/sessions/<pid>.json`) of a running session that has High integrity. The session keeps
  running, but session-record tools no longer see it. The same start at High integrity does not do
  this, and a Medium start of binary 2.1.299 does not. The range `^0.2.126` could never leave 0.2.141,
  which is the last 0.2.x release. The dependency is now `^0.3.299`, whose bundled binary is 2.1.299
  (byte-identical to the installed CLI of that version). The 0.3 line moves `@anthropic-ai/sdk`,
  `@modelcontextprotocol/sdk` and `zod` to peer dependencies; all three are already present. A new
  test keeps the lower bound of the range at or above 0.3.299. The summarizer options (`persistSession`,
  `settingSources`, `mcpServers`, `systemPrompt`, `abortController`) are unchanged and exist in the
  0.3 types; a live summary through the new SDK returns normally.
- **The ollama summarizer backend put a model on the shared GPU while another agent held a GPU
  reservation.** The SessionStart hook runs a sync at every start, resume, clear and compaction.
  With the ollama backend, each sync called the configured model, and nothing read the fleet GPU
  reservation file. Measured on 2026-10-26: three syncs sent 28 calls to a GPU that a benchmark held,
  and the benchmark decode speed fell from 10.5 to about 6.5 tokens per second. The backend now
  reads the reservation file (`~/Dropbox/_fleet/gpu-reserved.json`, or `FLEET_GPU_RESERVATION`). While
  the file names a holder, the hook skips the sync, the sync asks for no summary, the archive
  backfill pauses, the digest writes nothing, and `callOllama` throws `GpuReservedError` before it
  sends a request. A reservation that appears during a run stops that run at once. The attempt is not
  counted, no failure marker is written, the digest and backfill report a wait and not a failure, and
  no partial summary of a long conversation is stored. A missing file means the GPU is free. A file
  that cannot be read, is not valid JSON, or holds the text `null` means the GPU is reserved, and the
  message names the cause and the path of the file. The Claude backend does not use the GPU and
  ignores the file. The test configuration pins the Claude backend and a closed model URL, so a test
  run sends no request to a shared GPU.

## [1.7.0] - 2026-10-08

### Added
- **Session digest (off by default).** A cited, size-bounded digest of earlier sessions loads at session start.
  New table `digest_entry` (with an FTS mirror), a `digest` MCP tool (show, search, expand a source, leave a
  handoff note), a second SessionStart hook (`cli/digest-hook.js`), and a digest step after each sync that
  writes session entries and merges busy days and finished weeks. Enable with `EPISODIC_MEMORY_DIGEST=1`.
  Settings and behavior are in the README ("Session Digest") and `docs/SCHEMA.md`.

### Security
- **CI `bun audit --audit-level=critical` failed on three new critical advisories.** `proxy-addr` 2.0.7
  (reached through `claude-agent-sdk` > MCP sdk > `express`) is raised to a fixed version by
  `bun audit fix` inside its range. `tinypool` 1.1.1 (reached through `vitest` 3) has no fix inside vitest 3,
  so `vitest` moves to `^4.1.11`, which also clears the `@vitest/mocker` advisory. Both are dev or transitive
  dependencies; shipped code is unchanged. Typecheck passes, 72 test files and 355 tests pass, and the audit
  reports no critical findings. Three moderate advisories remain (`sprintf-js`, with no published fix).

## [1.6.5] - 2026-09-23

### Fixed
- **`scripts/rebuild-native.mjs`'s health check only detected a MISSING better-sqlite3, not one
  that is present and broken.** `loads(pkg)` called plain `require(pkg)`, which resolves the JS
  wrapper without ever touching the native binding - better-sqlite3 compiles it lazily, inside the
  `Database` constructor. An ABI-mismatched addon (Node upgraded since install) or one that fails
  at lazy load therefore read as "loads" and the postinstall rebuild never ran, exactly the failure
  this script exists to catch (see the file's own header on why it tests the load rather than a
  file path). `loads()` now opens a `:memory:` database and runs `SELECT 1` before declaring
  success, mirroring the fix already shipped in `@danielsimonjr/memoryjs`'s copy of this script.
  Proven with a `Module._load` stub that returns a `Database` class whose constructor throws until
  a fake rebuild runs: the OLD `loads()` reported "loads" against that stub and exited 0 having
  detected nothing; the fixed version reports the failure, rebuilds, and verifies the reload
  (`test/rebuild-native.test.ts`). Suite: 72 files / 355 tests, all passing.

- **The CHANGELOG had two `[Unreleased]` headings.** The second one, below 1.5.1, held the #6
  security and doctor entries that shipped in 1.5.2 (first tag containing the merge). They now sit in
  the 1.5.2 section under "Also shipped in 1.5.2".

## [1.6.4] - 2026-09-20

### Fixed
- **Version bump so the `deps-health` fix can actually DEPLOY.** 1.6.3 was published to the plugin
  cache before the `deps-health` prebuilds fix landed, and a plugin is served from a per-version
  cache directory: the version is IN the path, so `plugin update` has nothing to do while the
  version is unchanged, and the deployed copy keeps the old code indefinitely. The cache copy of
  1.6.3 was still running the v12-shaped `build/Release/...` check and was only behaving because a
  manual `npm install` had happened to leave a legacy binding beside it - working by accident, and a
  clean deploy would have broken it.
- No source change beyond the version carriers; this releases 1.6.3's fixes rather than adding to
  them. Suite 71 files / 354 tests, all passing.

## [1.6.3] - 2026-09-20

### Fixed
- **`sync` aborted with SIGABRT (exit 134) on Node 24 - better-sqlite3 raised to `^13.0.3`.**
  The captured stderr is the whole diagnosis:
  `node::RemoveEnvironmentCleanupHook ... Assertion failed: (env) != nullptr` at `hooks.cc:142`,
  with frame 3 being better-sqlite3's `Statement::scalar deleting destructor`. better-sqlite3
  12.11.1 destroys `Statement` objects AFTER Node tears the environment down; Node 24.19.0
  (`modules=137`) asserts on that where older Node tolerated it. The addon is NOT corrupt and
  NOT built against the wrong Node - it loads cleanly on its own, which is exactly what made this
  look intermittent and sent two earlier fixes at the wrong target: a structural "does the binding
  load" gate passes, and a retry wrapper treats a deterministic teardown bug as a flake. It is not
  a flake; one run failed both the attempt and the retry.
  Verified by running `sync` to completion at exit 0 where it had aborted within seconds.
- **`allowScripts` is version-keyed and had to move with the bump** (`better-sqlite3@12.11.1` ->
  `better-sqlite3@13.0.3`). Leaving that key behind blocks the native build for the new version
  while the manifest still reads as upgraded - a silent half-upgrade.

### Fixed (dependency pin)
- **`better-sqlite3` is pinned EXACTLY, `13.0.3`, not `^13.0.3`.** `test/allow-scripts-pin.test.ts`
  requires an exact version because plugin installs go through npm and `allowScripts` is
  version-keyed: a range lets npm resolve a version the key does not cover, and the native build is
  then silently skipped. The original pin was exactly `12.11.1`; the v13 bump wrote a caret and
  broke the invariant.
- **Why three local runs missed it:** `bun add better-sqlite3@13.0.3` writes an EXACT version into
  `package.json`, so every local suite ran against an exact pin and passed 354/354, while a later
  `git checkout -- package.json` restored the committed caret before the push. The tree that was
  tested was never the tree that was pushed - the same failure shape as running a doc gate before
  the final edit.

### Fixed (the regression the v13 bump caused, and its root cause)
- **`deps-health` reported a healthy better-sqlite3 13 tree as "binding missing", so the MCP server
  shelled out to `npm rebuild` on EVERY start.** `NATIVE_ADDON` was the single path
  `better-sqlite3/build/Release/better_sqlite3.node`, which is the v12 layout. v13 ships
  `prebuilds/<platform>-<arch>.node` and never creates `build/Release/`, so `repairPlan()` answered
  `'rebuild'` unconditionally, `ensureDeps()` printed "Building the better-sqlite3 native binding..."
  to stderr, and `test/mcp-protocol.test.ts` failed because it asserts on the server's first stderr
  line. The symptom was three layers from the cause and nothing in it pointed at a path constant.
- `nativeAddonPresent()` now accepts EITHER layout. This module is deliberately fs/path-only so it
  can be imported before `npm install`, so it cannot load the package to test it functionally;
  accepting both layouts is the honest fix available under that constraint. `NATIVE_ADDON` and
  `DEP_SENTINELS` keep their meaning and their exports.
- **The transferable lesson:** a check keyed to a vendor's INTERNAL FILE LAYOUT fails the moment the
  vendor rearranges it, and it fails CLOSED - indistinguishable from a genuinely broken install. The
  same assumption appeared in two other places on the same day and cost a wrong diagnosis in each.
  Suite: 354/354.

### Release hygiene (same 1.6.3 release, found by CI)
- **The version lives in FIVE places**: `package.json`, `.claude-plugin/plugin.json`,
  `.claude-plugin/marketplace.json`, `.codex-plugin/plugin.json`, and `src/version.ts`. The 1.6.3 bump
  set the first two and missed the next two, and `version-consistency.test.ts` caught it in CI -
  which is the test doing exactly its job. The fifth is generated by `scripts/generate-version.js`
  and is untracked, so it needs no edit; a stale local copy made it look like a further failure
  until the file's own header was read rather than patched.
- **`bun.lock` was not updated with `package.json`.** The dependency bump was made with `npm install`
  in a repo whose toolchain is bun, so the manifest moved and the lockfile did not, and CI failed on
  `bun install --frozen-lockfile`. The local install worked, which is why it went unnoticed: the fix
  had been verified functionally three ways (CLI, wrapper, scheduled task, all rc=0) and none of
  those reads a lockfile. Use the toolchain the repo declares.

### Known issue (NOT fixed here, tracked separately)
- Summary generation still fails on large **subagent** transcripts with
  `Summarizer SDK call timed out after 120000ms`, and 861 empty summaries remain in the archive
  (each now carries a recorded reason). That is a distinct defect from the crash above and is
  unaffected by this change. The run reports itself honestly - "Sync finished WITHOUT SUMMARISING
  ANYTHING ... This is NOT a healthy run" - rather than printing a bare success banner.

## [1.6.2] - 2026-09-17

### Fixed
- **The Ollama backend refuses a reply with no `<summary></summary>` block.** The shared extractor
  falls back to storing raw text, so a small model that continues the transcript was saved as a
  summary. Measured on three real conversations with Claude-written reference summaries:
  qwen3.8:27b matched all 3; qwen2.5vl:3b answered one as a chat reply ("Sure, I can help with
  that...") on one machine and emitted `<|Summary of changes|` on another. Such replies now take
  the retry/give-up path. Use a model of the 27B class for summaries; 3B-class models are not
  reliable here. Suite 354/354.

## [1.6.1] - 2026-09-17

### Fixed
- **Backfill stopped a healthy run after its second batch.** The 1.6.0 no-progress guard compared
  where a batch STARTS with what the previous batch LEFT - equal by construction - so the first
  production run ended at 50 of 516 with 'No progress'. The decision is now the pure, tested
  `batchVerdict()`: progress is measured on what a batch leaves; 'backend down' needs 3+ attempts
  with no success, so one flaky transcript among no-exchange sentinels does not end the run.
  5 tests written first (RED on the exact 1.6.0 case). Real 3-batch run: 516 -> 391, completed.
  Suite 353/353.

## [1.6.0] - 2026-09-17

### Added
- **`episodic-memory backfill`** summarizes ARCHIVED conversations that sync can never reach. Sync
  walks only transcripts whose source file still exists, so a pruned conversation kept no summary
  forever. Candidates are exactly what sync would retry: no summary file, or an empty summary with no
  marker or a retrying marker. `--dry-run`, `--limit`, `--batch` (sync lock held per batch and
  released between batches). Stops when every attempt in a batch fails. Measured on one machine:
  551 real candidates (of ~4,400 archived conversations lacking a summary, the rest are deliberately
  excluded: 2,393 in an excluded project, 1,109 agent transcripts, 336 marker-excluded).
- **Ollama summarizer backend** (`EPISODIC_MEMORY_SUMMARIZER_BACKEND=ollama`). Required explicit
  model (a default would evict a shared host's resident model); http only on loopback, same rule as
  the API base URL, so transcripts never cross a network unencrypted - tunnel remote hosts over ssh;
  non-streaming, `think:false`, temperature 0, prompt character budget, strips `<think>` blocks,
  throws on HTTP errors and empty responses so failures are recorded.

### Fixed
- An EMPTY summary (e.g. a model replying `<summary></summary>`) is now recorded as a failure, not
  written as success. Written as success it became an unexplained empty file that sync and backfill
  both re-queue, so backfill would have re-summarized it forever. Found in review; test written first.
  Backfill also stops when a batch makes no progress.

### Changed
- The per-file summarize step is extracted from sync into `summarizeOneFile()`, shared by sync and
  backfill so both leave identical evidence (summary, no-exchanges sentinel, oversized skip, retry
  record, give-up). `isTerminalFailRecord` is exported. Behaviour of sync is unchanged: suite 348/348
  (13 new tests, written first and confirmed RED).

## [1.5.7] - 2026-09-17

### Fixed
- **A missing better-sqlite3 native binding is now detected and built, on BOTH entry points.** The
  plugin installer skips install scripts, so 1.5.2, 1.5.3, 1.5.4 and 1.5.6 all deployed with
  `better-sqlite3/lib/index.js` present and `build/Release/better_sqlite3.node` absent. The health
  sentinel checked only the JS file, so it passed, and `npm install` on that tree does nothing anyway.
  The binding is now a sentinel; a tree missing only the binding gets `npm rebuild better-sqlite3`,
  and the result is re-checked rather than trusted.
- **The SessionStart sync hook repairs dependencies too.** It never passed through the MCP wrapper,
  so a broken tree failed every background sync. It now runs the same repair and logs what it did.
- npm is spawned with one command string on Windows, removing the DEP0190 unescaped-args warning.

### Added
- `cli/ensure-deps.js` (shared repair) and `repairPlan()` in `src/deps-health.ts`, with 4 tests
  written first and confirmed RED. Suite 335/335. End-to-end: a copy of the deployed plugin with its
  binding deleted was rebuilt in ~2 s, the second call was a no-op, and the database opened.

## [1.5.6] - 2026-09-17

### Fixed
- **`pendingSummaries` is measured AFTER the work, so the stalled-queue banner stops crying wolf.**
  It was assigned before the summarise loop, although its own doc comment says "still LACK a
  summary after this run". Every conversation queued in a run therefore counted as still pending
  even once it had a summary or a legitimate sentinel. Production symptoms on one machine:
  `Summarized: 4 (4 still pending)`, and a FALSE `Sync finished WITHOUT SUMMARISING ANYTHING - 3
  conversation(s) still need summaries` on a run where all three were no-exchanges transcripts
  that had been correctly marked. A conversation is now pending iff it still has no summary file.
- **Legacy empty summaries with no recorded reason are finally retried, without a storm.** An
  empty `-summary.txt` with no `-summary.failed` marker is the artefact of a pre-1.5.2 give-up that
  deleted its marker. A bare `existsSync` gate read them as DONE forever, so 27 on one machine were
  reported as a silent failure on every run and could never clear. They are now re-queued in the
  LAST priority tier (fresh work, then retries, then legacy empties) inside the normal per-run
  budget, so they drain a few per sync and each ends explained: a real summary, a `no-exchanges`
  marker, or a recorded give-up. A legacy item whose retry fails keeps retrying up to the attempt
  cap instead of stalling at attempt 1.

### Investigated, not a defect
- The "summariser fails on this machine" diagnosis was WRONG. 3,010 `Cannot read properties of
  undefined (reading 'match')` failures in the log are all from June 2026 and long fixed; every one
  of the 22 current failure markers is a legitimate `no-exchanges`; and runs that queue work do
  summarise it (2/2, 1/1, 4/4, 1/1). Most `Summarized: 0` runs simply had nothing to do.

### Added
- `test/sync-pending-and-legacy-retry.test.ts` - 9 tests, written first and confirmed RED: pending
  after real summaries, after no-exchanges sentinels, and the two controls (failed-and-retrying,
  deferred past budget); legacy retry, no-exchanges legacy becoming explained without an SDK call,
  fresh work first, fail-then-retry up to the cap, and a give-up marker left alone. Suite 331/331.

## [1.5.5] - 2026-09-03

### Fixed
- **The native addon is now built when the plugin is installed.** `better-sqlite3` is a native
  module; without its postinstall, `better_sqlite3.node` is never produced and every sync dies
  with "Could not locate the bindings file". npm 11 skips install scripts unless package.json
  declares `allowScripts`, and `claude plugin update` clones this repo into a fresh version
  directory and runs `npm install` there - so the declaration has to live in the REPO, not on any
  one machine.
- **This shipped broken three times before the cause was fixed** - 1.5.2, 1.5.3 and 1.5.4 all
  deployed with the addon unbuilt. It was patched by hand twice, which is why it recurred: the
  scheduled sync fails with rc=1 and a scheduled task has nowhere to print, so it is invisible
  until a patrol reads the task result.

### Added
- `test/allow-scripts-pin.test.ts`. npm writes the approval VERSION-PINNED
  (`better-sqlite3@12.11.1`), so bumping the dependency silently lapses it and the identical
  silent failure returns. The test compares the pin against the **lockfile's resolved version** -
  not against the dependency RANGE, which legitimately differs (`^12.4.1` vs `12.11.1`) and made
  the first draft of this test fail on a healthy repo. Proved non-vacuous: staling the pin turns
  the suite red with the remediation in the failure message.

## [1.5.4] - 2026-09-03

### Fixed
- **The orphan reaper now logs EVERY invocation, including the quiet one.** It previously
  `return`ed silently on three separate paths - enumeration failure, an empty victim list, and
  all-kills-failing - so "ran and found nothing" was **indistinguishable from "never ran"**. On
  2026-09-02 five orphaned processes survived a run and the log held zero entries; that fact
  carried no information. A reaper that speaks only when it kills is unfalsifiable.

### Why this shipped before the reaper's other known defect
- The reaper also has a targeting defect, and it could not be diagnosed until this one was fixed.
  The very first line the new logging produced was:
  `orphan-reaper: ran, 11 claude process(es) seen, 11 in baseline, 0 to reap`
  which overturned the hypothesis on file. The baseline does not "miss" session-spawned orphans -
  **every process was in it**, because `sync --background` returns almost immediately, the child
  closes within ~1 second, and the reaper therefore fires BEFORE any fork it targets exists. Its
  window is one second wide, at the wrong moment.
- The implied fix is different from the one previously filed: run the reaper at the START of the
  next sync, reaping the previous run's leftovers by signature and age, where a baseline is
  meaningful. That is NOT in this release - it is a design change to destructive automation and it
  is filed with its evidence.

## [1.5.3] - 2026-09-02

### Fixed
- **Orphaned summariser processes are now reaped.** `callClaude` bounds its SDK call with a 120 s
  AbortController, but aborting stops the PARENT iterating — it does not terminate the
  `claude.exe --fork-session` child the SDK spawned, nor the transient daemon supervising it.
  Measured on a live machine: two workers lived **3 h 45 m against that 120 s bound**, accruing
  CPU at ~1.2% with perfectly flat working sets (an idle poll loop), together accounting for
  ~47 processes and ~5 GB. The bound was real and could not reach the thing it bounded.
- `cli/sync-hook.js` now snapshots `claude.exe` **before** launching the background sync and
  sweeps afterwards. **Order is load-bearing**: killing the workers alone is not enough — the
  transient daemon respawns its pty-hosts within seconds (verified live), so the daemon dies
  first, then pty-hosts, then forks.

### Safety
- Reaping requires BOTH that a process was absent from the pre-launch baseline AND that it
  matches one of three SDK-plumbing signatures (`daemon run --origin transient`, `--bg-pty-host`,
  `--fork-session`). An interactive session matches none of them. The baseline is what makes a
  mis-tuned signature survivable.
- **Fails open**: if the process list cannot be enumerated, nothing is reaped, ever.
- Verified against the real live process table with an EMPTY baseline — the worst case, where
  every process looks new — selecting **zero** of 11 live `claude.exe`, with all three real
  sessions surviving. Six unit tests include two controls: a human session is never selected, and
  nothing predating the sync is ever selected. Without those controls, "it reaps the orphans"
  cannot be distinguished from "it reaps everything".

## [1.5.2] - 2026-09-02

### Fixed
- **An empty `-summary.txt` no longer erases the reason it is empty.** The give-up path wrote the
  empty sentinel and then DELETED the failure record (`fs.unlinkSync(summaryFailPath(...))`), so a
  permanently-failed summary became byte-identical to a legitimately-empty one. Measured on one
  machine: **2,919 zero-byte summaries out of 6,762 (43%), and ZERO failure markers**. The sentinel
  is what stops the re-queue loop that F1 fixed; erasing the evidence was never the mechanism, only
  collateral. The marker now survives, flagged `gaveUp: true` with a timestamp.
- **Zero-exchange conversations record their reason too** (`reason: "no-exchanges"`), so an empty
  summary carrying no marker at all now means exactly one thing: nobody knows why.
- **Version sources of truth are now unified at one value across all five places**:
  `package.json`, `.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json`,
  `.codex-plugin/plugin.json`, and the generated `src/version.ts`. As shipped, 1.5.1 left the
  marketplace and codex manifests behind on 1.5.0 while package.json said 1.5.1, and both
  consistency tests were failing on that tree unread. (Correction to this entry's first draft:
  PRs #6/#7 had already moved the marketplace manifest to 1.5.1 upstream of this work — the
  1.5.0 reading came from a stale local base, and only the codex manifest was still behind by
  the time this landed. Recorded because the original claim was wider than the evidence.)

### Added
- `SyncResult.emptySummaries` and `SyncResult.unexplainedEmptySummaries`, counted during the walk
  that already stats each file, and reported by the CLI. **`pendingSummaries` counts only
  conversations with NO summary file**, so an empty one satisfies the needs-summary gate forever
  and a failed summariser left no trace in any number printed. The 1.5.1 honest banner was keyed
  on `pendingSummaries` — the very value this defect corrupts — so it could never fire for this
  mode. These counts are the only place the condition shows.
- Deliberately NOT re-queuing empty summaries. Re-queuing 2,919 conversations at once would storm
  the summariser that is already the thing failing. Visibility first; re-summarising is a separate,
  throttled decision.

### Also shipped in 1.5.2

These entries came from #6 (merged 2026-08-30, first tagged in v1.5.2). Until 2026-09-23 they sat
under a second, stale Unreleased heading below 1.5.1.

### Security
- **MCP `read` now respects `EPISODIC_MEMORY_REDACT_SECRETS`.** Search results were redacted at return time, but `read` still returned raw archive JSONL — a gap when redaction is enabled. Read output now passes through the same opt-in redaction.
- **Search summary sidecars are archive-confined.** Summary files were loaded via a naive `.replace('.jsonl', '-summary.txt')` on DB `archive_path` values, so a poisoned path outside the archive could still read an arbitrary `*-summary.txt`. Summaries now use the same archive prefix and realpath checks as MCP `read`.
- **Optional MCP tool authorization.** When `EPISODIC_MEMORY_MCP_TOKEN` is set, `search` and `read` require a matching `auth_token` (constant-time compare). Default remains open for single-user stdio.
- **Threat-model document.** `docs/security.md` records remaining residual risk (plaintext at rest, filesystem encryption recommendation, hook trust boundary).

### Added
- **`episodic-memory doctor` (no subcommand)** reports config/archive/index health, DB stats, embedding-version drift, last hook errors, and `node_modules` sentinels. `--json` is supported; `doctor codex` is unchanged.
- **Search results include conversation summaries** by default (upstream #74), including MCP JSON and multi-concept paths. Disable with `EPISODIC_MEMORY_INCLUDE_SUMMARY=0`; truncate with `EPISODIC_MEMORY_MAX_SUMMARY_DISPLAY_CHARS`.

### Changed
- **Completed the TypeScript-on-BunJS toolchain migration.** Dev/CI use Bun exclusively (`bun install --frozen-lockfile`, `bun run …`, `bun audit`). `package-lock.json` is removed again (reintroduced by the MCP 2.0 PR) and gitignored so dual lockfiles cannot drift. `packageManager` is `bun@1.4.0`; scripts chain via `bun run`; a real `typecheck` script (`tsc --noEmit`) replaces the previous CI no-op. **Node remains the production runtime** (CLI shebangs, `.mcp.json`, SessionStart hooks, Node smoke in CI). Plugin first-run install still uses `npm install` in the wrapper. `better-sqlite3` is pinned exact (`12.11.1`) so lockfile-less npm install matches the `allowScripts` key; Bun gets `trustedDependencies` for the same addon. `test/allow-scripts-pin.test.ts` asserts against `bun.lock`.
- **MCP server upgraded to `@modelcontextprotocol/server` v2 (protocol `2026-07-28`).** Uses `serveStdio` for stateless modern clients (`server/discover`) while still serving legacy `initialize` clients through `2025-11-25`. Adds `test/mcp-protocol.test.ts` to lock both eras.
- **Embeddings truncate before concatenate.** `formatExchangeEmbeddingText` applies `truncateForIndex` so multi-MB prompt payload is not allocated into the combined embed string.
- **Claude parser links `tool_result` to `tool_use`** via `tool_use_id`, matching the Codex path.

### Fixed
- **SessionStart hook failures are logged to `sync-errors.log`.** Hook stderr was easy to miss; a dedicated wrapper runs `sync --background`, records non-zero exits, and always returns success so hooks stay non-blocking (upstream #94).
- **Plugin manifest version drift.** `.codex-plugin/plugin.json` and `.claude-plugin/marketplace.json` now match `package.json` at 1.5.1.

## [1.5.1] - 2026-08-29

### Fixed

- **Sync no longer reports success over a stalled summary queue.** `Sync complete!` printed
  unconditionally, including on runs that summarised nothing while a backlog waited (measured:
  87 of 140 sync blocks reported `Summarized: 0` under a green banner). A stalled run now says so
  explicitly, and the count reads `Summarized: N (M still pending)` so "nothing needed doing" and
  "the queue is stuck" are no longer the same output.
- **`SyncResult.pendingSummaries` added and actually populated.** The CLI carried a
  `totalNeedingSummaries` field that nothing ever set, so it read 0 forever; any health check
  built on it would have been decorative.
- **Oversized transcripts are skipped instead of retried to no purpose.** A 45.8 MB transcript was
  handed whole to a 120 s summariser call it could only ever time out on, then burned its three
  attempts across three syncs while its archive fell a day behind. Conversations above
  `EPISODIC_MEMORY_MAX_SUMMARY_BYTES` (default 10 MB) are now recorded as deliberately skipped,
  with the reason written to the failure sidecar.
- **Previously-failed conversations can no longer starve fresh ones.** Files were enqueued in
  directory order and the per-run budget took the first N, so doomed conversations held the front
  of the queue and consumed the whole budget every run. Retries are now sorted last, using
  leftover budget rather than all of it.

# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## 2026-09-03 - CI now exercises the NODE runtime, not just Bun

- Every CI step ran through `bun run` while `setup-node` was installed and never invoked,
  so the production runtime was never exercised. Measured across the workspace: 13 of 14
  sampled repos had this shape.
- Added a Node smoke step that imports the shipped entry (`./dist/index.js`) under Node and fails on a
  throw, a syntax error, or an unresolvable import. A server that self-starts on import
  passes after 5s, because starting without crashing is the signal.
- **Proven failure-capable before adoption**, on librarian-mcp: corrupt artifact -> exit 1;
  missing dependency -> exit 1; good artifact -> exit 0. The missing-dependency case is the
  class that forced six repos to revert during the Bun migration.
- Smoke verified locally against this repo's built artifact before the step was added.

## [1.5.0] - 2026-08-13

### Security
- **MCP `read` now defeats symlink escapes** via `fs.realpathSync` on both the candidate path and the archive root (plus Windows case-normalization). A planted `*.jsonl` symlink under the archive that pointed outside previously passed the lexical prefix check; it is rejected. Covered by `test/archive-path.test.ts`.
- **MCP `read` enforces a byte cap** (`EPISODIC_MEMORY_MAX_READ_BYTES`, default 32 MB) and streams line ranges instead of loading entire JSONL files into memory.
- **Opt-in secret redaction** (`EPISODIC_MEMORY_REDACT_SECRETS=1`) replaces token-shaped substrings with `[redacted]` at embed, insert, and search-return time.
- **Custom summarizer API base URLs** must be `https:` (or `http:` on localhost only) and must not embed credentials; unsafe values are ignored with a stderr warning.
- **New config/index dirs are `0700` and the SQLite DB is chmod'd `0600`** (best-effort) so conversation history is not world-readable under a permissive umask.
- **Committed `package-lock.json`**; CI runs `npm ci` + `npm audit --audit-level=critical`.
- **Two high-severity transitive vulnerabilities cleared: `sharp` and `adm-zip`.** Both arrive
  through `@huggingface/transformers@4.2.0` — `sharp` directly, `adm-zip` via
  `onnxruntime-node@1.24.3` — and neither can be moved by upgrading the parent: 4.2.0 **is**
  latest, and it caps `sharp: ^0.34.5` and pins `onnxruntime-node` to an exact version. So a
  plain `npm install` resolves the vulnerable versions no matter how current the tree is.

  This supersedes the note added just above with the `npm ci` switch — "transitive highs in
  onnxruntime-node/sharp currently have no upstream fix". That is true of the *dependency
  tree*: no released parent resolves them. It is not true of this package, because an
  override does. The `npm audit --audit-level=critical` gate stays as it is; it is the right
  ceiling for advisories genuinely outside our control, and these two no longer are.

  Fixed with range-based `overrides` (`sharp: ^0.35.0`, `adm-zip: ^0.6.0`), matching the
  existing `hono`/`protobufjs` entries. Ranges, not exact pins — an override pinned to a
  single version becomes the blocker the moment *that* version is flagged. Resolved to
  sharp 0.35.3 and adm-zip 0.6.0; full suite green (38 files, 210 tests).

  Blast radius is small here: neither package is used directly anywhere in `src/`. This
  codebase drives transformers for text embeddings only, so `sharp` (its image path) and
  `adm-zip` (onnxruntime's model extraction) are reachable but not on any hot path this
  project exercises.
### Changed
- **SessionStart sync uses high-water incremental indexing** — only exchanges past `MAX(line_end)` are re-embedded when a transcript's mtime advances (same append-only contract as `indexUnprocessed`).
- **Search markdown formatting** reports `≥line_end` from the DB instead of full-scanning every archive to count lines.
- **Text search prefers FTS5** (`exchanges_fts`) with a LIKE fallback; new indexes on `archive_path` and `embedding_version`.
- **Embeddings are batched** per conversation / migration batch. Semantics unchanged — no `EMBEDDING_VERSION` bump.
- **MCP server lazy-loads** search/embeddings/show inside tool handlers and reuses a shared reader DB connection.
- **Exclusion-marker scan** reads only the first 256 KB of a file.

### Fixed
- **Sync now also fires on compaction, so long-lived sessions no longer stop archiving.** The `SessionStart` hook matched only `startup|resume|clear`, which means archiving happened at session *boundaries* and nowhere else. That is fine if sessions are short, and silently broken if they are not: on a machine whose sessions run for days, nothing is archived for as long as they stay up, and search keeps answering — confidently — from whatever was captured at the last restart. Measured on a real install 2026-08-08: **65 hours with no archive write at all**, while all six server processes stayed healthy and a live `search` returned correct ranked hits. The last sync in the log had *completed* normally (`Copied: 9, Indexed: 8`); nothing had failed. Of 67 transcripts written since the cutoff, **64 were absent from the archive entirely** and the 3 present were stale — the archived copy of the session doing the investigating was 21,712 KB against a 25.6 MB file on disk. Adding `compact` to the matcher fixes it at the trigger rather than papering over it with a timer, because compaction is frequent in exactly the long sessions that suffer, and rare in the short ones that were already covered. This does **not** widen the summarizer recursion surface (#87): SDK subprocesses fire `startup`, which was already matched, and the guard is environment-based (`EPISODIC_MEMORY_SUMMARIZER_GUARD`) rather than matcher-based. The existing `.sync.lock` continues to serialize overlapping runs. Covered by a new assertion in `test/hooks.test.ts` that checks event membership rather than the literal matcher string, so reordering the alternation cannot silently drop an event.
- **Added `index prune`** ([#4](https://github.com/danielsimonjr/episodic-memory/issues/4)). `exclude.txt` / `CONVERSATION_SEARCH_EXCLUDE_PROJECTS` are consulted only while walking source directories at index time (`indexer.ts:62-63`), so adding a project to the exclude list stopped new rows appearing but left everything already indexed in place and searchable, with no supported way to remove it. That is the wrong moment for the feature to be usable: nobody adds an exclusion *before* the noisy project exists, so users reach for it only after something has flooded the index — the point at which it can no longer help. `index prune --excluded` removes rows for every project in the exclude list; `index prune --project <name>` targets one; `--dry-run` reports counts and reclaimable bytes without touching anything. Deletion order respects the `tool_calls` foreign key (see #81), and vectors are removed one id at a time because vec0 virtual tables support neither JOIN nor subquery in `DELETE` — this requires the `sqlite-vec` extension to be loaded on the connection, which `initDatabase()` does. A client without it (Python's stock `sqlite3`, for instance) silently skips the vector table and leaves orphans behind. An empty project list is an explicit no-op rather than an `IN ()` clause that would be a syntax error at best and match everything at worst. Prune reminds you to run `index vacuum` afterwards, since deleting rows alone returns no disk space.
- **Added `index vacuum`** ([#3](https://github.com/danielsimonjr/episodic-memory/issues/3)). There was no `VACUUM` anywhere in the codebase — nor any retention or TTL — so the index only ever grew. SQLite does not return freed pages to the filesystem on its own, which meant deleting rows reclaimed no disk space at all and read to users as "deleting didn't work". Verified: a database holding 51.8 MB of deleted rows stayed at 51.8 MB until vacuumed, then dropped to 0.1 MB. The command reports the reclaimable free-page total before running so the benefit is visible up front, and warns that VACUUM needs temporary free space roughly equal to the database size. When there is nothing to reclaim it says so plainly rather than printing a negative figure — VACUUM also checkpoints the WAL into the main file, so a nearly-empty database can legitimately finish slightly larger.
- **Machine-generated prompt payload is no longer indexed verbatim as conversation** ([#2](https://github.com/danielsimonjr/episodic-memory/issues/2)). Third-party plugins that summarize conversations spawn a subagent whose prompt embeds the entire conversation being summarized. Those subagent sessions are ordinary transcripts, so they were indexed like any other chat — turning a single "user message" into megabytes. The existing `EXCLUSION_MARKERS` defence in `sync.ts` does not help here: it is *cooperative*, matching only agents that emit a known marker, and third-party summarizers emit none. Measured on a real install: median `user_message` **1,636 bytes**, largest **3,109,374 bytes**, and 1,301 such rows accounted for **2.53 GB — 97.2% of a 3.04 GB database**. For scale, every assistant reply ever recorded totalled 0.03 GB. `insertExchange()` now caps both message columns at `MAX_INDEXED_MESSAGE_BYTES` (default 256 KB, ~150x the median, override via `EPISODIC_MEMORY_MAX_MESSAGE_BYTES`; 0 disables). The head of the message is kept so the row stays searchable and its source identifiable, and a `[truncated by episodic-memory: …]` notice records what was dropped rather than silently discarding it. Truncation is idempotent, so re-indexing never stacks notices. Applied in `insertExchange()` because that is the single choke point every indexer path goes through, so the size invariant holds regardless of caller.

  Note this caps what is *stored*; the oversized text is still embedded before insert. Moving the cap earlier, into the parser, would also avoid that wasted embedding work — worth doing, but it is a larger change across four construction sites and is left as a follow-up.

### Security
- **Enforced patched-version floors for vulnerable dependencies.** `npm audit` reported a CRITICAL in `vitest` (`<3.2.6`, GHSA-5xrq-8626-4rwp) plus HIGH advisories in transitive `hono` (≤4.12.24 — `serve-static` path traversal, CORS reflection, cookie injection, etc.) and `protobufjs` (≤7.6.2). Because this repo intentionally gitignores `package-lock.json`, the fix is encoded in `package.json`: the `vitest` devDependency floor is raised `^3.2.4 → ^3.2.6` (the old range still permitted the vulnerable 3.2.4/3.2.5), and `overrides` pin `hono ^4.12.27` (via `@modelcontextprotocol/sdk`) and `protobufjs ^7.6.4` (via `@huggingface/transformers`). `npm audit` is now 0; the full 188-test suite still passes.
- Hardened the `read` MCP tool against arbitrary local file reads. Previously the tool accepted any absolute path with only an `existsSync` check, so a prompt-injection attack could trick an LLM into reading any file the Node process had access to (e.g., `~/.ssh/id_rsa`). The tool now requires the resolved path to lie inside the configured archive directory and end in `.jsonl`. All legitimate paths flow from `search()` results, whose `archive_path` values are always constructed as `path.join(projectArchive, file)` rooted in `getArchiveDir()`, so this is non-breaking for normal use.

### Fixed
- **The background sync worker no longer starves the interactive session that spawned it.** `sync --background` spawns a *detached* worker which then boots transformers.js and embeds exchanges on the CPU; onnxruntime saturates every core it is given. Because the worker inherited **normal** priority, it competed on equal terms with the foreground — including plugin MCP servers, which must complete a handshake inside Claude Code's 30s startup budget. Observed 2026-07-13: a background sync held ~5 of 12 cores for 10+ minutes, the machine sat at 100% CPU, and MCP servers timed out at 30s (`chrome-devtools` among them) — a "plugin is broken" symptom whose actual cause was CPU starvation. The detached worker is now tagged via `EPISODIC_MEMORY_BACKGROUND_WORKER` and drops itself to **below-normal** priority *before* the heavy imports load, so the OS preempts it for interactive work. The sync still completes; it just gets out of the way. (The earlier orphan-storm fix bounded how *many* workers spawn — this bounds what a single legitimate worker is allowed to cost.)
- **`repairIndex` now indexes a conversation even when summary generation fails.** The re-index loop generated a summary (a Claude Agent SDK call) *before* inserting the exchanges, and a summarizer throw (unauthenticated environment, timeout, SDK error) fell through to the loop's outer `catch` — so the file was never re-indexed, `last_indexed` was never updated, and the file stayed permanently "outdated," re-attempted (and re-failing) on every run. Summary generation is now best-effort (its own `try/catch`): a summary failure logs a warning and the exchanges + embeddings are still indexed. The summary is auxiliary; indexing is the point.
- **`verifyIndex` no longer reports a just-repaired file as still outdated on fast machines.** The outdated check compared `fs.statSync(path).mtimeMs` — a float carrying sub-millisecond precision (e.g. `1234.9`) — against the stored `last_indexed`, an *integer* ms epoch (`Date.now()`), using a strict `>`. So `1234.9 > 1234` flagged a file as modified even when the re-index landed in the same integer millisecond as its mtime. On fast runners (Linux CI) this made `repairIndex` appear to do nothing (`verifyIndex().outdated` stayed non-empty after repair) and failed `verify.test.ts`; on slower Windows the ms gap hid it. The comparison now floors `mtimeMs` to the integer-ms storage granularity (`Math.floor(fileStat.mtimeMs) > lastIndexed`) — sub-ms changes are undetectable at this resolution anyway, and genuine later edits (>1 ms) are still detected.
- **The summarizer subprocess no longer boots the user's whole MCP-server fleet (the process cascade behind the wedged-orphan storm).** Every summary spawns a Claude Agent SDK subprocess; because `buildSummarizerQueryOptions` didn't set `settingSources`, the SDK loaded the user's filesystem settings, which started every configured MCP server *and* fired SessionStart hooks inside each summary subprocess. A single wedged summary subprocess was observed to have spawned a tree of ~14 children, each with their own children — saturating the CPU. The summarizer now runs in isolation (`settingSources: []`, `mcpServers: {}`): no MCP servers, no hooks, no tools. Authentication is unaffected (it comes from the environment, not filesystem settings).
- **A stalled summarizer SDK call can no longer wedge the sync forever.** `callClaude` awaited the SDK result with no timeout, so a subprocess that never returned blocked the background sync indefinitely — the direct cause of the orphaned `sync-cli` processes that pegged CPU for hours. Each call is now bounded by an `AbortController` that fires after `EPISODIC_MEMORY_API_TIMEOUT_MS` (default 120s), aborting the subprocess and throwing a clear timeout error the caller records. The same no-timeout hazard in the Codex `--version` probe (`readCommandOutput`) is fixed too.
- **Overlapping background syncs no longer stack.** Every SessionStart (startup/resume/compact, across multiple Claude sessions) fired `sync --background` with nothing preventing concurrency, so multiple syncs ran at once — each loading the transformer and fanning out summarizer subprocesses. A new cross-process file lock (`.sync.lock`, PID-liveness + mtime-age stale recovery, atomic steal) serializes syncs: a second worker bails instantly. The lock is checked before the heavy imports load, so a locked-out worker exits in milliseconds.
- **Conversations that deterministically fail to summarize no longer re-queue forever.** When `summarizeConversation` threw, no sentinel was written, so the file was re-attempted on every subsequent sync — the "backlog never drains" class. After `EPISODIC_MEMORY_MAX_SUMMARY_ATTEMPTS` failures (default 3, tracked in a `-summary.failed` sidecar) the conversation gets an empty `-summary.txt` sentinel and stops being re-queued. A later success clears the failure record.
- **The resume-based summarization path was removed entirely** (superseding the earlier "skip resume when not resumable" change). Resume always failed from the background-sync context — the Agent SDK resolves a session by the subprocess's CWD-derived project directory (the plugin dir), not the user's project — so every archived conversation spawned a doomed resume subprocess that errored and fell back to transcript text anyway. `summarizeConversation` now always summarizes the transcript text it already holds.
- **The summary cap is now a single configurable per-sync budget.** It was applied per source directory (so the real cap was 10 × number of source dirs) and wasn't configurable. It's now one `EPISODIC_MEMORY_SUMMARY_LIMIT` budget (default 10) shared across all source dirs.
- The SessionStart sync hook now exits in ~0.5s (was ~3.5s warm, and >5s on a cold disk) when it detects it is a summarizer-spawned reentrant subprocess. The reentrancy guard (#87) was checked only *after* the heavy native modules were statically imported — `better-sqlite3` (via `db.js`) and the transformer/onnx stack (via `embeddings.js` / `embedding-migration.js`) — so every guarded subprocess loaded the full stack just to bail, wasting seconds of CPU/disk per spawn and intermittently timing out the reentrancy integration test on cold disks. The guard now lives in a dependency-free module (`src/reentrancy.ts`) and is checked first; `sync-cli` imports the heavy modules lazily only when it is actually going to do work.
- **Robustness hardening surfaced during the orphan-storm investigation** (each a latent hang, leak, or deadlock): the Codex app-server path rejects in-flight requests and guards stdin writes when the child dies (no dangling promises / uncaught EPIPE); hierarchical summarization caps its chunk count so a huge conversation can't fan out unbounded sequential SDK calls; the sync log rotates at 5 MB (`.1` backup) instead of growing without bound; the indexing DB handle is closed in a `finally` so a parse error can't leak it (and its WAL) into a "database is locked" on the next run; `initDatabase` sets `busy_timeout` so concurrent writers wait instead of failing with `SQLITE_BUSY`; `copyIfNewer` uses a unique temp suffix and cleans it up on a failed rename (no orphaned `*.tmp.*` files); transcripts whose filename has no session UUID are still summarized instead of silently dropped; the background-sync launcher closes its inherited log file descriptor; and the MCP server wrapper polls parent liveness so an abnormal Claude exit can't orphan the server holding the DB lock.
- Background sync no longer burns CPU and spawns doomed subprocesses forever on conversations whose original session has been archived. The summarizer resumes the original session to summarize it cheaply, but resuming a session that no longer exists in `~/.claude/projects/` makes the Agent SDK return an error result (`subtype: 'error_during_execution'`, no `result` field). `callClaude` returned that `undefined`, and `extractSummary` crashed with the cryptic `Cannot read properties of undefined (reading 'match')`. The conversation was never marked summarized, so every subsequent sync re-attempted it — spawning a fresh Claude subprocess that failed the same way — and the backlog never drained. Now: (1) `callClaude` throws a clear, actionable error when the SDK signals an error instead of returning `undefined`; (2) `extractSummary` guards against non-string input; and (3) `summarizeConversation` falls back to summarizing the transcript text it already has when resume fails, so archived conversations summarize successfully and the backlog drains. This is the same "backlog never drains" failure mode as the 1.4.1 empty-conversation fix, but with a different root cause (un-resumable sessions rather than zero-content files).
- On Windows, conversation parsing now extracts the correct project name. Previously `parseConversationFile` split the path on `/` only, so `C:\Users\...\test\fixtures\short.jsonl` produced `project = 'unknown'` instead of `'fixtures'`. All conversations indexed on a Windows machine had `project = 'unknown'` in the database. The fix uses `path.basename(path.dirname(filePath))` which handles both separators.
- Schema-migration log lines no longer corrupt the MCP stdio protocol. The five `console.log` calls in `migrateSchema` and `migrateToolCallsCascade` fire to stdout when migrations run during MCP server startup, and stdout on a stdio MCP server is reserved for JSON-RPC. Switched them to `console.error` (stderr). Users upgrading to a schema-changing version no longer get a `× failed` server with no obvious symptom.
- Test suite is no longer flaky on cold/contended machines. `integration.test.ts` and `verify.test.ts` intermittently timed out paying the transformer model's cold load (and bulk embedding of multi-exchange fixtures) inside per-test budgets. The model is now pre-warmed once per worker in `beforeAll`, `hookTimeout` is set to 30s (matching `testTimeout`) for the embedding-heavy `beforeEach` hooks, and the repair re-index test gets 60s. Two consecutive full-suite runs pass 173/173.
- Test cleanup is more resilient on Windows. `fs.rmSync` on a directory containing recently-closed SQLite WAL files (`*.db-wal`, `*.db-shm`) intermittently throws `EPERM` until the OS releases the handle. Added a shared `safeRmSync` helper in `test/test-utils.ts` with bounded retries and exponential backoff (20-320ms), and wired it into `db.test.ts`, `verify.test.ts`, and `integration.test.ts`.

### Earlier in this Unreleased cycle
- The plugin now loads on a freshly-installed Windows machine without a manual `npm install` recovery step. Two failure modes are addressed: (1) the launcher's "is `node_modules` healthy" check used to look only at the folder's existence, so a partial extract that left `better-sqlite3` missing its native binding slipped through silently — it now verifies a list of sentinel dep files and re-runs install if any are missing; (2) `@huggingface/transformers@4.2.0` directly imports `onnxruntime-common` in its ESM bundle without declaring it as a direct dependency, and npm doesn't hoist it to top-level because `onnxruntime-node` and `onnxruntime-web` pull conflicting versions — `onnxruntime-common` is now a direct top-level dep so Node's ESM resolver can find the bare import. Symptom in both cases was `× failed` in `/mcp` with `ERR_MODULE_NOT_FOUND` on import.

## [1.4.1] - 2026-05-17

### Fixed
- Sync no longer gets stuck on conversations with no real content. Previously, files with only metadata or stub records re-queued for summarization on every run. Once ten of them piled up at the head of the queue, real conversations behind them stopped getting summarized at all. Now those files are marked as done the first time they're skipped, and the backlog drains. Thanks to @minyek for the fix.

## [1.4.0] - 2026-05-13

### Changed
- The `remembering-conversations` skill now triggers reliably for personal-fact lookups and other small questions that previously slipped past it. Tested against fresh sessions asking a personal-fact question, the previous description fired the skill 0/5 trials; the new description fires 3/5.

### Removed
- The `/search-conversations` slash command. Reference past work in natural conversation instead — the `remembering-conversations` skill dispatches the `search-conversations` agent automatically when recall is needed.

## [1.3.1] - 2026-05-13

### Fixed
- Recall skills now trigger when an agent needs to remember anything learned from prior Claude Code or Codex conversations, including decisions, patterns, solutions, pitfalls, workflows, project context, and lessons from similar work.
- Search-agent and slash-command descriptions now describe broad recall situations instead of narrowing discovery to explicit user requests or personal facts.

## [1.3.0] - 2026-05-13

### Added
- Native Codex plugin support with `.codex-plugin/plugin.json`, Codex MCP configuration, plugin hook packaging, and a local development marketplace entry.
- Codex rollout transcript parsing, display, archiving, indexing, and cross-harness search across Claude Code and Codex conversations.
- Codex-native summarization through `codex app-server` ephemeral `thread/fork`, with transcript-text fallback when Codex summarization is unavailable.
- `episodic-memory doctor codex` for checking Codex version, plugin features, MCP registration, hook trust, transcript directory, database, and sync log paths.
- Opt-in live Codex and Claude E2E scripts that verify archive, summary, index, and MCP recall behavior.

### Changed
- Recall skill instructions and MCP tool documentation now describe Claude Code and Codex usage, including direct MCP search/read guidance in Codex.
- CLI help, README setup, and architecture documentation now describe Claude Code plus Codex support.

### Fixed
- Codex hook trust diagnostics now report when the Episodic Memory hook is already trusted instead of always suggesting `/hooks`.
- Codex HTML transcript rendering now escapes raw HTML from transcript content before rendering.
- Codex `local_shell_call_output` items are now paired with local shell tool calls during parsing and included in rendered transcript output.

## [1.2.0] - 2026-05-03

### Better search results

This release upgrades the embedding model used for semantic search. On a 17,000-exchange retrieval test built from real production data, the new model puts the right answer at rank 1 about **53% of the time, up from 47%**. Top-10 accuracy improves from 68% to 75%.

The new model is `bge-small-en-v1.5` (BAAI), replacing `all-MiniLM-L6-v2`. Both produce 384-dimensional embeddings, so storage is unchanged.

### Automatic migration

Existing indexes upgrade themselves in the background. After you install 1.2.0, each `episodic-memory sync` re-embeds up to 500 stored exchanges with the new model. Claude Code triggers a sync at every session start, so most indexes finish migrating after roughly 60 sync runs — a few days of normal use.

During sync you'll see a line like this on stderr:

    episodic-memory: re-embedding batch of 500 (29569 stale total)...

Search keeps working throughout. The index holds a mix of old and new embeddings until migration finishes; ranking is slightly noisier but never broken.

To finish faster, run a sync with a larger batch:

    EPISODIC_MEMORY_MIGRATION_BATCH=5000 episodic-memory sync

That takes about a minute per call on a recent Mac.

If two syncs run at once, only one re-embeds; the other skips its migration step. A crash mid-batch leaves the unfinished rows tagged for migration, and the next sync picks up where the previous one stopped.

### Other notes

- **First sync after upgrade** downloads a new 34 MB model file.
- **Rollback to 1.1.x is safe.** Search still works against a partially-migrated index.
- **Resolves #82** (ONNX runtime crash on Node 23 and earlier) as a side effect of the underlying library upgrade.

## [1.1.2] - 2026-05-03

### Fixed
- **Critical: recursive process explosion from auto-sync** (#87, #88, thanks @kaankoken and @materemias for the diagnosis):
  - The `persistSession: false` fix in 1.1.0 (#83) prevented the SDK-spawned Claude subprocess from *saving* its session JSONL, but did not stop the subprocess from *firing the SessionStart hook*. That re-ran `episodic-memory sync --background`, which re-summarized, which spawned another Claude subprocess, which fired the hook again — fanning out hundreds of detached processes, saturating CPU, and burning API quota.
  - Added a reentrancy guard env var `EPISODIC_MEMORY_SUMMARIZER_GUARD`, set when calling the SDK's `query()` and inherited by the spawned subprocess. The `sync-cli` entry point checks the guard at startup and exits silently when it's set, breaking the recursive cascade at its only feasible point.
  - Coverage: unit tests for `getApiEnv()` (always sets the guard) and `shouldSkipReentrantSync()`, plus an integration test that spawns `dist/sync-cli.js` with the guard env and asserts a clean exit without doing work.
  - Anyone affected by the cascade should update to 1.1.2 immediately. If 1.1.0 or 1.1.1 had been spawning processes, kill any lingering `episodic-memory` and `claude-agent-sdk` children before restarting Claude Code.

## [1.1.1] - 2026-05-03

### Fixed
- **MCP server now reports the actual plugin version** in its protocol handshake instead of the long-stale hardcoded `1.0.0`. Inspector tools and any client logging the server identity will now see the real version.

### Changed
- **Single source of truth for version numbers.** `package.json` is the source; `src/version.ts` is generated from it at prebuild/pretest time and is referenced by `mcp-server.ts`. Source code can no longer drift from the declared package version.
- **Drift test for manifest files.** A new `test/version-consistency.test.ts` asserts `package.json`, `.claude-plugin/plugin.json`, and `.claude-plugin/marketplace.json` all agree. CI fails if anyone bumps one without the others.
- **`scripts/bump-version.sh` + `.version-bump.json`** for one-command version bumps with built-in audit (greps the repo for stale version strings in undeclared files). Run `./scripts/bump-version.sh X.Y.Z` to update all declared files; `--check` reports current state, `--audit` scans for stragglers.

## [1.1.0] - 2026-05-02

### Added
- **Search metadata filters** (#63, thanks @jwk2601 for the design): `--project`, `--session-id`, and `--git-branch` flags scope results by exact-match project name, session ID, or git branch. Available on the CLI and the MCP `search` tool. Filter values bind as positional SQL parameters; the existing `--after`/`--before` time filters were converted from string interpolation to bound parameters in the same change.
- **API configuration env vars for summarization** (#37, thanks @techjoec):
  - `EPISODIC_MEMORY_API_MODEL` — override the summarizer model (default: haiku)
  - `EPISODIC_MEMORY_API_MODEL_FALLBACK` — fallback model on errors (default: sonnet)
  - `EPISODIC_MEMORY_API_BASE_URL` — custom Anthropic endpoint
  - `EPISODIC_MEMORY_API_TOKEN` — auth token for custom endpoint
  - `EPISODIC_MEMORY_API_TIMEOUT_MS` — request timeout

### Changed
- **Bumped `@anthropic-ai/claude-agent-sdk` to 0.2.x** (transitively requires zod 4). Required for the `persistSession` option used by the #83 fix.
- **`tool_calls` schema now uses `ON DELETE CASCADE`** (#81). Fresh databases create the table with cascade; existing databases get a one-time migration that recreates `tool_calls` with cascade and drops any orphaned rows. The migration is idempotent and runs only when the schema lacks `ON DELETE CASCADE`.
- **`exclude.txt` matches nested directory names** (#80, thanks @rohitgehe05 for the diagnosis): adding `subagents` now also skips `<project>/<session>/subagents/agent-*.jsonl` instead of only matching top-level project directories.

### Fixed
- **Indexer skipped appended exchanges** (#84, thanks @jamster for the diagnosis and detection script): the `COUNT(*) > 0` skip was replaced with a `MAX(line_end)` high-water mark, so transcripts that grow after their first index pass now pick up their tail. Resumed sessions and SessionStart syncs that race the still-running session no longer silently lose the trailing content.
- **Search similarity scores were wrong** (#55, thanks @gmax111): `1 - row.distance` was treating L2 distance as cosine distance. For unit-normalized embeddings the correct conversion is `1 - d²/2`. Result ordering was already correct (the formula was monotonic in distance), so this is a display/aggregation correction, not a ranking change.
- **Summarizer session pollution** (#83, thanks @benseeley for the detailed reproduction): `persistSession: false` is now passed to the SDK, so summarization no longer creates fake session JSONLs in `~/.claude/projects/<cwd-slug>/`.
- **`deleteExchange` FK crash** (#81, thanks @rohitgehe05): `index --repair` no longer fails with `SQLITE_CONSTRAINT_FOREIGNKEY` on exchanges that have associated tool_calls.
- **Windows hook fails on home directories with spaces** (#75, thanks @phantomsecurityandfire and @officialasishkumar): the SessionStart hook command now quotes `${CLAUDE_PLUGIN_ROOT}`.
- **MCP install fails with `ETARGET` on stale npm cache** (#76, thanks @DarkbyteAT and @mvanhorn): removed `--prefer-offline` from the wrapper's `npm install` invocation.
- **MCP protocol corruption from embedding model output** (#48): the embedding model's stdout is now redirected to stderr.
- **Orphaned MCP processes** (#54): added SIGHUP handler and stdin-close detection to the wrapper.
- **`exclude.txt` ignored at sync time** (#38): now honored by sync and verify commands.
- **Bundled file-discovery and path fixes** (#42, #50, #57, #62, #68, #70, #72): sidechain filtering in search, SessionStart `clear` matcher, `CLAUDE_CONFIG_DIR` support, recursive subagent file discovery, support for both `~/.claude/projects` and `~/.claude/transcripts`, and explicit surfacing of summarization failures.

### Documentation
- Fix npm install instructions to use the GitHub source (#71).

## [1.0.15] - 2025-12-17

### Changed
- **Stop shipping package-lock.json**: Removed from git tracking so npm generates platform-appropriate lockfile on install
- **Remove file deletion from MCP wrapper**: No longer deletes package-lock.json on first run (unnecessary without shipped lockfile)

## [1.0.14] - 2025-12-16

### Fixed
- **Windows spawn ENOENT error**: Add `shell` option for npx commands on Windows (#36, thanks @andrewcchoi!)
  - On Windows, npx is a .cmd file requiring `shell: true` for spawn() to work
  - Applied fix to `cli/episodic-memory.js` and `cli/index-conversations.js`
  - Resolves plugin initialization failures and silent SessionStart hook failures on Windows
- **Agent conversations polluting search index**: Add exclusion marker to summarizer prompts (#15, thanks @one1zero1one!)
  - Summarizer agent conversations are now properly excluded from indexing
  - Extracted marker to shared constant (`SUMMARIZER_CONTEXT_MARKER`) for maintainability
- **Background sync silently failing**: CLI now uses compiled JS instead of tsx at runtime (#25 root cause, thanks @stromseth for identifying!)
  - `--background` flag on sync command now works correctly
  - Fixes SessionStart hook auto-sync that was silently failing
- **Directory auto-creation**: Config directories are now created automatically (inspired by #18, thanks @gingerbeardman!)
  - `getSuperpowersDir()`, `getArchiveDir()`, `getIndexDir()` now ensure directories exist
  - Prevents errors on fresh installs where directories don't exist yet

### Changed
- **CLI uses compiled JavaScript**: Remove tsx from runtime path
  - All CLI commands now route through `dist/*.js` instead of `npx tsx src/*.ts`
  - Faster startup, lighter runtime dependencies
  - tsx is now dev-only (for tests and development)
  - Obsoletes PR #25 (background sync fix) by fixing root cause
- **CLI architecture cleanup**: Replace bash scripts with Node.js wrappers
  - All CLI entry points (`episodic-memory`, `index-conversations`, `search-conversations`, `mcp-server`) are now Node.js scripts
  - Eliminates bash dependency entirely for full cross-platform support (Windows, NixOS, etc.)
  - SessionStart hook now calls `node cli/episodic-memory.js` directly
  - Added `search-conversations.js` to complete Node.js CLI coverage
  - Obsoletes PRs #29 (pnpm workspace), #11 (env bash), and #17 (shebang fix)

## [1.0.13] - 2025-11-22

### Fixed
- **MCP server startup error**: Fix "Invalid or unexpected token" error when starting MCP server
  - Changed plugin.json to use `cli/mcp-server-wrapper.js` instead of bash script `cli/mcp-server`
  - MCP server configuration was pointing to bash script which was being executed with `node` command
  - Wrapper script properly handles Node.js execution and runs bundled `dist/mcp-server.js`

## [1.0.12] - 2025-11-22

### Changed
- **Skill triggering behavior**: Improved episodic memory skill to trigger at appropriate times
  - Changed from "ALWAYS USE THIS SKILL WHEN STARTING ANY KIND OF WORK" to contextual triggers
  - Now triggers when user asks for approach/decision after exploring code
  - Now triggers when stuck on complex problems after investigating
  - Now triggers for unfamiliar workflows or explicit historical references
  - Prevents premature memory searches before understanding current codebase
  - Empirically tested with subagents: 5/5 scenarios passed vs 3/5 with previous description

## [1.0.11] - 2025-11-20

### Fixed
- **Plugin Configuration**: Fix duplicate hooks file error in Claude Code
  - Remove duplicate `"hooks": "./hooks/hooks.json"` reference from plugin.json
  - Claude Code automatically loads hooks/hooks.json, so manifest should only reference additional hook files
  - Update MCP server reference from obsolete `mcp-server-wrapper.js` to direct `mcp-server` script

### Changed
- Simplified plugin.json configuration for cleaner Claude Code integration

## [1.0.10] - 2025-11-20

### Fixed
- **Search result formatting**: Prevent Claude's Read tool 256KB limit failures
  - Search results now include file metadata (size in KB, total line count)
  - Changed from verbose 3-line format to clean 1-line: "Lines 10-25 in /path/file.jsonl (295.7KB, 1247 lines)"
  - Removes prescriptive MCP tool instructions, trusting Claude to choose correct tool based on file size
  - Eliminates issue where episodic memory search triggered built-in Read tool instead of specialized MCP read tool

### Changed
- Enhanced `formatResults()` and `formatMultiConceptResults()` with async file metadata collection
- Added efficient streaming line counting and file size utilities
- Updated MCP server and CLI callers to handle async formatting functions

## [1.0.9] - 2025-10-31

### Removed
- **Dead code cleanup**: Removed obsolete bash script `cli/mcp-server-wrapper`
  - Eliminates duplicate wrapper implementations
  - Only Node.js cross-platform wrapper `mcp-server-wrapper.js` remains
  - Prevents confusion about which wrapper to use
  - Cleaner codebase with single MCP server entry point

### Changed
- Simplified MCP server architecture with single wrapper implementation
- Improved maintainability by removing redundant bash script

## [1.0.8] - 2025-10-31

### Fixed
- **Issue #7**: Fixed Windows support for MCP server provided in plugin
  - Replaced bash script `mcp-server-wrapper` with cross-platform Node.js version
  - MCP server now works on Windows with Claude Code native install
  - Resolves "No such file or directory" errors on Windows when using `/bin/bash`

### Changed
- MCP server wrapper now uses `node cli/mcp-server-wrapper.js` instead of bash script
- Cross-platform dependency installation with proper Windows npm.cmd handling
- Improved signal forwarding and process management in wrapper

### Added
- Cross-platform Node.js wrapper script for MCP server initialization
- Better error handling and messaging for missing dependencies
- Windows-compatible npm command detection (`npm.cmd` vs `npm`)

## [1.0.7] - 2025-10-31

### Fixed
- **Issue #10**: Fixed SessionStart hook configuration that prevented memory sync from running
  - Removed invalid `args` property from hook configuration
  - Added `async: true` and `--background` flag to prevent blocking Claude startup
- **Issue #5**: Fixed summary generation failure during sync command
  - Resolved confusion between archived conversation IDs and active session IDs
  - Sync now properly generates summaries for archived conversations
- **Issue #9**: Fixed better-sqlite3 Node.js version compatibility issues
  - Added postinstall script to automatically rebuild native modules
  - Resolves NODE_MODULE_VERSION mismatch errors on Node.js v25+
- **Issue #8**: Fixed version mismatch between git tags and marketplace.json
  - Synchronized plugin version metadata with release tags

### Added
- Background sync mode with `--background` flag for non-blocking operation
- Automatic native module rebuilding for cross-Node.js version compatibility
- Enhanced CLI help documentation with background mode usage examples

### Changed
- SessionStart hook now uses `episodic-memory sync --background` for instant startup
- Sync command forks to background process when `--background` flag is used
- Improved hook configuration follows Claude Code hook specification exactly
- Updated marketplace.json versions in both embedded and superpowers-marketplace locations

### Security
- Fixed potential process blocking during Claude Code startup
- Improved process detachment for background operations

## [1.0.6] - 2025-10-27

### Fixed
- **Issue #1**: Fixed Windows CLI execution failure by replacing bash scripts with cross-platform Node.js implementation
- **Issue #4**: Fixed sqlite-vec extension loading error on macOS ARM64 and Linux by adding `--external:sqlite-vec` to esbuild configuration
- Resolved "Loadable extension for sqlite-vec not found" error on affected platforms

### Added
- Cross-platform CLI support using Node.js instead of bash scripts
- Enhanced error handling with clear error messages and troubleshooting guidance
- Automatic dependency validation (npx, tsx) in CLI tools
- Proper symlink resolution for npm link and global installations

### Changed
- CLI entry points now use `.js` extension for universal compatibility
- Replaced `shell: true` spawn calls with direct spawn for improved security
- Updated build configuration to externalize sqlite-vec native module
- Improved process execution without shell interpretation to prevent command injection

### Security
- Removed shell dependencies from CLI execution
- Added input validation and protection against command injection vulnerabilities
- Safer process execution using direct spawn calls

## [1.0.5] - 2025-10-25

### Fixed
- MCP server wrapper now deletes package-lock.json before npm install to ensure platform-specific sqlite-vec packages are installed
- Resolves "Loadable extension for sqlite-vec not found" error on fresh plugin installs

### Changed
- Add package-lock.json to .gitignore to prevent cross-platform optional dependency issues
- Improve wrapper script to handle npm's platform-specific optional dependency installation behavior

## [1.0.4] - 2025-10-23

### Changed
- Strengthen agent and MCP tool descriptions to emphasize memory restoration
- Use empowering "this restores it" framing instead of deficit-focused language
- Make it crystal clear the tool provides cross-session memory and should be used before every task

## [1.0.3] - 2025-10-23

### Fixed
- MCP server now automatically installs npm dependencies on first startup via wrapper script
- Resolves "Cannot find module" errors for @modelcontextprotocol/sdk and native dependencies

### Added
- MCP server wrapper script (`cli/mcp-server-wrapper`) that auto-installs dependencies before starting
- esbuild bundling for MCP server to reduce dependency load time

### Changed
- MCP server now uses wrapper script instead of direct node execution
- Removed SessionStart ensure-dependencies hook (no longer needed)

### Removed
- `cli/ensure-dependencies` script (replaced by MCP server wrapper)

## [1.0.2] - 2025-10-23

### Fixed
- Pre-build and commit dist/ directory to avoid MCP server startup errors
- Remove dist/ from .gitignore to ensure built files are available after plugin install

### Changed
- Built JavaScript files now tracked in git for immediate plugin availability

## [1.0.1] - 2025-10-23

### Added
- Automatic dependency installation on plugin install via SessionStart hook
- `ensure-dependencies` script that checks and installs npm dependencies when needed

### Changed
- Plugin installation now automatically runs `npm install` if `node_modules` is missing
- Improved first-time plugin installation experience

### Fixed
- Plugin dependencies not being installed automatically after plugin installation

## [1.0.0] - 2025-10-14

### Added
- Initial release of episodic-memory
- Semantic search for Claude Code conversations
- MCP server integration for Claude Code
- Automatic session-end indexing via plugin hooks
- Multi-concept AND search for finding conversations matching all terms
- Unified CLI with commands: sync, search, show, stats, index
- Support for excluding conversations from indexing via DO NOT INDEX marker
- Comprehensive metadata tracking (session ID, git branch, thinking level, etc.)
- Both vector (semantic) and text (exact match) search modes
- Conversation display with markdown and HTML output formats
- Database verification and repair tools
- Full test suite with 71 tests

### Features
- **Search Modes**: Vector search, text search, or combined
- **Automatic Indexing**: SessionStart hook runs sync automatically
- **Privacy**: Exclude sensitive conversations from search index
- **Offline**: Uses local Transformers.js for embeddings (no API calls)
- **Fast**: SQLite with sqlite-vec for efficient similarity search
- **Rich Metadata**: Tracks project, date, git branch, Claude version, and more

### Components
- Core TypeScript library for indexing and searching
- CLI tools for manual operations
- MCP server for Claude Code integration
- Automatic search agent that triggers on relevant queries
- SessionStart hook for dependency installation and sync


