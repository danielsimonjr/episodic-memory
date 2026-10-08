# Combined memory: a cited digest beside the search index

Status: draft for review. No code exists for this design.

## 1. Purpose

Episodic memory today answers one question: "What did we say about X?" Claude must search to get the answer.
A session starts with no memory loaded. The user re-explains recent work each time.

This design adds a small digest that loads at session start. Every line of the digest cites the conversations it
came from. When a line is not enough, Claude searches the index for the full text.

The result is one plugin with two parts:

- **Digest**: short, always loaded, lossy, cited.
- **Index**: complete, searched on demand, exact. (Exists today.)

## 2. Scope

In scope:

- A digest store, a compression job, a session-start injection and a handoff note.
- Summaries made by a local Ollama model by default.
- A size budget, redaction, citation checks and an additive-only rule.

Out of scope:

- Any change to how conversations are archived, parsed or embedded.
- Any deletion of conversations, digest entries or index rows.
- Code copied from the `remember` plugin (see section 9).

## 3. What exists today (verified in `src/`)

| Part | File | Use in this design |
|---|---|---|
| Exchange table with `session_id`, `project`, `timestamp`, `archive_path` | `db.ts`, `docs/SCHEMA.md` | Source of every citation |
| Summarizer with backends `claude` and `ollama` | `summarizer.ts`, `ollama-backend.ts` | Reuse the backend switch |
| Redaction | `redact.ts` | Run on all text before summarizing |
| Session-start sync hook (startup, resume, clear, compact) | `hooks/hooks.json`, `cli/sync-hook.js` | Add the injection here |
| Tools `search` and `read` (`read` is confined to the archive and to `.jsonl` files) | `mcp-tools.ts` | Drill-down path; unchanged |
| Project prune | `prune.ts` | Not touched; the digest never prunes |
| Schema migration | `db.ts` (`migrateSchema`) | Add the digest tables |

## 4. Data model

One new table, `digest_entry`:

| Column | Meaning |
|---|---|
| `id` | Primary key |
| `tier` | `session`, `day` or `week` |
| `project` | Project key, same value as `exchanges.project` |
| `period_start`, `period_end` | ISO times covered |
| `text` | The summary, plain text, one fact per line |
| `sources` | JSON array of `exchanges.id` values cited by the entry |
| `model` | Model tag that wrote the text |
| `created_at` | Creation time |
| `superseded_by` | Id of the entry that replaced this one in the digest, or null |

An entry is never deleted. A compressed entry gets `superseded_by` set. The injection skips superseded entries.
The handoff note is a `session` entry with a flag `handoff = 1`.

## 5. Data flow

1. **Session end or compaction.** The existing sync indexes new exchanges.
2. **Session summary.** For each new session, take its exchanges, redact them, and ask the summarizer for lines.
   Each line must name the exchange ids it uses. The result is one `session` entry.
3. **Validation.** Reject a line when it cites no id, cites an id that does not exist, or fails the redaction check.
   Keep the valid lines. If none remain, write no entry.
4. **Compression.** When a project has more than N session entries in one day, summarize them into one `day`
   entry. The `day` entry cites the union of the sources. Set `superseded_by` on the session entries.
   The same rule applies from `day` to `week`.
5. **Injection.** At session start, build the digest for the current project: the handoff note, today, the last
   7 days, then older weeks. Stop when the size budget is full.
6. **Drill-down.** A line carries short source marks. Each mark maps to an exchange id, and the exchange row holds
   `archive_path`, `line_start` and `line_end`. Claude calls the existing `read` tool with those values.

## 6. Summarizer

- Default backend: Ollama, model set by `EPISODIC_MEMORY_DIGEST_MODEL`. The call uses a JSON-schema `format`
  and a fixed seed.
- The `claude` backend stays available and stays off by default for the digest.
- A summary is a hint. The citation rule exists so that a wrong line can be checked against its source.
- A failed call writes no entry and logs the failure. The next sync retries the session.

## 7. Safety rules

1. **Additive only.** No code path deletes a digest entry, an exchange or a file. Compression sets
   `superseded_by`.
2. **Redact first.** All text passes through `redact.ts` before it reaches the summarizer. The output passes the
   same check before it is stored.
3. **Cite or drop.** A line without a valid citation is dropped.
4. **Size budget.** The injected digest never exceeds `EPISODIC_MEMORY_DIGEST_MAX_CHARS` (default 6000). The
   builder drops the oldest tier first.
5. **Reentrancy guard.** The digest job runs inside the sync. Any digest step that starts a Claude subprocess
   inherits `EPISODIC_MEMORY_SUMMARIZER_GUARD`. The Ollama backend starts no such subprocess.
6. **Feature flag.** `EPISODIC_MEMORY_DIGEST` defaults to off. With the flag off, behavior is unchanged.
7. **No new network target.** Ollama calls use the same base-URL validation as the current backend.

## 8. Runtime and build

- The source stays TypeScript, ESM.
- Bun is the toolchain: install, test, typecheck and bundle.
- The shipped hook and server entry points run on `node`. An MCP client and a hook do not reliably find `bun`
  on the path. The bundle is a plain node file, as it is today.
- The injection hook must start fast. It reads the digest tables and prints text. It must not import the embedding
  stack (`@huggingface/transformers`). The existing sync entry point already defers heavy imports for this reason.
- `dist/` is committed. Each implementation change rebuilds it and commits the real content changes only.
- Open decision: replace `better-sqlite3` with `bun:sqlite`. The gain is no native rebuild. The cost is that the
  runtime must then be Bun, which conflicts with the rule above. This design keeps `better-sqlite3` and defers
  the change.

## 9. Licensing

The `remember` plugin ships under a custom community license. It allows personal and internal use and forbids
commercial redistribution and competing use. This repository is MIT.

- No `remember` source, prompt text or file layout is copied.
- Only the general idea is reused: layered summaries that load at session start.
- Names, tables, prompts and tests are written from this design.

## 10. Test plan

Tests come first. Each rule in section 7 has a failing test before its code.

- Citation: a line with a missing or unknown id is dropped.
- Redaction: a planted secret in a transcript never appears in an entry or in the injection.
- Budget: the injection stops at the limit and drops the oldest tier first.
- Additive: after compression, every original entry still exists with `superseded_by` set.
- Idempotence: running the job twice writes no duplicate entry.
- Reentrancy: with the guard variable set, the digest job exits before any heavy import.
- Flag off: the hook output equals the current output byte for byte.
- Failure: an unreachable Ollama writes no entry and does not block the sync.

## 11. Phases

1. Schema and migration, with tests. Flag off.
2. Session summaries with citation and redaction checks.
3. Day and week compression.
4. Injection and the handoff note.
5. Bundle, install check on both machines, then enable the flag.

## 12. Open questions

1. Replace both existing plugins with this one, or ship the digest as an add-on beside `episodic-memory`?
   Default in this draft: one combined plugin.
2. Which Ollama model writes the summaries? The choice needs a measured comparison on real sessions.
3. Should the digest be embedded and searched too, or only injected?
4. The cap N for session entries per day before compression.
