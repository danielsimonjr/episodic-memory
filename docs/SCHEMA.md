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
