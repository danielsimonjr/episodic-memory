# Episodic Memory MCP Tools Reference

The episodic-memory plugin exposes five MCP tools. They search past Claude Code and Codex conversations, load learned skills and read topic memory.

## search

Search your episodic memory of past Claude Code and Codex conversations using semantic or text search.

**Tool name:** `mcp__plugin_episodic-memory_episodic-memory__search`

### Parameters

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `query` | `string` or `string[]` | Yes | Search query. String for single-concept search, array of 2-5 strings for multi-concept AND search |
| `mode` | `"vector"` \| `"text"` \| `"both"` | No | Search mode (default: `"both"`). Only used for single-concept searches |
| `limit` | `number` | No | Maximum results to return, 1-50 (default: 10) |
| `after` | `string` | No | Only return conversations after this date (YYYY-MM-DD) |
| `before` | `string` | No | Only return conversations before this date (YYYY-MM-DD) |
| `project` | `string` | No | Only exchanges from this project key (exact match) |
| `session_id` | `string` | No | Only exchanges from this session (exact match) |
| `git_branch` | `string` | No | Only exchanges recorded on this branch (exact match) |
| `response_format` | `"markdown"` \| `"json"` | No | Output format (default: `"markdown"`) |
| `auth_token` | `string` | Only with `EPISODIC_MEMORY_MCP_TOKEN` | The token the server was started with |

### Search Modes

- **`vector`** - Semantic similarity search using embeddings
- **`text`** - Text matching (case-insensitive). Each word of the query must appear in the exchange, in any order
- **`both`** - Combined semantic + text search (default, recommended). A result that only the text step finds has no similarity. When the embedding backend cannot load, a `both` search returns the text results only. The markdown result then starts with a `Note:` line. The JSON result has a `notices` array. These text results have no similarity. A `vector` search fails in that case.

### Single-Concept Search

```typescript
{
  query: "React Router authentication errors",
  mode: "both",
  limit: 10
}
```

### Multi-Concept Search (AND)

Search for conversations containing ALL concepts:

```typescript
{
  query: ["authentication", "React Router", "error handling"],
  limit: 10
}
```

Note: `mode` is ignored for multi-concept searches (always uses vector similarity).

### Date Filtering

```typescript
{
  query: "refactoring patterns",
  after: "2025-09-01",
  before: "2025-10-01"
}
```

### Metadata Filtering

```typescript
{
  query: "flaky integration test",
  project: "my-app",
  git_branch: "main"
}
```

### Response Format

#### Markdown (default)

Human-readable format with:
- Project name and date
- Conversation summary
- Matched exchange snippet
- Similarity score
- File path and line numbers

#### JSON

Machine-readable format:
```json
{
  "results": [...],
  "count": 5,
  "mode": "both"
}
```

## read

Display a full conversation from episodic memory as markdown.

**Tool name:** `mcp__plugin_episodic-memory_episodic-memory__read`

### Parameters

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `path` | `string` | Yes | The `archive_path` from a `search` result. Must resolve inside the conversation archive and end in `.jsonl`; anything else (a path outside the archive, a symlink that escapes it, a non-jsonl file) is refused |
| `startLine` | `number` | No | Starting line number (1-indexed, inclusive) |
| `endLine` | `number` | No | Ending line number (1-indexed, inclusive) |
| `auth_token` | `string` | Only with `EPISODIC_MEMORY_MCP_TOKEN` | The token the server was started with |

A full read (no range) is capped at 32 MB (`EPISODIC_MEMORY_MAX_READ_BYTES`); pass a range for a larger file. With `EPISODIC_MEMORY_REDACT_SECRETS=1`, token-shaped secrets are redacted before the text is returned.

### Usage

**Read entire conversation:**
```typescript
{
  path: "/Users/name/.config/superpowers/conversation-archive/project/uuid.jsonl"
}
```

**Read specific range:**
```typescript
{
  path: "/Users/name/.config/superpowers/conversation-archive/project/uuid.jsonl",
  startLine: 100,
  endLine: 200
}
```

