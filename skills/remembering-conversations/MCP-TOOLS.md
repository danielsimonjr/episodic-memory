# Episodic Memory MCP Tools Reference

The episodic-memory plugin exposes four MCP tools for searching and displaying past Claude Code and Codex conversations, and for loading the skills it has learned from them.

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
- **`text`** - Exact text matching (case-insensitive)
- **`both`** - Combined semantic + text search (default, recommended)

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

A full read (no range) is capped at 32 MB (`EPISODIC_MEMORY_MAX_READ_BYTES`); pass a range for a larger file. Secrets are redacted before the text is returned.

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

Show, search or annotate the short, cited digest of earlier sessions in this project. Off unless the server runs with `EPISODIC_MEMORY_DIGEST=1`; with it unset the tool says so and opens nothing.

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

A skill is a learned hint about where to look: a short description plus a body naming the conversations, terms, dates or search modes that answered a similar question before. When a session opens with a learned-hints block in its context, load the skill it names before searching.

**Read-only.** The tool opens the knowledge store read-only for the one call and never writes; with `EPISODIC_MEMORY_LEARN` unset it answers that learning is off without opening anything.

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

`get` returns YAML frontmatter (`name`, `description`, `scope`, `sources`, `confidence`, `version`) and then the body as markdown. Every field is screened for injected instructions and redacted for secrets before it is returned, so a skill whose text fails the screen is withheld rather than printed.

## Error Handling

All tools return errors as text content with `isError: true`:
- Invalid parameters (validation errors)
- A `read` path outside the archive, not a `.jsonl` file, or not found
- Date parsing errors
- Search failures
- A missing or wrong `auth_token` when the server runs with `EPISODIC_MEMORY_MCP_TOKEN`

## Performance Notes

- **Search** is fast (< 100ms typically)
- **Read** can be slow for large conversations
  - Use `startLine`/`endLine` to paginate
  - Conversations can be 1000+ lines
- Vector search uses sqlite-vec with cached embeddings
- Text search uses SQLite FTS5 full-text index
