# Architecture

## Purpose and shape

`episodic-memory` is a plugin for coding agents. It turns the transcripts that agent sessions leave on disk into a searchable local store. The store has three layers that depend on each other in one direction only.

1. **The archive.** A copy of each source transcript (`.jsonl`) and, optionally, a text summary next to it.
2. **The index.** A SQLite database that holds one row per user-and-assistant exchange, a full-text index, and a vector index.
3. **The derived layers.** A digest of recent sessions and a store of learned skills. Both read the index and the archive. Neither one writes to them.

Three kinds of process use these layers.

| Process | Lifetime | Examples |
|---|---|---|
| MCP server | One per agent session. Speaks JSON-RPC on stdio. | `src/mcp-server.ts` |
| Command | Short. Starts, does work, exits. | `sync`, `search`, `show`, `stats`, `doctor`, `backfill`, `learn` |
| Hook | Short. Runs when the host starts a session. | `cli/sync-hook.js`, `cli/digest-hook.js` |

## Design principles

- **Local first.** Transcripts, the index and the embeddings stay on the machine. The embedding model runs in process. A remote call happens only for summaries, digests and learning, and the user can route those calls to a local Ollama server.
- **The hot path stays light.** A hook or a command that may exit early imports only small modules first. It loads the native stack (SQLite, the embedding runtime, the agent SDK) after it knows that it has work to do.
- **The MCP server never writes to stdout.** Standard output carries the JSON-RPC stream. Every module that the server can reach logs to standard error.
- **Derived data is additive.** The index and the archive are the source of truth. Digest entries are never deleted, and learned entries are retired, not removed.
- **Features are opt-in and cost nothing when off.** A flag-off server does not open the knowledge store and does not import the learning code.
- **A guard prevents recursion.** The summarizer starts a child agent process, and that child fires the session-start hook. An environment variable marks the child, and the sync command exits at once when it sees the mark.

## Layers of the source

The dependency direction runs from the entry points down to the leaf utilities.

```
cli/*.js shims  ──►  dist/*-cli.js  ──►  sync / indexer / search / show / stats / doctor / backfill / learn
                                          │
MCP server ──► mcp-tools ──► search, show, digest-tool, learn/skills-tool
                                          │
                       db, embeddings, parser, summarizer, ollama-backend
                                          │
        paths, constants, redact, lockfile, reentrancy, node-floor, gpu-reservation (leaf modules)
```

Leaf modules import nothing from the repository, or import only each other. Several of them state this in their header comment on purpose (`reentrancy`, `node-floor`, `deps-health`, `learn/learn-config`, `learn/pii-redactor`). A caller can then import a leaf before the heavy stack loads.

## Key design decisions

### Decision: Store exchanges in SQLite with a vector table and a full-text table

**Rationale.** One file holds the rows, the vector index (`vec_exchanges`, 384 dimensions) and the full-text index (`exchanges_fts`). A search can run the vector query, the text query, or both, and join to the same row by `id`. A single local file needs no server.

**Trade-offs.** The vector index applies its nearest-neighbour step before any `WHERE` filter. When a filter is active, search asks for three times the requested number of candidates and trims afterwards. A very selective filter can still return fewer results than the limit.

### Decision: Version the embedding pipeline

**Rationale.** Search quality depends on query vectors and stored vectors coming from the same pipeline. Each row records an `embedding_version`. The sync flow finds stale rows and re-embeds them in batches behind a lock. A change to the model, the data type, the prefix, the pooling or the truncation must change the version constant, so that every install re-embeds.

**Trade-offs.** A version bump makes the next sync do extra work on large archives. A silent pipeline change instead would degrade results with no signal.

### Decision: Add a query prefix on the query side only

**Rationale.** The embedding model (`bge-small-en-v1.5`) was trained with a task prefix on queries and no prefix on passages. `generateQueryEmbedding` adds the prefix. The exchange embedders do not.

**Trade-offs.** Callers must use the right function. The function names carry the difference.

### Decision: Confine the `read` tool to the archive

**Rationale.** The MCP `read` tool accepts a path from the model. A prompt-injected path could otherwise read any file. `archive-path.ts` resolves the path and accepts it only when it lies inside the archive directory and ends in `.jsonl`. Summary paths go through the same check.

**Trade-offs.** Callers cannot read a transcript outside the archive. They must sync it first.

### Decision: Optional token on every MCP call

**Rationale.** The MCP protocol has no scopes. When `EPISODIC_MEMORY_MCP_TOKEN` is set, each call must carry a matching `auth_token`, compared in constant time. When the variable is unset, the single-user stdio behaviour is unchanged.

**Trade-offs.** The token travels in the tool arguments, so the model sees it. The control limits other local processes and hosts, not the model.

### Decision: Redact on the way in and on the way out

**Rationale.** Secret redaction is opt-in (`EPISODIC_MEMORY_REDACT_SECRETS`). The setting covers indexed text and returned text. Learned text has stronger rules. A PII redactor cleans it. An injection screen checks it. A citation gate rejects model-written text that does not cite real exchange ids.

**Trade-offs.** Redaction patterns miss unknown secret formats. The opt-in default keeps indexing faithful to the source.

### Decision: Keep the learned-knowledge feature behind a flag and a lazy import

**Rationale.** `mcp-tools.ts` calls `learnEnabled()` from a module that imports nothing, and imports the skills tool only after the flag is on. A session that never asks for a skill pays no load cost and never opens the knowledge store.

**Trade-offs.** The set of modules that load eagerly must stay small. Moving a heavy module to a static import breaks the guarantee.

### Decision: Learn with a train and test split

`LEARN.md` describes the whole feature. This decision records the reason for its main design choices.
, additive changes and a call budget

**Rationale.** A learning run solves practice tasks, finds failures, proposes edits, and validates each edit against the tasks. The test split is solved once, at the end, with the final snapshot. The loop stops when a round keeps nothing, when the round limit is reached, or when the call budget is spent. Nothing deletes an entry, a task or an attempt.

**Trade-offs.** A run costs model calls. One global semaphore bounds the number of agent subprocesses.

### Decision: Share the GPU politely

**Rationale.** A fleet reservation file can mark the shared GPU as busy. Commands that would load a local model check it first and defer instead of failing. Background workers lower their process priority.

**Trade-offs.** A deferred run does nothing until the next trigger.

## Trust boundaries

| Boundary | Input from | Control |
|---|---|---|
| MCP tool arguments | The model, possibly prompt-injected | Strict Zod schemas, archive confinement, optional token |
| Transcript text | Past sessions | Marker-based exclusion of summarizer conversations, optional redaction |
| Summarizer API base URL | Environment | `api-endpoint.ts` validates the URL |
| Learned text | Model output | PII redactor, injection screen, citation gate |
| Child agent processes | The SDK | Reentrancy guard, orphan reaper, semaphore |

## Verification

Generated by `repo-tools map`.
Regenerate: `repo-tools map . --out=<dir>` · Check: `repo-tools check . --docs=docs/architecture`

| Claim | Value | Source |
|---|---|---|
| totalSourceFiles | 252 | repo-tools map |
| totalModules | 4 | repo-tools map |
| runtimeCircularDeps | 0 | repo-tools map |

The vector dimension (384) and the model name come from a direct reading of `src/db.ts` and `src/embeddings.ts`. They are not `repo-tools map` metrics.