### Response Format

Markdown-formatted conversation with:
- Message roles (user/assistant)
- Content (including tool uses and results)
- Line numbers for reference

## digest

Show, search or annotate the short, cited digest of earlier sessions in this project. The tool reads the digest that sync wrote. Sync writes the digest only when `episodic-memory sync` runs with `EPISODIC_MEMORY_DIGEST=1`. Without that variable, the tool has nothing to show.

**Tool name:** `mcp__plugin_episodic-memory_episodic-memory__digest`

### Parameters

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `query` | `string` | No | Search the digest instead of showing it |
| `project` | `string` | No | Project key (default: the key for the current working directory) |
| `limit` | `number` | No | Maximum search hits, 1-50 (default: 10) |
| `expand` | `string` | No | An exchange id from a `[#id]` mark. Returns the archive path and line range to pass to `read` |
| `handoff` | `string` | No | Store a one-line note for the next session (capped at 500 characters, redacted) |
| `auth_token` | `string` | Only with `EPISODIC_MEMORY_MCP_TOKEN` | The token the server was started with |

### Usage

**Show the digest for this project:** `{}`

**Follow a citation:** `{ expand: "a1b2c3d4e5f60718293a4b5c6d7e8f90" }` then `read` the path and range it returns.

**Leave a note for next time:** `{ handoff: "Resume at the failing migration test; the fix is in #41" }`

Every line of the digest cites the exchanges it came from; treat it as a map of where to look, not as the record itself. The full index stays the place for exact text.

## skills

List or load the skills episodic-memory has learned from past sessions in this project.

**Tool name:** `mcp__plugin_episodic-memory_episodic-memory__skills`

A skill is a learned hint about where to look. The skill has a short description plus a body. The body names the conversations, terms, dates or search modes that answered a similar question before. When a session opens with a learned-hints block in its context, load the skill that the block names before searching.

**Read-only.** The tool opens the knowledge store read-only for the one call. The tool never writes. With `EPISODIC_MEMORY_LEARN` unset, the tool answers that learning is off without opening anything.

### Parameters

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `get` | `string` | No | Slug of one skill, as listed. Returns its frontmatter and body |
| `query` | `string` | No | Search the learned skills instead of listing them |
| `project` | `string` | No | Project key (default: the key for the current working directory) |
| `limit` | `number` | No | Maximum skills listed, 1-50 (default: 10) |
| `auth_token` | `string` | Only with `EPISODIC_MEMORY_MCP_TOKEN` | The token the server was started with |

### Usage

**List the skills for this project:**

```typescript
{}
```

Each line is `slug: description (confidence, vN)`. Pass a slug back as `get`.

**Search them:**

```typescript
{
  query: "flaky integration test"
}
```

**Load one:**

```typescript
{
  get: "flaky-integration-test"
}
```

### Response Format

`get` returns YAML frontmatter (`name`, `description`, `scope`, `sources`, `confidence`, `version`). `get` then returns the body as markdown. The tool screens every field for injected instructions and redacts secrets before the tool returns the field. A skill whose text fails the screen is withheld, not printed.

## topics

Read the topic memory documents of a project. The actions list the documents, read one document, search its paragraphs, show the links of one paragraph, or show a timeline of dated events.

**Tool name:** `mcp__plugin_episodic-memory_episodic-memory__topics`

Topic memory is optional. The sync step writes the documents when `EPISODIC_MEMORY_TOPICS=1`. The tool returns what the sync step wrote. The tool does not check that variable.

**Read-only.** The tool opens the index read-only for the one call. It never creates the index file or a table. When the index file or the topic tables do not exist, the tool answers `Topic memory has no documents yet.`

The MCP server does not read the `EPISODIC_MEMORY_TOPICS_*` variables. The plugin manifest does not pass them. Set them in the shell that runs `sync`.

