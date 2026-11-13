# Overview

## What this repository is

`episodic-memory` gives a coding agent memory across sessions. The plugin reads the transcripts of past Claude Code and Codex sessions, stores them in a local SQLite database, and lets the agent search them. The agent can also read a full past conversation and a short digest of recent sessions. The agent can list skills that the plugin learned from earlier work. When topic memory is on, the agent can also read the topic documents that the plugin keeps for each project.

The package runs on Node.js. Bun is the package manager and the script driver only.

## What the plugin can do

| Capability | Entry point | Needs a model call |
|---|---|---|
| Copy new transcripts into an archive and index them | `sync` command, `SessionStart` hook | Embeddings (local). Summaries (optional). |
| Search past conversations by meaning, by text, or both | `search` MCP tool, `search` command | Local embedding of the query |
| Read a full archived conversation | `read` MCP tool, `show` command | No |
| Read a cited digest of recent sessions | `digest` MCP tool, `SessionStart` hook | Digest writing only |
| List or load learned skills | `skills` MCP tool, `learn` command | Learning runs only |
| Read topic memory documents of a project | `topics` MCP tool | Topic writing only (`EPISODIC_MEMORY_TOPICS=1`) |
| Check the install and the data | `doctor` command, `stats` command | No |
| Summarize old conversations that `sync` cannot reach | `backfill` command | Summaries |

Three features are off by default. They are the digest (`EPISODIC_MEMORY_DIGEST`), the topic memory (`EPISODIC_MEMORY_TOPICS`) and the learned-knowledge feature (`EPISODIC_MEMORY_LEARN`).

## How the repository is laid out

| Area | Path | Role |
|---|---|---|
| Library and server source | `src/` | TypeScript. Compiles to `dist/`. |
| Learned-knowledge feature | `src/learn/` | The feature that turns past sessions into skills. |
| Command shims | `cli/` | Small JavaScript files. Each file imports compiled code from `dist/`. |
| Plugin manifests | `.claude-plugin/`, `hooks/`, `agents/`, `skills/`, `prompts/` | What the host reads to load the plugin. |
| Tests | `test/` | Vitest. The learned-knowledge tests are in `test/learn/`. |
| Build scripts | `scripts/` | Version generation, native rebuild, fixture scrubbing. |
| Compiled output | `dist/` | Committed. Build it after each source change. |

`src/version.ts` is generated from `package.json` and is not tracked by git. Never edit it.

## Key metrics

All figures below come from `repo-tools map` and cover the whole repository. The scope is the whole repository, so test files count as source files.

| Metric | Value | Scope |
|---|---|---|
| Source files | 289 | whole repository |
| Lines of code | 57299 | whole repository |
| Exports | 611 | whole repository |
| Modules (areas) | 4 | `src`, `tools`, `tests`, `config` |
| Entry roots | 6 | `src/index.ts`, `src/node-floor.ts`, `src/index-cli.ts`, `src/mcp-server.ts`, `test/setup-env.ts`, `test/global-setup.ts` (vitest loads the two test files by their paths in `vitest.config.ts`) |
| Runtime circular dependencies | 0 | whole repository |
| Type-only circular dependencies | 1 | whole repository |

Files per area, from `file-inventory.json`: `src` 109, `tests` 175, `tools` 4, `config` 1.

## Reading the reachability counts

The graph parser follows static imports. The parser does not follow four links that exist at run time.

1. The shims in `cli/` import from `dist/`, not from `src/`. The parser sees no edge from `cli/` to `src/`.
2. The command files `src/*-cli.ts` (`sync-cli`, `search-cli`, `show-cli`, `stats-cli`, `doctor-cli`, `backfill-cli`, `learn-cli`) run as separate processes. The shims start them. No `src` file imports them.
3. `package.json` names four `bin` entries. Two of them (`./cli/search-conversations`, `./cli/mcp-server`) have no file extension, and `repo-tools map` cannot resolve them to a file. The parser therefore sees no importer of `cli/forward-child.js` except `cli/search-conversations.js`, which is an orphan too.
4. The `onnxruntime-web` override of `package.json` points the installer at `vendor/onnxruntime-web-stub`. No source file imports the stub. Only `test/onnxruntime-web-stub.test.ts` loads the stub.

The result is 15 files that the map reports as orphaned and 61 as dormant. Most of them are live. The map is correct about the static graph. The map cannot see the process boundaries. Do not delete a file only because the map lists it. Read `unused-analysis.md` and confirm with a search first.

## Where to read next

- `ARCHITECTURE.md` explains the design and its reasons.
- `COMPONENTS.md` describes each module.
- `LEARN.md` describes the learned-knowledge feature in `src/learn/`: its model, storage, safety pipeline, learning loop and every module.
- `DATAFLOW.md` traces a request from start to end.
- `API.md` lists the public surface.
- `FILE_INVENTORY.md`, `TEST_COVERAGE.md`, `DEPENDENCY_GRAPH.md`, `unused-analysis.md` and `duplicate-symbols.md` are generated by `repo-tools map`.

## Verification

Generated by `repo-tools map`.
Regenerate: `repo-tools map . --out=<dir>` · Check: `repo-tools check . --docs=docs/architecture`

| Claim | Value | Source |
|---|---|---|
| totalSourceFiles | 289 | repo-tools map |
| totalLinesOfCode | 57299 | repo-tools map |
| totalExports | 611 | repo-tools map |
| totalModules | 4 | repo-tools map |
| entryRoots | 6 | repo-tools map |
| orphanedFiles | 15 | repo-tools map |
| dormantFiles | 60 | repo-tools map |
| runtimeCircularDeps | 0 | repo-tools map |
| typeOnlyCircularDeps | 1 | repo-tools map |
