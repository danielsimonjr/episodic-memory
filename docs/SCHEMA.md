# Database Schema

## Tables

### `exchanges`

Core conversation exchanges (user-agent pairs).

```sql
CREATE TABLE exchanges (
  id TEXT PRIMARY KEY,

  -- Content
  user_message TEXT NOT NULL,
  assistant_message TEXT NOT NULL,

  -- Location
  project TEXT NOT NULL,
  archive_path TEXT NOT NULL,
  line_start INTEGER NOT NULL,
  line_end INTEGER NOT NULL,

  -- Timing
  timestamp TEXT NOT NULL,
  last_indexed INTEGER,

  -- Conversation structure
  parent_uuid TEXT,           -- Links to parent exchange
  is_sidechain BOOLEAN,       -- True if subagent conversation

  -- Session context
  session_id TEXT,
  cwd TEXT,                   -- Working directory
  git_branch TEXT,
  claude_version TEXT,

  -- Thinking metadata
  thinking_level TEXT,        -- "none", "high", etc.
  thinking_disabled BOOLEAN,
  thinking_triggers TEXT      -- JSON array of trigger info
);
```

### `tool_calls`

Tool usage tracking for searchable tool patterns.

```sql
CREATE TABLE tool_calls (
  id TEXT PRIMARY KEY,
  exchange_id TEXT NOT NULL,  -- Foreign key to exchanges.id
  tool_name TEXT NOT NULL,
  tool_input TEXT,            -- JSON of tool parameters
  tool_result TEXT,           -- Result content
  is_error BOOLEAN,
  timestamp TEXT NOT NULL,

  FOREIGN KEY (exchange_id) REFERENCES exchanges(id)
);

CREATE INDEX idx_tool_name ON tool_calls(tool_name);
CREATE INDEX idx_exchange_id ON tool_calls(exchange_id);
```

### `vec_exchanges`

Vector embeddings for semantic search (sqlite-vec).

```sql
CREATE VIRTUAL TABLE vec_exchanges USING vec0(
  id TEXT PRIMARY KEY,
  embedding FLOAT[384]
);
```

### `digest_entry`

Cited summaries of past sessions, used by the session-start digest. Entries are never deleted; compression
sets `superseded_by`.

```sql
CREATE TABLE digest_entry (
  id INTEGER PRIMARY KEY,
  tier TEXT NOT NULL,          -- 'session', 'day' or 'week'
  project TEXT NOT NULL,       -- same key as exchanges.project
  period_start TEXT NOT NULL,  -- ISO time; day and week entries start at 00:00 UTC (week = Monday)
  period_end TEXT NOT NULL,
  text TEXT NOT NULL,          -- one fact per line, each ending in [#exchangeId,...] marks
  sources TEXT NOT NULL,       -- JSON array of exchanges.id values cited by the text
  model TEXT NOT NULL,         -- model tag that wrote the text ('handoff' for a handoff note)
  created_at TEXT NOT NULL,
  superseded_by INTEGER,       -- id of the compressed entry that replaced this one
  handoff INTEGER NOT NULL DEFAULT 0,
  UNIQUE (tier, project, period_start)
);
```

`digest_fts` is an FTS5 table (`id`, `text`) over the same text, used by the `digest` tool's `query`.

## Topic memory

The topic tables hold the topic memory documents of each project. The sync step writes them. The `topics` MCP tool only reads them.

`ensureTopicSchema()` in `src/topic-db.ts` creates the tables. The sync step calls it only when `EPISODIC_MEMORY_TOPICS=1`. A fresh index has no topic tables until then. When a topic table is missing, the `topics` tool answers that topic memory has no documents yet.

`topic_doc` holds the document text. The model output writes only `topic_doc`. Each accepted edit rewrites the derived tables of the project in the same transaction. The derived tables are `topic_unit`, `topic_link`, `topic_event` and `topic_unit_fts`.

