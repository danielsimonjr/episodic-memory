# Data flow

This document traces each main operation from its trigger to its result. Module names are relative to `src/` unless a path starts with `cli/`.

## 1. Session start

The host fires the session-start event. `hooks/hooks.json` runs two commands, in this order.

1. `cli/sync-hook.js` checks the dependency health (`deps-health`). It ends leftover summarizer processes (`orphan-reaper` and the PIDs that `learn/learn-lock` records). It checks the GPU reservation when a local backend is selected. Then it starts `episodic-memory sync --background` as a detached child and returns at once. A spawn failure goes to the hook log (`logging`).
2. `cli/digest-hook.js` imports only the digest and learned-block modules. The hook opens the database and builds the digest text for the current project (`digest-inject`). The hook adds the learned block (`learn/learn-inject`) and prints both for the host to inject. The hook never opens the knowledge store.

The hook returns before the background sync does its work. The session never waits for indexing.

## 2. Sync and index

`sync-cli` runs in the detached child.

```
sync-cli
  ├─ shouldSkipReentrantSync()          exit at once when the guard variable is set
  ├─ lockfile                            one sync at a time
  ├─ import db, embeddings, migration    only now: the native stack loads
  ├─ syncConversations(source, archive)
  │    ├─ for each source project folder (Claude and Codex directories)
  │    │    skip excluded projects and summarizer conversations
  │    ├─ copyIfNewer(src, archive)      copy a transcript only when it is newer
  │    └─ queue: files to index, files that need a summary
  ├─ index queued files
  │    parser.parseConversationFile      transcript → exchanges
  │    embeddings.generateExchangeEmbeddings
  │    db insert                         exchanges, tool_calls, vec_exchanges, FTS
  ├─ summarize queued files (bounded)    summarizer → <name>-summary.txt
  ├─ embedding-migration                 re-embed rows with an old embedding_version
  ├─ digest-phase                        digest step; never throws, sync waits for it
  └─ topic-phase                         topic step; never throws; runs only when EPISODIC_MEMORY_TOPICS=1
```

Key points:

- **Idempotence.** A file that has not changed is skipped. A summary file that exists blocks a new summary unless it is empty and has no recorded reason.
- **Summary ordering.** Fresh work runs first. Retries run next. Legacy empty summaries run last, so a large backlog cannot flood the summarizer.
- **Failure records.** A failed summary writes a record next to the file with the attempt count and the last error. A terminal record stops further retries.
- **Backlog.** `backfill` runs the same summarizer on archive files that `sync` never queues.

## 3. Search

The `search` tool and the `search` command share `search.searchConversations`.

```
input (query, mode, limit, dates, project, session, branch)
  ├─ validate dates
  ├─ build SQL filters
  ├─ mode vector or both:
  │    initEmbeddings → generateQueryEmbedding (adds the query prefix)
  │    KNN over vec_exchanges, k = limit (x3 when a metadata filter is active)
  │    join exchanges, drop sidechain rows, apply filters
  ├─ mode text or both:
  │    FTS5 MATCH over exchanges_fts, each word quoted (falls back to LIKE, one condition per word, on an error)
  │    newest first, limit
  ├─ mode both: append text hits whose id the vector step did not return
  └─ for each row: build snippet, load the summary if it lies inside the archive,
     convert L2 distance to a similarity score
```

Multi-concept search (two to five concepts) calls `searchMultipleConcepts` and returns exchanges that match every concept. The MCP tool then formats the result as markdown or JSON.

## 4. MCP tool call

```
agent ── JSON-RPC (stdio) ──► mcp-server
                               ├─ Zod parse with a strict schema     reject unknown fields
                               └─► mcp-tools.dispatch
                                    ├─ assertMcpAuthorized             token check when configured
                                    ├─ search  → search.*
                                    ├─ read    → archive-path confinement → show.formatConversationAs*
                                    ├─ digest  → digest-tool
                                    ├─ skills  → learnEnabled()? → import skills-tool → knowledge store
                                    └─ topics  → import topic-tool → topic-db (read-only index)
```

The `read` tool resolves the path. The path must lie inside the archive and end in `.jsonl`. The tool caps the bytes it returns and renders the requested line range. A rejected path returns an error and reads nothing.

## 5. Digest

`digest-phase` runs at the end of a sync when `EPISODIC_MEMORY_DIGEST` is on.

1. `digest-job` finds sessions that have been quiet for 30 minutes and have no digest entry. It processes a bounded number per run.
2. `digest-prompts` builds the prompt with per-exchange and total caps.
3. The model call goes through `summarizer.callDigestModel`, or through Ollama when selected. A GPU reservation defers the job and is not a failure.
4. `digest-validate` keeps only lines that cite real exchange ids, rewrites the marks to `[#id,#id]`, and redacts the text.
5. `digest-db.insertDigestEntry` stores the entry.
6. `digest-compress` folds past days, and then weeks, into one entry each and sets `superseded_by` on the replaced entries.

Reading goes the other way. `digest-inject` builds the text for the hook. `digest-tool` serves the `digest` tool, either as the current digest or as a full-text query over `digest_fts`.

## 6. Learning run

`learn improve` runs the loop below. `learn-cli` first applies the early exits: the guard, the flag, the GPU reservation, and the priority.

```
learn-lock             one run at a time; records child PIDs
bootstrap              map the archive's projects; propose the first knowledge
loop (rounds):
  tasks                generate practice tasks from the archive; check staleness
  solver (x agent-runner subprocess, bounded by the semaphore)
                       solve every train task with the current snapshot
  grade                grade answers by rule against each task's truth
  split failures       by project, then by failure category if still too large
  leaf-learner (parallel)   diagnose failures, propose edits
  knowledge-gate       citations, injection screen, PII redaction on every proposal
  validate             keep an edit only when it earns its place on the tasks
  merge                combine entries that two children both kept; re-solve a sample;
                       revert a child whose gain regresses
  reflect              one screened reflection per round
stop on: nothing kept, round limit, call budget
final: solve the test split once with the final snapshot
```

Under the default approval mode, instruction entries stay `candidate` because they load into every session. `learn approve` shows the entry, its validation record and a diff. It refuses an entry with no measurement, with a recorded regression, or with a lower pass count. Then the command activates the entry. `learned-block` then renders the active entries for each project and one shared row, and stores the result in `learning.sqlite`. The session-start hook reads that stored block. `learn export` writes the active skills as a tree of `SKILL.md` files.

## 7. Embedding migration

1. Each row stores the `embedding_version` of the pipeline that made its vector.
2. `embedding-migration` selects rows with a version below `EMBEDDING_VERSION`, in batches.
3. It takes a lock file first, so two processes never migrate at once.
4. It embeds the batch again, writes the new vectors, and stamps the new version.

New rows carry the current version from the start.

## Verification

Generated by `repo-tools map`.
Regenerate: `repo-tools map . --out=<dir>` · Check: `repo-tools check . --docs=docs/architecture`

| Claim | Value | Source |
|---|---|---|
| totalSourceFiles | 279 | repo-tools map |
| runtimeCircularDeps | 0 | repo-tools map |

The step orders above come from a direct reading of `src/sync.ts`, `src/search.ts`, `src/digest-job.ts`, `src/learn/learner.ts` and `cli/sync-hook.js`. They are not `repo-tools map` metrics.
