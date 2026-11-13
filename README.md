# Episodic Memory

Semantic search for Claude Code and Codex conversations. Remember past discussions, decisions, and patterns.

## Testimonial

> From an AI coding assistant's perspective:
>
> Episodic memory fundamentally changes how I collaborate with
> developers on complex codebases. Instead of treating each conversation
> as isolated, I can now search our shared history semantically -
> finding not just what was discussed, but why decisions were made.
>
> When a developer asks me to implement something "like we did with
> X," I can search our past conversations, find the relevant discussion,
> and understand both the technical approach and the reasoning behind
> it. This means I don't have to re-explain architectural patterns,
> and I avoid suggesting solutions we've already tried and rejected.
>
> The semantic search is crucial - searching for "provider catalog"
> surfaces conversations about API design patterns even when those
> exact words weren't used. It captures the meaning of our discussions,
> not just keyword matches.
>
> Most valuable is that it preserves context that lives nowhere else:
> the trade-offs discussed, the alternatives considered, the user's
> preferences and constraints. Code comments explain what, documentation
> explains how, but episodic memory preserves why - and that makes
> me a far more effective collaborator across sessions.
>
> **Concrete impact:**
>  - Faster problem-solving (minutes vs. exploring/re-learning the
>  codebase) - Better continuity across sessions (I remember what we
>  tried before) - More informed suggestions (I understand the project's
>  evolution and patterns) - Less repetition (both of us spend less
>  time re-explaining context)

It's the difference between being a stateless tool and being a true
collaborative partner who remembers our journey together.

_— Claude Sonnet 4.5, October 14, 2025_
_Conversation ID: 216ad284-c782-45a4-b2ce-36775cdb5a6c_

## Installation

**Requirements:** Node 22 or newer, the floor `better-sqlite3` 13 declares. On an older Node, the MCP server wrapper and the `learn` command print one line and exit instead of failing inside a dependency. Bun 1.4+ is only needed for development. There is no other native or model dependency beyond the ones every install already has: the learned knowledge store is a plain SQLite file.

This repository is the fork `danielsimonjr/episodic-memory`, which carries the self-improving memory feature. The install commands below are the upstream ones. A fork install uses the `episodic-memory@local-marketplace` plugin instead.

### As a Claude Code plugin (Recommended)

The plugin provides MCP server integration, automatic session-end indexing, and seamless access to your conversation history.

```bash
# In Claude Code
/plugin install episodic-memory@superpowers-marketplace
```

The plugin automatically:
- Indexes conversations at the end of each session
- Exposes MCP tools for searching and viewing conversations
- Makes your conversation history searchable via natural language
- Loads a short, cited block of learned hints at session start when self-improving memory is turned on

### As a Codex plugin

This repository includes a Codex plugin manifest at `.codex-plugin/plugin.json`.
Codex support requires `codex-cli 0.130.0` or newer.

For local testing, build the plugin, add this repo as a local marketplace, then
install/enable it from `/plugins`:

```bash
bun run build
codex features enable plugin_hooks
codex plugin marketplace add /path/to/episodic-memory
```

Then start Codex, open `/plugins`, install and enable `episodic-memory` from
`Episodic Memory Dev`, open `/hooks`, review the Episodic Memory hook, and press
`t` to trust it.

The Codex plugin:
- Syncs conversations from `~/.codex/sessions`
- Exposes the same MCP search/read tools
- Installs the same memory skill, with Codex-specific direct MCP guidance
- Runs a `SessionStart` hook after the user reviews and trusts it in `/hooks`

Enable plugin hooks before relying on automatic sync:

```bash
codex features enable plugin_hooks
```

Then open `/hooks` in Codex, review the Episodic Memory hook, and press `t` to trust it. New or modified Codex hooks are listed but do not run until trusted.

See [docs/CODEX.md](docs/CODEX.md) for the full Codex setup, trust, troubleshooting, and E2E test workflow.

### As an npm package

```bash
npm install -g github:obra/episodic-memory
```

## Usage

### Quick Start

```bash
# Sync conversations from Claude Code and Codex and index them
episodic-memory sync

# Search your conversation history
episodic-memory search "React Router authentication"

# View index statistics
episodic-memory stats

# Diagnose Codex setup
episodic-memory doctor codex

# Check learned-memory state (needs EPISODIC_MEMORY_LEARN=1)
episodic-memory learn status

# Display a conversation
episodic-memory show path/to/conversation.jsonl
```

### Command Line

```bash
# Unified command interface
episodic-memory <command> [options]

# Sync and index new conversations
episodic-memory sync

# Index conversations manually
episodic-memory index --cleanup

# Search conversations
episodic-memory search "React Router authentication"
episodic-memory search --text "exact phrase"
episodic-memory search --after 2025-09-01 "refactoring"

# Display a conversation in readable format
episodic-memory show path/to/conversation.jsonl
episodic-memory show --format html conversation.jsonl > output.html

# View statistics
episodic-memory stats

# Self-improving memory (off unless EPISODIC_MEMORY_LEARN=1)
episodic-memory learn status
episodic-memory learn render --project my-project   # what a session in my-project will be shown
episodic-memory learn --help
```