The statements below are the ones that `ensureTopicSchema()` runs. Each statement uses `CREATE ... IF NOT EXISTS`.

### `topic_doc`

```sql
CREATE TABLE topic_doc (
  project TEXT NOT NULL,
  slug TEXT NOT NULL,          -- the document name, 1 to 64 characters
  text TEXT NOT NULL,          -- the Markdown text of the document
  updated_at TEXT NOT NULL,    -- the ISO time of the last accepted edit
  PRIMARY KEY (project, slug)
);
```

### `topic_unit`

One row for each paragraph of each document. The row is derived from `topic_doc`.

```sql
CREATE TABLE topic_unit (
  project TEXT NOT NULL,
  unit_id TEXT NOT NULL,       -- 8 lowercase hex characters, unique in the project
  slug TEXT NOT NULL,          -- the document that holds the paragraph
  heading TEXT NOT NULL,       -- the heading path, joined by " > "
  text TEXT NOT NULL,          -- the paragraph text
  seq INTEGER NOT NULL,        -- creation order; a kept paragraph keeps its value
  PRIMARY KEY (project, unit_id)
);
```

### `topic_link`

One row for each link between two paragraphs. The row is derived from `topic_doc`.

```sql
CREATE TABLE topic_link (
  project TEXT NOT NULL,
  from_unit TEXT NOT NULL,     -- the paragraph that holds the link
  to_unit TEXT NOT NULL        -- the paragraph that the link names
);
```

### `topic_event`

One row for each footnote. The row is derived from `topic_doc`.

```sql
CREATE TABLE topic_event (
  project TEXT NOT NULL,
  unit_id TEXT NOT NULL,       -- the paragraph that holds the footnote
  time TEXT NOT NULL,          -- YYYY, YYYY-MM or YYYY-MM-DD
  statement TEXT NOT NULL,     -- the statement that the footnote dates
  sources TEXT NOT NULL        -- a JSON array of exchange ids, without the # prefix
);
```

### `topic_unit_fts`

An FTS5 table over the paragraph text. The `topics` tool uses it for `search`.

```sql
CREATE VIRTUAL TABLE topic_unit_fts USING fts5(
  unit_id UNINDEXED,
  project UNINDEXED,
  text,
  tokenize = 'porter unicode61'
);
```

### `topic_session`

The progress of each session in the topic step.

```sql
CREATE TABLE topic_session (
  project TEXT NOT NULL,
  session_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending','done','rejected')),
  attempts INTEGER NOT NULL DEFAULT 0,  -- the count of failed model calls
  error TEXT,                           -- the last error text, or NULL
  PRIMARY KEY (project, session_id)
);
```

A session with a `done` or `rejected` row is not organized again. A `pending` row is a session that failed. The next run retries it.

### `topic_meta`

```sql
CREATE TABLE topic_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
```

The key `since` holds the time of the first run. The step organizes sessions that start at or after this time.

## Learned knowledge and the learning trace

Self-improving memory (the `EPISODIC_MEMORY_LEARN` feature) keeps its state in
`<configDir>/learned/`, which is a **sibling** of `conversation-index/`, not a child of it:

```
<configDir>/
  conversation-index/     db.sqlite          -- disposable; rebuildable from the archive
  learned/                knowledge.db       -- learned entries (better-sqlite3), durable
                          learning.sqlite    -- the learning trace + rendered block
  learned-skills/                            -- generated SKILL.md export tree
```

`index rebuild`, `prune` and the `rm -rf conversation-index/` reset recipe therefore cannot reach
learned knowledge or the learning trace.

### `learned/knowledge.db`

Owned by `src/learn/knowledge-store.ts`, which opens it with `better-sqlite3` and creates two tables,
`entities` and `relations`, in the layout the former memoryjs adapter used, so a file written before
2026-11-06 opens unchanged: missing columns are added on open and the old `entities_fts` shadow table
and its triggers are dropped. The `skills` MCP tool opens it read-only and runs no DDL. WAL sidecars
sit beside the file, so `learned/` is the unit to back up.

