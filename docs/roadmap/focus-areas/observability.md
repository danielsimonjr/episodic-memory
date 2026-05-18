# Focus area: Observability

> When episodic-memory misbehaves, how does the user know? Today: poorly.
> The plan to fix that.

## The current state — silent failures everywhere

A user typically discovers episodic-memory is broken when search stops
returning expected results. By then, the cause is far upstream:

- The SessionStart hook silently failed N days ago
- The summarizer is rate-limited and skipping conversations
- A schema migration paused mid-run because of a lock contention
- The embedder is loading from cache and the cache is stale
- A new conversation file format wasn't parsed correctly

None of these surface to the user until search becomes obviously wrong.

## Symptoms we've already seen (need diagnostics)

| Symptom | What we know about it | What's missing |
|---|---|---|
| `× failed` in `/mcp` | Sometimes wrapper install issue, sometimes Claude Code failure cache, sometimes server crash | Single command to check the most-likely causes |
| New conversations not indexed | Probably the SessionStart hook silently fails | A hook-log Daniel can read |
| Search returns nothing for a project | Could be the project wasn't synced, could be embedder issue | "Why is this project missing?" diagnostic |
| Sync takes 20 minutes | Embedding model warm-up + first-time index | "What is sync doing right now?" log |
| Search relevance drops over time | New conversations summarized differently, or model drift | Per-row provenance + drift detection |

## What "good observability" looks like

A user hits a symptom and one of three things happens:

1. **They run `doctor` and the cause is obvious** ("Hook failed 3 times in last 24h, see ~/.config/superpowers/sync-errors.log")
2. **They read the structured log** and see the timeline of events
3. **They run a targeted diagnostic** (`doctor sync`, `doctor search "<query>"`, `doctor embed <text>`) that reproduces the issue

Today only #1 is partially there (basic `doctor` exists but reports
minimal info). #2 doesn't exist. #3 doesn't exist.

## Proposed structure

### 1. Structured sync log

**File:** `~/.config/superpowers/sync.log`

**Format:** newline-delimited JSON, one event per line:

```json
{"ts":"2026-05-18T17:00:00Z","level":"info","event":"sync_start","pid":1234,"harness":"claude-code","reason":"hook"}
{"ts":"2026-05-18T17:00:02Z","level":"info","event":"file_archived","project":"upt","file":"abc-def.jsonl"}
{"ts":"2026-05-18T17:00:05Z","level":"info","event":"summary_generated","conversation":"abc-def","words":342}
{"ts":"2026-05-18T17:00:05Z","level":"warn","event":"embedding_skipped","reason":"empty_exchange","conversation":"abc-def"}
{"ts":"2026-05-18T17:01:30Z","level":"info","event":"sync_complete","duration_ms":90000,"new_exchanges":42,"new_summaries":7}
```

**Rotation:** keep last 7 days; auto-truncate over 50 MB. Old logs
move to `sync.log.1.gz` etc.

**Reading:** `doctor` reads + tails; `doctor sync --json` returns raw.

### 2. Hook error capture

The SessionStart hook today swallows errors (`2>/dev/null || true`).
This was an upstream choice to avoid blocking session start when sync
fails, but it makes debugging impossible.

**Proposal:**
- Don't swallow. Redirect to `sync.log` instead: `... >> ~/.config/superpowers/sync.log 2>&1`
- Keep the `|| true` (exit code still doesn't propagate to Claude Code's hook system)
- `doctor` highlights any recent ERROR-level hook lines

This addresses upstream #94 — file as PR.

### 3. `doctor` command expansion

Today `doctor` covers config dir + DB path + version. Expand to:

```
$ npx episodic-memory doctor

=== Install ===
  Plugin install path:   ~/.claude/plugins/cache/local-marketplace/episodic-memory/1.4.1
  node_modules health:   ✅ all sentinel files present
  Native bindings:       ✅ better_sqlite3.node
  Onnx hoist:            ✅ onnxruntime-common at top level

=== Data ===
  Config dir:            ~/.config/superpowers/
  Archive size:          758 MB across 16 projects
  DB size:               175 MB, 2,739 exchanges, 1,429 conversations
  EMBEDDING_VERSION:     1 (current)
  Stale rows:            0 (no migration pending)

=== Activity ===
  Last sync:             2026-05-18 17:00:00 (2 hours ago)
  Sync duration:         90s (normal range: 60-120s)
  New exchanges (24h):   42
  Hook runs (24h):       5 successful, 0 failed
  
=== Errors (last 7 days) ===
  No errors logged.
```

Subcommands:
- `doctor sync` — verbose sync diagnostic
- `doctor search <query>` — show what search does step-by-step
- `doctor embed <text>` — produce an embedding, show first 5 dims
- `doctor install` — re-verify install state, suggest fixes
- `doctor --json` — same data, machine-readable

### 4. Debug verbosity

Use the existing `debug` package (transitive dep of @modelcontextprotocol/sdk).

```bash
DEBUG=episodic:* npm run sync         # all episodic-memory debug
DEBUG=episodic:indexer npm run sync   # just indexer
DEBUG=episodic:search npm run search  # just search
```

Each module gets a namespaced logger:

```ts
// in src/indexer.ts
import createDebug from 'debug';
const debug = createDebug('episodic:indexer');

debug('archiving %s for project %s', file, project);
```

Output goes to stderr (not stdout) so it doesn't corrupt the MCP
protocol. Off by default — no perf or output noise.

### 5. Local metrics (optional)

A small `~/.config/superpowers/metrics.json` with counters:

```json
{
  "queries_served": 1834,
  "queries_with_zero_results": 12,
  "sync_runs": 156,
  "sync_errors": 0,
  "embeddings_computed": 2739,
  "summary_failures": 3,
  "last_reset": "2026-04-01T00:00:00Z"
}
```

Read by `doctor`. Reset via `doctor reset-metrics`. No external
telemetry, no opt-in collection — purely local for the user's own
inspection.

## What this is NOT

- **External telemetry** — no data leaves the machine. This is for the user's own debugging.
- **APM/tracing** — overkill for a personal tool.
- **Centralized logging** — single file per user is fine.
- **Real-time monitoring** — sync runs are minutes apart; periodic inspection is enough.

## Sequencing

1. **Sync log + hook capture** (`next.md` Theme 4) — foundational; everything else builds on it
2. **`doctor` expansion** (`now.md` queued) — exposes the log
3. **Debug flag** — coding convenience
4. **Local metrics** — last; needs the sync log to be reliable first

## See also

- [`../next.md`](../next.md) § Theme 4 — Observability & debugging UX
- [`../now.md`](../now.md) § "SessionStart sync failures should not be silent" — concrete near-term work
- [upstream #45](https://github.com/obra/episodic-memory/issues/45) — debug logs
- [upstream #94](https://github.com/obra/episodic-memory/issues/94) — SessionStart silent failures
