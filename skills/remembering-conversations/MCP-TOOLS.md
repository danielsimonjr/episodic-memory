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
| `response_format` | `"markdown"` \| `"json"` | No | Output format (default: `"markdown"`) |

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
| `path` | `string` | Yes | Absolute path to the JSONL conversation file |
| `startLine` | `number` | No | Starting line number (1-indexed, inclusive) |
| `endLine` | `number` | No | Ending line number (1-indexed, inclusive) |

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

## skills

List or load the skills episodic-memory has learned from past sessions in this project.

**Tool name:** `mcp__plugin_episodic-memory_episodic-memory__skills`

A skill is a learned hint about where to look: a short description plus a body naming the conversations, terms, dates or search modes that answered a similar question before. When a session opens with a learned-hints block in its context, load the skill it names before searching.

**Read-only.** The tool never writes, and with `EPISODIC_MEMORY_LEARN` unset it answers that learning is off without opening anything.

### Parameters

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `get` | `string` | No | Slug of one skill, as listed. Returns its frontmatter and body |
| `query` | `string` | No | Search the learned skills instead of listing them |
| `project` | `string` | No | Project key (default: the key for the current working directory) |
| `limit` | `number` | No | Maximum skills listed, 1-50 (default: 10) |

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
- File not found
- Date parsing errors
- Search failures

## Performance Notes

- **Search** is fast (< 100ms typically)
- **Read** can be slow for large conversations
  - Use `startLine`/`endLine` to paginate
  - Conversations can be 1000+ lines
- Vector search uses sqlite-vec with cached embeddings
- Text search uses SQLite FTS5 full-text index