Besides learned entries, the same `entities` table holds the learner's records, one row each with a
typed JSON payload in `agentMetadata`: `heuristic` (`heuristicRecord`), `decision` (`decisionRecord`),
`failure` (`failureRecord`), `reflection` (`reflectionRecord`), `project_context`
(`projectContextRecord`) and `procedure` (steps as a `[procedure-steps]:` observation).

An entry is one `entities` row:

| Column | Value |
|---|---|
| `name` | `learned:<kind>:<project>:<slug>:v<n>` — the primary key and the only entry id |
| `entityType` | `learned-instruction`, `learned-skill` or `learned-reflection` |
| `projectId` | the project key, or `*` for all projects |
| lifecycle (`agentMetadata.lifecycleStatus`) | `draft` (candidate) / `published` (active) / `archived` (retired) |
| `importance` | 3 / 5 / 8 for confidence low / medium / high |
| `tags` | `kind:<kind>`, `project:<key>`, `trust:<level>`, `status:<status>` |
| `rootEntityName`, `parentEntityName`, `isLatest`, `supersededBy` | the version chain |
| `observations` | one line per field: `title:`, `description:`, `scope:`, `confidence:`, `trust:`, `status:`, `version:`, `run:`, `validation:` (JSON), `heuristic:`, `decision:`, `procedure:`, `steps:` (JSON), `reflection-hash:`, then one `body:` line per body line |

The logical `version` lives in the name and in the `version:` observation. The row's own
`entities.version` is a write counter that increments on every update and is never read as the
logical version.

Citations are `cites` relations from the entry to reference entities: `exchange:<id>`
(`entityType` `exchange-ref`, observations `path:`, `lines:`, `session:`) for an exchange, and
`attempt:<id>` (`entityType` `attempt-ref`, observations `task:`, `run:`) for a learning attempt.
Reference entities are created before the relation, because the store validates both endpoints.

### `learned/learning.sqlite`

The plugin's own database, opened with the same pragmas and directory modes as `db.sqlite` and its
own idempotent `migrateLearningSchema`. `knowledge_snapshot` and `learned_block` came with Task 1;
the `learning_*` tables (run, task, attempt) with the eval harness.