### Parameters

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `action` | `string` | Yes | One of `list`, `read`, `search`, `links`, `timeline` |
| `project` | `string` | No | Project key (default: the key for the current working directory) |
| `slug` | `string` | For `read` | Name of one document |
| `query` | `string` | For `search` | Words to find in the paragraphs. Every word must match |
| `unit` | `string` | For `links` | Paragraph id: 8 lowercase hex characters |
| `from` | `string` | No | Earliest time: `YYYY`, `YYYY-MM` or `YYYY-MM-DD` (inclusive). Used by `search` and `timeline` |
| `to` | `string` | No | Latest time, in the same forms (inclusive). Used by `search` and `timeline`. Must not be before `from` |
| `limit` | `number` | No | Maximum search hits (default 10) or timeline events (default 50), 1-50 |
| `auth_token` | `string` | Only with `EPISODIC_MEMORY_MCP_TOKEN` | The token the server was started with |

### Required arguments per action

| Action | Required | Optional |
|--------|----------|----------|
| `list` | none | `project` |
| `read` | `slug` | `project` |
| `search` | `query` | `project`, `from`, `to`, `limit` |
| `links` | `unit` | `project` |
| `timeline` | none | `project`, `from`, `to`, `limit` |

A missing required argument is a schema error. The schema refuses an unknown field. The schema checks `unit`, `from` and `to` for every action. A malformed value is a schema error, even when the action does not use that argument. A `to` before `from` is also a schema error. The action ignores any other argument that it does not use.

### Usage

**List the documents:** `{ "action": "list" }`

**Read one document:** `{ "action": "read", "slug": "work-history" }`

**Search the paragraphs:** `{ "action": "search", "query": "office move", "from": "2026-01", "limit": 5 }`

**Show the links of one paragraph:** `{ "action": "links", "unit": "4a8b10cd" }`

**Show a timeline:** `{ "action": "timeline", "from": "2026", "to": "2026-06" }`

Each timeline event names its source exchange ids. A source `#4f2a...` is the id `4f2a...` without the `#`. Call the `digest` tool with `expand` set to that id, for example `{ "expand": "a1b2c3d4e5f60718293a4b5c6d7e8f90" }`. The call returns the archive path and line range to pass to the `read` tool. To see the sources of a paragraph, use the `read` action on the document: its footnotes list the exchange ids. A search hit gives a unit id. Pass that id to `links` to see the paragraphs that link to the unit or that the unit links to.

### Response Format

Every response is plain text.

| Action | Output |
|--------|--------|
| `list` | One line for each document: `- <slug>: <title> (<n> units)`. With no document: `No topic documents for <project>.` |
| `read` | The text of the document, as stored. With an unknown slug: `No topic document "<slug>" in <project>.` |
| `search` | One line for each hit: `- <slug> \| <heading> \| unit <unit id> \| <text> \| times: <times>`. `times` lists the event times in the range, or `none`. With no `from` and `to`, the range is all times. With no hit: `No topic units match "<query>".` |
| `links` | The heading `Outgoing links of <unit>:`, then one line for each linked paragraph, or `- none`. Then the heading `Backlinks of <unit>:`, with the same lines. With an unknown unit: `No topic unit "<unit>" in <project>.` |
| `timeline` | One line for each event, in time order: `- <time> \| <statement> \| unit <unit id> \| sources: #<id>, #<id>`, or `sources: none` when the event has no source. With no event: `No timeline events for <project>.` |

A timeline returns at most `limit` events. When more events match, the last line says how many are left, and asks the caller to narrow `from` and `to` or raise `limit`.

Every line of output passes the secret redaction again before it is returned.

## Error Handling

All tools return errors as text content with `isError: true`:
- Invalid parameters (validation errors)
- A `read` path outside the archive, not a `.jsonl` file, or not found
- Date parsing errors
- Search failures
- A missing or wrong `auth_token` when the server runs with `EPISODIC_MEMORY_MCP_TOKEN`

## Performance Notes

- **Search** time grows with the number of indexed exchanges
- **Read** can be slow for large conversations
  - Use `startLine`/`endLine` to paginate
  - Conversations can be 1000+ lines
- Vector search scans the stored embeddings exactly
- Text search uses SQLite FTS5 full-text index
