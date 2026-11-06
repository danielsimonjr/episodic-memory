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

## Learned knowledge and the learning trace

Self-improving memory (the `EPISODIC_MEMORY_LEARN` feature) keeps its state in
`<configDir>/learned/`, which is a **sibling** of `conversation-index/`, not a child of it:

```
<configDir>/
  conversation-index/     db.sqlite          -- disposable; rebuildable from the archive
  learned/                knowledge.db       -- learned entries (memoryjs), durable
                          learning.sqlite    -- the learning trace + rendered block
  learned-skills/                            -- generated export tree
```

`index rebuild`, `prune` and the `rm -rf conversation-index/` reset recipe therefore cannot reach
learned knowledge or the learning trace.

### `learned/knowledge.db`

Owned by `@danielsimonjr/memoryjs`, which creates and migrates the schema itself
(`entities`, `relations`, `entities_fts` and their shadow tables). Production code never opens this
file with its own `better-sqlite3` handle; tests may, read-only, to assert on tables. Its
`storagePath` is a file path and memoryjs puts its WAL sidecars beside it, so `learned/` is the unit
to back up.

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

The logical `version` lives in the name and in the `version:` observation. memoryjs's own
`entities.version` auto-increments on every optimistic-concurrency write and is never read as the
logical version.

Citations are `cites` relations from the entry to reference entities: `exchange:<id>`
(`entityType` `exchange-ref`, observations `path:`, `lines:`, `session:`) for an exchange, and
`attempt:<id>` (`entityType` `attempt-ref`, observations `task:`, `run:`) for a learning attempt.
Reference entities are created before the relation, because memoryjs validates both endpoints.

### `learned/learning.sqlite`

The plugin's own database, opened with the same pragmas and directory modes as `db.sqlite` and its
own idempotent `migrateLearningSchema`. Task 1 creates these two tables; the `learning_*` tables
(run, task, attempt) are added with their code.

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
```

`learned_block` is what the SessionStart hook reads. The hook opens this file **read-only** with
`migrate: false`, so it never runs DDL, and it never loads memoryjs.

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
```

## Schema Evolution

Schema changes are applied via migrations in `src/db.ts`:

1. Check for missing columns using `pragma_table_info()`
2. Add new columns with `ALTER TABLE`
3. Populate with data from re-indexing if needed

Migrations are idempotent - safe to run multiple times.