```sql
CREATE TABLE knowledge_snapshot (
  id INTEGER PRIMARY KEY,
  run_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  entry_names TEXT NOT NULL   -- JSON array of entity names: K^(t), the set a solver ran with
);

CREATE TABLE learned_block (
  project TEXT PRIMARY KEY,   -- project key, or '*' for the shared block
  text TEXT NOT NULL,         -- the rendered, screened, redacted learned block
  rendered_at TEXT NOT NULL
);

CREATE TABLE learning_run (
  id TEXT PRIMARY KEY,        -- run-<iso timestamp>-<random>
  phase TEXT NOT NULL,        -- bootstrap | improve
  parent_run_id TEXT,         -- a child learner's orchestrator
  project TEXT,
  status TEXT NOT NULL,       -- running | done | stopped | failed | deferred
  started_at TEXT NOT NULL,
  finished_at TEXT,
  budget TEXT NOT NULL DEFAULT '{}',    -- JSON: caps and use for calls, USD, wall clock, rounds
  metrics TEXT NOT NULL DEFAULT '{}',   -- JSON: pass rates before/after per split, kind and tier
  seed INTEGER,               -- the split seed, recorded on the run (§7 rule 13)
  rejections TEXT NOT NULL DEFAULT '[]' -- JSON list of { slug, reason }
);

CREATE TABLE learning_task (
  id INTEGER PRIMARY KEY,
  run_id TEXT NOT NULL,
  kind TEXT NOT NULL,         -- locate | recall | when | multi
  tier INTEGER NOT NULL,      -- 1 | 2 | 3
  split TEXT NOT NULL,        -- train | test
  project TEXT NOT NULL,
  prompt TEXT NOT NULL,       -- redacted and screened
  truth TEXT NOT NULL,        -- JSON TaskTruth: addresses, session date range, redacted answer
  status TEXT NOT NULL DEFAULT 'ok'   -- ok | stale
);

CREATE TABLE learning_attempt (
  id INTEGER PRIMARY KEY,
  task_id INTEGER NOT NULL,
  run_id TEXT NOT NULL,
  snapshot_id INTEGER NOT NULL,  -- knowledge_snapshot.id: K^(t)
  role TEXT NOT NULL,            -- solve | validate | merge-check
  passed INTEGER NOT NULL,
  score REAL NOT NULL,           -- 0, 0.5 or 1 for a deterministic grade; the judge score for recall
  answer TEXT NOT NULL,          -- redacted, capped at 4000 characters
  trace TEXT NOT NULL DEFAULT '[]', -- JSON [{ tool, args, resultAddress, resultChars }]; no result text
  cost TEXT NOT NULL DEFAULT '{}',  -- JSON { turns, inputTokens, outputTokens, usd }
  outcome TEXT NOT NULL,         -- graded | aborted | killed | error
  created_at TEXT NOT NULL
);

CREATE INDEX idx_learning_task_split ON learning_task(split, status);
CREATE INDEX idx_learning_task_run ON learning_task(run_id);
CREATE INDEX idx_learning_attempt_run ON learning_attempt(run_id);
CREATE INDEX idx_learning_attempt_task ON learning_attempt(task_id);
```

`knowledge_snapshot`, `learned_block`, the `learning_*` tables and their indexes are all created by
`migrateLearningSchema` through `ensureLearningSchema`, with `IF NOT EXISTS` throughout, so opening the
same file twice is a no-op. `learning_task.truth` is the answer key as an archive address plus the
session's date range; the text a `recall` task is judged on is read back from the index by address at
grade time and never stored in the task.

Two reads are constrained in code, not by convention:

- `listTasks` is the only task read path and takes a mandatory `split`, so the held-out `test`
  split cannot reach a learner prompt (§7 rule 13).
- `passRate` counts the newest `graded` attempt per task, never counts a task whose source went
  `stale`, and with `signalOnly` restricts to `locate`/`when`/`multi` at tiers 2 and 3 — tier 1 and
  `recall` are reported but never decide whether an edit is kept.

`learned_block` is what the SessionStart hook reads. The hook opens this file **read-only** with
`migrate: false`, so it never runs DDL, and it never opens `knowledge.db`.

`learned/` is outside `conversation-index/`, so an index rebuild or reset leaves both files alone.
The reset recipe in `CLAUDE.md` (`rm -rf conversation-index/`) therefore cannot reach learned
knowledge; delete `learned/` only deliberately.

## Indexes

```sql
-- Time-based sorting
CREATE INDEX idx_timestamp ON exchanges(timestamp DESC);

-- Session lookups
CREATE INDEX idx_session_id ON exchanges(session_id);

-- Project filtering
CREATE INDEX idx_project ON exchanges(project);

-- Sidechain filtering
CREATE INDEX idx_sidechain ON exchanges(is_sidechain);

-- Branch filtering
CREATE INDEX idx_git_branch ON exchanges(git_branch);

-- Topic memory: links by target, events by paragraph
CREATE INDEX idx_topic_link_to ON topic_link(project, to_unit);
CREATE INDEX idx_topic_event_unit ON topic_event(project, unit_id);
```

## Schema Evolution

Schema changes are applied via migrations in `src/db.ts`:

1. Check for missing columns using `pragma_table_info()`
2. Add new columns with `ALTER TABLE`
3. Populate with data from re-indexing if needed

Migrations are idempotent - safe to run multiple times.