### Legacy Commands

The original commands are still available for backward compatibility:

```bash
episodic-memory-index
episodic-memory-search "query"
```

### In Claude Code or Codex

The plugin automatically syncs and indexes conversations from the harness that starts it. Reference past work in natural conversation — the `remembering-conversations` skill dispatches the `search-conversations` agent automatically when recall is needed. Example prompts:

- "How did we handle authentication in React Router?"
- "The conversation about async testing patterns"
- "Error message about sqlite-vec initialization"
- "Git commit SHA for the routing refactor"

When `EPISODIC_MEMORY_LEARN=1` is set and a learning run has created `learned/learning.sqlite`, a session starts with a fenced "learned hints" block. It gives instructions on where to look, plus an index of learned skills. The search agent loads a matching skill with the `skills` tool before it searches. See [Self-improving memory](#self-improving-memory-recursa).

In Codex, the skill guides the agent to use the episodic-memory MCP search/read tools directly when an agent-dispatch path is not available.

## API Configuration

By default, episodic-memory uses your Claude Code authentication for Claude Code summarization. Codex-indexed sessions with a session ID are summarized through `codex app-server`. The summarizer creates an ephemeral `thread/fork`. The summary can then use Codex session context and reasoning summaries, and nothing is appended to the original rollout.

To route summarization through a custom Anthropic-compatible endpoint or override the model:

```bash
# Override model (default: haiku)
export EPISODIC_MEMORY_API_MODEL=opus

# Override fallback model on error (default: sonnet)
export EPISODIC_MEMORY_API_MODEL_FALLBACK=sonnet

# Route through custom endpoint
export EPISODIC_MEMORY_API_BASE_URL=https://your-endpoint.com/api/anthropic
export EPISODIC_MEMORY_API_TOKEN=your-token

# Increase timeout for slow endpoints (milliseconds)
export EPISODIC_MEMORY_API_TIMEOUT_MS=3000000

# Override Codex binary path if needed (default: codex)
export EPISODIC_MEMORY_CODEX_BIN=/path/to/codex

# Codex summary model (default: the model of the Codex configuration)
export EPISODIC_MEMORY_CODEX_MODEL=gpt-5.5
```

These settings only affect episodic-memory's summarization calls, not your interactive Claude Code or Codex sessions.

When a Claude summary call fails, the failure record keeps the status and the first 300 characters of the error text. Secrets in the text are redacted. A failed Claude Code login (HTTP 401, for example an expired OAuth token) defers the summaries, the digest, the topic job and the backfill. These steps stop at the first failed call and count no attempt, so the queue waits for the next run. Run `claude auth login` to sign in again. On the Ollama backend, a failed login of the Claude fallback counts as no fallback, and the Ollama error stands.

Codex summarization requires `codex-cli 0.130.0` or newer. If Codex app-server summarization is unavailable, sync logs the reason and falls back to transcript-text summarization.

### Claude Code executable (opt-in)

The Claude Agent SDK starts a Claude Code binary for summaries and for the learn agent. By default, the binary comes from the SDK platform package, for example `@anthropic-ai/claude-agent-sdk-win32-x64` (269 MB on Windows x64). A host that already has Claude Code can name its binary instead and drop that package:

```bash
export EPISODIC_MEMORY_CLAUDE_BIN=/absolute/path/to/claude   # claude.exe on Windows
```

- The path must be absolute. The variable has no PATH lookup. The plugin refuses a `.cmd`, `.bat` or `.ps1` shim. A `.js` or `.mjs` file runs under node.
- The plugin runs `<path> --version` once per process. The version must be at or above the version of the bundled binary, which the SDK `manifest.json` records. An older Claude Code binary can delete session records, so the floor is mandatory.
- When the check passes, the plugin removes the platform packages from its `node_modules` at its next start. The SDK package itself stays.
- When no usable binary exists, the summaries, the digest, the topic job and the backfill defer. These steps count no attempt and write no failure record, so the plugin loses no data. Each reason goes to stderr once. The learn commands that start Claude Code exit 1 before they start a run.
- Set the variable in a place that every process inherits: the User environment variable on Windows, or the shell profile elsewhere. The Claude Code `env` setting reaches the MCP server and the hooks, but not a scheduled sync task.
- To roll back, remove the variable first. Then run `npm install --omit=dev --no-audit --no-fund` in the plugin root. The install restores the platform package.

### Local-model summarization (Ollama)

Set the backend to `ollama` to summarize with a local model instead of billed API calls:

```bash
export EPISODIC_MEMORY_SUMMARIZER_BACKEND=ollama
export EPISODIC_MEMORY_OLLAMA_MODEL=qwen3.8:27b        # required; no default
export EPISODIC_MEMORY_OLLAMA_URL=http://localhost:11434 # default
```

- The model is required. A shared Ollama host holds one model, so a default would evict another client's model.
- Plain `http` is accepted only for localhost. To use a model on another machine, tunnel it: `ssh -N -L 11434:localhost:11434 <host>`.
- Prompts are cut to `EPISODIC_MEMORY_OLLAMA_MAX_PROMPT_CHARS` (default 24000).
- `EPISODIC_MEMORY_OLLAMA_FALLBACK_MODEL` names a Claude model (for example `haiku`) for one retry when an Ollama call fails. The retry covers summaries, the digest and text-only learning calls. When the variable is unset, the Ollama error propagates. A GPU reservation never falls back: it defers the work.
- The backend waits while another agent holds the shared GPU. The fleet reservation file names the holder. The `FLEET_GPU_RESERVATION` variable sets its path. The package has no default path. When the variable is unset, the GPU counts as free. While the file names a holder, four things happen. The SessionStart hook skips the sync. A running sync asks for no summary. The archive backfill pauses. The digest writes nothing. The queue stays as it is and no attempt counts. A missing file means the GPU is free. The GPU counts as reserved when the file cannot be read, is not valid JSON, or holds the text `null`. The message then names the cause and the path.

### Backfilling the archive

Sync reads only transcripts whose source file still exists. A pruned conversation keeps no summary. `backfill` summarizes those archived conversations:

```bash
episodic-memory backfill --dry-run          # count candidates
episodic-memory backfill --batch 25         # run; the sync lock is released between batches
```

Backfill selects conversations with no summary, or with an empty summary that no marker explains. It stops when every attempt in a batch fails.

### What's Affected

| Component | Uses custom config? |
|-----------|---------------------|
| Summarization | Yes (up to 10 calls/sync) |
| Embeddings | No (local Transformers.js) |
| Search | No (local SQLite) |
| MCP tools | No |

## Session Digest

An optional digest of earlier sessions loads when a session starts. Every line cites the exchanges it came
from, so a wrong line can be checked against its source. The full index stays the place for exact text.

The digest is off by default. Turn it on with `EPISODIC_MEMORY_DIGEST=1`.

How it works:

1. After each sync, the summarizer writes one `session` entry per finished session. The summarizer uses the same backend and model as session summaries (`haiku` by default). A line without a valid citation is dropped. The text is redacted before it is sent and again before it is stored.
2. A past day with more than 5 session entries merges into one `day` entry. A finished week with more
   than 2 day entries merges into one `week` entry. Merged entries are marked superseded, never deleted.
3. At session start, a hook prints the digest for the current project within the size budget. Handoff notes come first, then the newest entries.

Settings:

| Variable | Default | Meaning |
|---|---|---|
| `EPISODIC_MEMORY_DIGEST` | unset (off) | Set to `1` to write and inject the digest |
| `EPISODIC_MEMORY_DIGEST_MAX_CHARS` | `6000` | Size budget of the injected text |
| `EPISODIC_MEMORY_DIGEST_DAY_CAP` | `5` | Session entries in a past day before they merge |
| `EPISODIC_MEMORY_DIGEST_WEEK_CAP` | `2` | Day entries in a finished week before they merge |
| `EPISODIC_MEMORY_DIGEST_MAX_SESSIONS` | `5` | Sessions summarized per sync run |

The same SessionStart hook also appends a learned-hints block when `EPISODIC_MEMORY_LEARN=1` is set and a learning run has created `<configDir>/learned/learning.sqlite`. Each part has its own flag, so either, both, or neither may print. The hook prints one JSON object.

The `digest` MCP tool shows the digest and searches it (`query`). The tool also turns a `[#id]` mark into an archive path and line range for `read` (`expand`). Last, the tool stores a one-line note for the next session (`handoff`).

## Topic memory

Topic memory keeps a few Markdown documents for each project. Each document groups related facts from past
sessions. Each paragraph cites the exchanges that support it, so a reader can check a statement against its source.

The feature is off by default. Set `EPISODIC_MEMORY_TOPICS=1` to write the documents.

How it works:

1. After the digest step, each `sync` run finds the finished sessions of each project. A session is finished when it has been quiet for 30 minutes. The step skips trivial sessions. It organizes the oldest sessions first.
2. The step sends the session and the current documents to the digest model. The prompt shows in full only the documents that fit the size limit, the most recently updated first. The model answers with the new text of each document that changes. The step refuses an edit to a document that the prompt did not show in full.
3. The step checks the whole edit. When a check fails, the model gets one more try in the same run, with the list of errors. When the second answer fails, the step rejects the session and does not organize the session again. A failed model call, or a fault in the check or the install, leaves the session pending. The next run tries the session again. The step rejects the session after 3 failed calls.
4. The install of an accepted edit runs in one transaction. The transaction writes the text of each document in the edit. A written document replaces the stored document of the same name. The transaction deletes only the documents that the edit names. The code derives the links, the timeline and the search index from the documents. When another run changed a shown document in the meantime, the step discards the edit as stale.

Each session is organized once. Sessions that start before the first run are not organized, unless `EPISODIC_MEMORY_TOPICS_SINCE` sets an earlier time.
The topic step does not need the digest. Its variables apply to the `sync` run, not to the MCP server.

Settings:

| Variable | Default | Meaning |
|---|---|---|
| `EPISODIC_MEMORY_TOPICS` | unset (off) | Set to `1` to write the topic documents during sync |
| `EPISODIC_MEMORY_TOPICS_SINCE` | the first-run time | A time that `Date.parse` reads, for example an ISO time. Replaces the first-run time on the first run only, to organize older sessions. An invalid value gives a warning on stderr, and the first-run time applies |
| `EPISODIC_MEMORY_TOPICS_MAX_SESSIONS` | `3` | Sessions that reach the model in one run |
| `EPISODIC_MEMORY_TOPICS_MAX_TRANSCRIPT_CHARS` | `10000` | Size of the numbered transcript of one session |
| `EPISODIC_MEMORY_TOPICS_MAX_DOCS_CHARS` | `10000` | Size of the document text that one prompt shows |
| `EPISODIC_MEMORY_TOPICS_MAX_DOC_CHARS` | `8000` | Size limit of one document |
| `EPISODIC_MEMORY_TOPICS_MAX_DOCS` | `50` | Number of documents in one project |

An invalid value falls back to the default.

The `topics` MCP tool reads the documents. The tool has five actions:

| Action | Returns |
|---|---|
| `list` | The documents of the project, with the unit count of each |
| `read` | The text of one document |
| `search` | The paragraphs that match the words, with their event times |
| `links` | The links into and out of one paragraph |
| `timeline` | The dated events in time order, with their source exchange ids |

The `topics` tool is read-only. The tool does not check `EPISODIC_MEMORY_TOPICS`. When the index has no topic tables, the tool answers that topic memory has no documents yet. See [`topics`](#topics) under MCP Server.

## Self-improving memory (Recursa)

An optional layer that lets the archive teach the agent how to search it. The layer is off by default.

### What it does

Given your own conversations as the only source material, episodic-memory can:

1. **Write itself practice tasks.** The system samples source exchanges deterministically from a seed. A text model turns each exchange into a `locate`, `recall`, `when` and `multi` question at three difficulty tiers. The answer key is an archive address (path plus line range) and the session's date range. Prompt text is redacted and screened. The answer key never lands in a stored prompt.
2. **Grade its own answers, deterministically.** `locate` scores 1.0 on an overlapping address and 0.5 for the right session. `when` needs the right project and a date inside the session's range. `multi` needs every address. `recall` needs the right location *and* a judge score. 60% of tasks are `train` and 40% are held out as `test`. The split is stratified per project and tier. No learner prompt can read the `test` split. The *signal* set decides whether an edit is kept. The signal set is the `locate`, `when` and `multi` tasks at tiers 2 and 3. Tier 1 and `recall` are reported, and they never gate an edit.
3. **Learn from its failures.** A leaf learner reads the graded failed attempts (addresses, not whole transcripts). The learner proposes at most a few edits through a `propose_entry` tool. The learner validates each edit by re-solving the tasks the edit targets. The learner also re-solves a seeded sample of the tasks that already passed. An edit is kept only when at least one targeted task now passes and no sampled task regresses. Failures that span several projects, or more than 12 tasks, are split into child runs first. Duplicates and conflicting instructions are merged afterwards. A held-out `test` evaluation runs once at the end.
4. **Bootstraps a cold start.** `learn bootstrap` maps each project with at least 20 indexed exchanges. The command reads the digest and samples across its whole time span. The command proposes a navigation skill and exploration notes, then merges them into one global instruction. The candidates are measured before anything is kept. The signal train set is solved twice, once with an empty snapshot and once with the candidates. A candidate is kept only when two conditions hold. The pass rate does not fall. The mean turns or USD per task fall by at least 10%.

What the layer learns lands in three kinds of entry. An **instruction** is always loaded. A **skill** is loaded by choice through the `skills` tool. A **reflection** is a note for later learners. Every entry is grounded in cited exchanges and redacted. An injection filter screens every entry before storage and again on the way out.

### Where it lives

Learned knowledge is durable state next to the index, not inside it:

```
<configDir>/
  conversation-index/   db.sqlite        disposable, rebuildable from the archive
  learned/              knowledge.db     learned entries, citations and learner records (plain SQLite)
                        learning.sqlite  runs, tasks, attempts, rendered hint block
  learned-skills/                        generated SKILL.md export tree
```

`learned/` is a **sibling** of `conversation-index/`, so `episodic-memory index --rebuild`, an index
cleanup, and the `rm -rf conversation-index/` reset recipe cannot reach learned knowledge or the learning
trace. Delete `learned/` only deliberately. Every export rewrites `learned-skills/`, which is generated output.

Both files are ordinary `better-sqlite3` databases with no extra dependency. `knowledge.db` keeps one row per entry version, plus the citations and the learner's own records (heuristics, decisions, failures, reflections, project context). The `skills` tool opens the file read-only. Every `learn` write runs under the database's write lock. A `learn` run in a terminal and an open MCP server therefore never trip over each other. The layout is
documented in [docs/SCHEMA.md](docs/SCHEMA.md).

At session start the hook appends a fenced, size-capped block of learned hints to the digest — but only
when `EPISODIC_MEMORY_LEARN=1` and `learned/learning.sqlite` already exists. With the flag off, hook
output is byte-identical to the digest-only output.

### Turning it on

```bash
export EPISODIC_MEMORY_LEARN=1
episodic-memory learn tasks              # build the practice set from the archive
episodic-memory learn solve --split train   # baseline: how well does it search today?
episodic-memory learn bootstrap          # cold-start skills + a global instruction
episodic-memory learn improve            # the recursive learner, ending in a held-out test
episodic-memory learn report             # what changed, what it cost, what it refused
```

Both `EPISODIC_MEMORY_LEARN` and `EPISODIC_MEMORY_LEARN_MAX_CHARS` are whitelisted in the plugin's
`.mcp.json`, so the MCP server sees the flag and the block budget.

### The `learn` commands

Every command needs `EPISODIC_MEMORY_LEARN=1`; without it each exits 0 and does nothing. Progress goes to
stderr (and to `logs/learn.log`), the report goes to stdout, so `learn report > report.txt` produces a
readable file. One run at a time is enforced by `.learn.lock` in the index directory, and a second
instance names the holder's PID instead of failing blankly.

| Command | What it does |
|---|---|
| `learn tasks [--per-project N] [--seed S] [--check]` | Generate self-practice tasks from the archive. `--check` marks tasks whose source address no longer resolves as `stale` |
| `learn solve [--split train\|test] [--limit N] [--snapshot ID]` | Solve stored tasks and record graded attempts. Default split: `train` |
| `learn bootstrap [--per-project N] [--seed S]` | Map each eligible project, propose navigation skills and exploration notes, merge them into one global instruction, then measure them before keeping anything |
| `learn improve [--rounds N] [--project P] [--dry-run]` | The recursive learner: solve, split failures into leaves, learn and validate per leaf, merge duplicates, reflect, then evaluate the held-out split once. `--dry-run` solves and reports without running any learner |
| `learn status` | The flag, entries by kind and status, candidates awaiting approval, and the latest run |
| `learn report [--run ID] [--json]` | Pass rates before and after, kept and pending entries, rejections with reasons, budget, child runs and reflections. Defaults to the latest run |
| `learn approve <name> [--yes]` | Activate a candidate as ground truth after showing the entry, its validation record and a diff against the version it revises |
| `learn export [--to DIR]` | Write every active skill as `<project>/<slug>/SKILL.md` under `learned-skills/`, replacing that tree. `--to DIR` copies into `DIR` instead and removes nothing there |
| `learn render [--project P]` | Rewrite the learned-hints block the SessionStart hook injects from the entries that are active now, and list each block's size. `--project P` prints that project's block. Every run and approval renders on its own; use this after editing the store by hand or to see what a session will be shown |

### Settings

Every setting is read at call time and ignored when absent, not a positive number, or not in an enum.

| Variable | Default | Meaning |
|---|---|---|
| `EPISODIC_MEMORY_LEARN` | unset (off) | Set to `1` to let the feature read learned state, register a working `skills` tool and run `learn` commands |
| `EPISODIC_MEMORY_LEARN_MODEL` | `sonnet` | Model for every learning call: solver, learner, judge and task generation. Falls back to `EPISODIC_MEMORY_API_MODEL_FALLBACK` (default `sonnet`) on error; the digest and summary models are unaffected |
| `EPISODIC_MEMORY_LEARN_APPROVE` | `instructions` | Approval mode: `instructions` (instructions need `learn approve`; skills activate on validation), `all` (both need approval), `none` (both activate on validation) |
| `EPISODIC_MEMORY_LEARN_MAX_CALLS` | `200` | Subprocess calls per run. The baseline is computed first; a run that cannot afford it refuses to start, and a run that spends past it stops with status `stopped` |
| `EPISODIC_MEMORY_LEARN_MAX_USD` | `5` | USD cap recorded on each run and printed by `learn report` against what was spent. The SDK-level cap per subprocess is fixed at $1 |
| `EPISODIC_MEMORY_LEARN_MAX_MINUTES` | `60` | Wall-clock a real run is expected to fit. Not a hard stop: it is the bound the lock's 2-hour stale timeout is reasoned from |
| `EPISODIC_MEMORY_LEARN_MAX_TASKS` | `120` | Tasks kept when generating a practice set |
| `EPISODIC_MEMORY_LEARN_CONCURRENCY` | `3` | One global subprocess semaphore shared by every level, so depth never multiplies processes |
| `EPISODIC_MEMORY_LEARN_ROUNDS` | `3` | Learner rounds per leaf before the loop gives up |
| `EPISODIC_MEMORY_LEARN_MIN_SAVING` | `10` | Percent by which mean turns or USD per task must fall for a bootstrap candidate to be kept |
| `EPISODIC_MEMORY_LEARN_MIN_GROUNDING` | `3` | Distinct content tokens (4+ characters) a cited line must share with one of its cited exchanges |
| `EPISODIC_MEMORY_LEARN_SOLVER_MAX_TURNS` | `12` | Agent turns per solver subprocess |
| `EPISODIC_MEMORY_LEARN_LEARNER_MAX_TURNS` | `30` | Agent turns per learner subprocess |
| `EPISODIC_MEMORY_LEARN_MAX_CHARS` | `2500` | Size budget of the injected learned-hints block |
| `EPISODIC_MEMORY_LEARN_LEAF_MAX` | `12` | Failed tasks in one leaf before the learner splits by project or failure category |
| `EPISODIC_MEMORY_LEARN_EDITS_PER_ROUND` | `3` | Entries a leaf may propose in one round |
| `EPISODIC_MEMORY_LEARN_VALIDATE_SAMPLE` | `5` | Already-passing tasks re-solved per edit to catch regressions |
| `EPISODIC_MEMORY_LEARN_PID_POLL_MS` | `1000` | Milliseconds between two listings of the agent subprocesses. One listing serves every concurrent agent. The registry keeps the subprocesses safe from the SessionStart orphan reaper. A new subprocess stays unprotected for up to one interval plus one listing. A longer interval widens the unprotected window |

### Approval

Under the default `instructions` mode, a skill activates once its validation record shows a gain. An instruction stays a `candidate` because instructions load into every session. A human promotes it:

```bash
episodic-memory learn status             # candidates awaiting approval
episodic-memory learn approve kind/project/slug
```

`learn approve` refuses an entry with no measurement, with a recorded regression, or with a lower pass count. A human can still approve a measured candidate that misses the gain. The command then prints the entry, its validation record and a unified diff against the version the entry revises. On a TTY the command asks for `y` (`--yes` for non-interactive use). `EPISODIC_MEMORY_LEARN_APPROVE=all` holds skills back too, and `none` activates both without review.

### Cost expectations

Learning is the expensive part of episodic-memory. Each solved task, each validation and each merge check is one Agent SDK subprocess, and each subprocess spends its own tokens. A realistic run is:

- `learn tasks` — one text call per sampled source exchange (`--per-project`, default 8), and each call
  can yield up to 12 tasks (four kinds at three tiers). Far cheaper than the solving that follows.
- `learn solve` — one call per task solved. A baseline precheck needs the budget for one pass over the signal train set before the run starts.
- `learn bootstrap` — one bootstrapper per eligible project, then two full signal-train solves, then one
  merge and one reflection call.
- `learn improve` — a signal-train solve, then per leaf up to `ROUNDS × (diagnose + propose + validate)`
  calls, then merges, then one held-out `test` evaluation.

`EPISODIC_MEMORY_LEARN_MAX_CALLS` bounds the total; a run that hits it stops with status `stopped` and
keeps everything it already validated. `learn report` prints the calls and USD spent against the caps. The report also shows the pass rate on both splits before and after, and every rejected proposal with the gate that rejected it. Nothing
here runs from a hook, so no session start spends money. `learn` also defers entirely while the shared GPU
is reserved and when the summarizer reentrancy guard is set.

## Commands

### `episodic-memory sync`

**Recommended for plugin hooks.** Copies new conversations from `~/.claude/projects`, `~/.claude/transcripts`, and `~/.codex/sessions` to archive and indexes them.

Features:
- Only copies new or modified files (fast on subsequent runs)
- Generates embeddings for semantic search
- Atomic operations - safe to run concurrently
- Idempotent - safe to call repeatedly
- Background hook output is written to `~/.config/superpowers/logs/episodic-memory.log` unless `EPISODIC_MEMORY_CONFIG_DIR` changes the memory directory

**Usage in Claude Code:**
Add to `.claude/hooks/session-end`:
```bash
#!/bin/bash
episodic-memory sync
```

### `episodic-memory stats`

Display index statistics including conversation counts, date ranges, and project breakdown.

```bash
episodic-memory stats
```

### `episodic-memory doctor`

Diagnose local plugin, archive, index, and hook health. Add `codex` for Codex-specific checks.

```bash
episodic-memory doctor
episodic-memory doctor --json
episodic-memory doctor codex
```

The default report covers the config/archive/index paths, database size and row counts, embedding-version drift, recent SessionStart hook errors (`sync-errors.log`), and plugin `node_modules` sentinels. The Codex doctor additionally checks the Codex version, plugin hook feature state, MCP server registration, and hook trust. The default report also has a **Learn (Recursa)** section. The section reports the learned directory's presence and sizes, and the entries by kind and status. The section also reports the latest run, the candidates awaiting approval, the unresolved sources, and the `better-sqlite3` copy that the plugin resolves. `--json` includes this section too.

### Codex E2E Verification

The repository includes an opt-in live Codex E2E test. The test creates an isolated temporary `CODEX_HOME`, installs a copied plugin bundle and trusts the hook. The test then runs Codex sessions in `tmux` and verifies archive -> summary -> index -> MCP recall.

```bash
bun run build
EPISODIC_MEMORY_RUN_CODEX_E2E=1 bun run test:codex-e2e
```

### Claude E2E Verification

The repository also includes an opt-in live Claude Code E2E test. It loads this repo as a session plugin with `--plugin-dir`, constrains the hook to a temporary transcript source, and verifies archive -> summary -> index -> MCP recall.

```bash
bun run build
EPISODIC_MEMORY_RUN_CLAUDE_E2E=1 bun run test:claude-e2e
```

This test uses your normal Claude Code auth and writes small test transcripts to your normal Claude transcript directory. The archive and index are isolated in a temporary `EPISODIC_MEMORY_CONFIG_DIR`.

### `episodic-memory index`

Manual indexing tools for bulk operations and maintenance. See `episodic-memory index --help` for full options.

Common operations:
- `--cleanup` - Index all unprocessed conversations
- `--verify` - Check index health
- `--repair` - Fix detected issues
- `prune --excluded` or `prune --project NAME` - Remove the rows of projects; add `--dry-run` to count only
- `vacuum` - Return the free pages of the index database to disk
- `--rebuild --yes` - Rebuild with no confirmation question, for a script

For an unknown command or option, or an option of another command, `index` writes one error line, exits with code 2 and does no work. The exit code of the command reaches the caller.

### `episodic-memory search`

Search indexed conversations using semantic similarity or exact text matching. See `episodic-memory search --help` for full options.

### `episodic-memory show`

Display a conversation from a JSONL file in human-readable format.

**Options:**
- `--format markdown` (default) - Plain text markdown output suitable for terminal or Claude
- `--format html` - Pretty HTML output for viewing in a browser

**Examples:**
```bash
# View in terminal
episodic-memory show conversation.jsonl | less

# Generate HTML for browser
episodic-memory show --format html conversation.jsonl > output.html
open output.html
```

## Architecture

- **Core package** - TypeScript library for indexing and searching conversations
- **CLI tools** - Unified command-line interface for manual use
- **MCP Server** - Model Context Protocol server exposing search, read, digest, skills and topics tools
- **Claude Code plugin** - Integration with Claude Code (auto-indexing, MCP tools, hooks)
- **Codex plugin** - Integration with Codex (manifest, MCP config, hooks, skills)
- **Self-improving memory** - the `learn` CLI, an in-process tool server for isolated solver and learner agents, and a `better-sqlite3` knowledge store under `learned/`

### Documentation

The `docs/architecture/` folder describes the design of the code.

| Document | Content |
|---|---|
| [OVERVIEW](docs/architecture/OVERVIEW.md) | What the repository is, its layout and its numbers |
| [ARCHITECTURE](docs/architecture/ARCHITECTURE.md) | The design, its principles and its decisions |
| [COMPONENTS](docs/architecture/COMPONENTS.md) | Each module and its role |
| [DATAFLOW](docs/architecture/DATAFLOW.md) | How a request travels from start to end |
| [LEARN](docs/architecture/LEARN.md) | The learned-knowledge feature: model, storage, safety, learning loop, every module |
| [API](docs/architecture/API.md) | The MCP tools, commands, library exports and environment variables |
| [FILE_INVENTORY](docs/architecture/FILE_INVENTORY.md) | Every file and its role (generated) |
| [TEST_COVERAGE](docs/architecture/TEST_COVERAGE.md) | What the tests cover (generated) |
| [DEPENDENCY_GRAPH](docs/architecture/DEPENDENCY_GRAPH.md) | Which file imports which (generated) |
| [unused-analysis](docs/architecture/unused-analysis.md) | Files and exports with no importer (generated) |
| [duplicate-symbols](docs/architecture/duplicate-symbols.md) | Names that more than one file defines (generated) |

Regenerate the generated files with `repo-tools map . --out=docs/architecture`. Check the written documents with `repo-tools check . --docs=docs/architecture`.

## How It Works

1. **Sync** - Copies conversation files from Claude Code and Codex transcript directories to archive
2. **Parse** - Extracts user-agent exchanges from Claude Code JSONL or Codex rollout JSONL
3. **Embed** - Generates vector embeddings using Transformers.js (local, offline)
4. **Index** - Stores in SQLite with sqlite-vec for fast similarity search
5. **Search** - Semantic search using vector similarity or exact text matching
6. **Learn** (optional) - generates practice tasks, grades its answers against archive addresses, and keeps only validated, cited hints

## Excluding Conversations

Conversations containing this marker anywhere in their content will be archived but not indexed:

```
<INSTRUCTIONS-TO-EPISODIC-MEMORY>DO NOT INDEX THIS CHAT</INSTRUCTIONS-TO-EPISODIC-MEMORY>
```

**Automatic exclusions:**
- Conversations where Claude generates summaries (marker in system prompt)
- Meta-conversations about conversation processing

**Use cases:**
- Sensitive work conversations
- Tool invocation sessions (summarization, analysis)
- Test or experimental sessions
- Any conversation you don't want searchable

The marker can appear in any message (user or assistant) and excludes the entire conversation from the search index. Practice tasks and citations come only from the index. An excluded conversation is therefore never a practice task and never a citation in a learned entry.

## MCP Server

When installed as a Claude Code or Codex plugin, episodic-memory provides an MCP (Model Context Protocol) server. The server exposes tools to search and view conversations, to load the skills learned from them, and to read the topic memory documents.

### Available MCP Tools

#### `search`

Search indexed conversations using semantic similarity or exact text matching.

**Single-concept search**: Pass a string query
```json
{
  "query": "React Router authentication",
  "mode": "vector",
  "limit": 10
}
```

**Multi-concept AND search**: Pass an array of concepts
```json
{
  "query": ["React Router", "authentication", "JWT"],
  "limit": 10
}
```

**Filtered search**: narrow by project, session or branch
```json
{
  "query": "flaky integration test",
  "project": "my-app",
  "git_branch": "main",
  "after": "2025-09-01"
}
```

**Parameters:**
- `query` (string | string[]): Single string for regular search, or array of 2-5 strings for multi-concept AND search
- `mode` ('vector' | 'text' | 'both'): Search mode for single-concept searches (default: 'both')
- `limit` (number): Max results, 1-50 (default: 10)
- `after` (string, optional): Only show conversations after YYYY-MM-DD
- `before` (string, optional): Only show conversations before YYYY-MM-DD
- `project`, `session_id`, `git_branch` (string, optional): Exact-match filters on the exchange's metadata
- `response_format` ('markdown' | 'json'): Output format (default: 'markdown')
- `auth_token` (string): Required only when the server runs with `EPISODIC_MEMORY_MCP_TOKEN` set (see [docs/security.md](docs/security.md))

Every result carries the archive path and line range that `read` takes.

#### `read`

Display a conversation, or a line range of one, in readable markdown format.

```json
{
  "path": "<configDir>/conversation-archive/my-app/0f2c…​.jsonl",
  "startLine": 120,
  "endLine": 180
}
```

**Parameters:**
- `path` (string): The `archive_path` of a `search` result. The path must resolve inside the conversation archive and end in `.jsonl`. The tool refuses a path outside the archive, a symlink that escapes it, and any other file type. Arbitrary files on disk cannot be read through this tool
- `startLine`, `endLine` (number, optional): 1-indexed, inclusive line range. A full read is capped at 32 MB (`EPISODIC_MEMORY_MAX_READ_BYTES`); pass a range for larger conversations
- `auth_token` (string): As for `search`

With `EPISODIC_MEMORY_REDACT_SECRETS=1`, token-shaped secrets in the conversation are redacted before the text is returned.

#### `digest`

Show the session digest or search it (`query`). Expand a `[#id]` mark into an archive path and line range (`expand`). Store a note for the next session (`handoff`, one line, capped at 500 characters). The tool reads whatever digest has been written. The digest is only written when `sync` runs with `EPISODIC_MEMORY_DIGEST=1`. See [Session Digest](#session-digest).

#### `skills`

List, search (`query`) or load (`get`) the skills that episodic-memory learned from this project's conversations. The `project` option defaults to the key for the current directory. The `limit` option is 1-50 (default 10).
Read-only: it opens `knowledge.db` read-only for the one call and answers that learning is off, opening
nothing, unless `EPISODIC_MEMORY_LEARN=1`. Every field is screened for injected instructions and redacted
before it is returned. See [Self-improving memory](#self-improving-memory-recursa).

#### `topics`

Read the topic memory documents of the project: `list`, `read` (`slug`), `search` (`query`), `links` (`unit`) or `timeline`. Pass one `action` for each call. The `project` option defaults to the key for the current directory. Search and timeline take optional `from` and `to` times, and `limit` (1-50; default 10 for search, 50 for timeline).
Read-only: the tool opens the index read-only and never creates a file. The server does not read `EPISODIC_MEMORY_TOPICS`. The results come from whatever the sync step wrote. See [Topic memory](#topic-memory).

### Settings the server sees

A plugin-launched server receives only the environment variables that the plugin manifest (`.mcp.json`) whitelists. The whitelist holds the config and database paths, `CONVERSATION_SEARCH_EXCLUDE_PROJECTS`, `EPISODIC_MEMORY_LEARN`
and `EPISODIC_MEMORY_LEARN_MAX_CHARS`, `EPISODIC_MEMORY_MCP_TOKEN`, `EPISODIC_MEMORY_REDACT_SECRETS`,
`EPISODIC_MEMORY_MAX_READ_BYTES`, `EPISODIC_MEMORY_DIGEST_MAX_CHARS`, `EPISODIC_MEMORY_INCLUDE_SUMMARY` and
`EPISODIC_MEMORY_MAX_SUMMARY_DISPLAY_CHARS`. Set them in the shell that starts Claude Code or Codex. A server
you start yourself sees your whole environment.

### Using the MCP Server Directly

The MCP server can also be used outside of Claude Code with any MCP-compatible client:

```bash
# Run the MCP server (stdio transport)
episodic-memory-mcp-server
```

## Development

Bun is the package manager and script driver. Node remains the production runtime
(CLI / MCP / hooks). Requires [Bun](https://bun.sh) 1.4+ and Node 22+ (the floor `better-sqlite3` 13 declares; both entry points check it at launch). CI pins Bun 1.4.2.

```bash
# Install dependencies
bun install

# Typecheck
bun run typecheck

# Run tests
bun run test

# Build (tsc + esbuild → dist/, including the MCP bundle)
bun run build
```

## License

MIT
