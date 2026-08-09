# later — 6-12+ months

> Aspirational. Things to be excited about. Some will happen; some will get
> dropped; some will turn out to be the wrong abstraction. The point is to
> sketch the trajectory so present decisions don't accidentally foreclose
> the future.

Each section here is **less concrete than `next.md`** — more "north star"
than spec. Things move from `later` → `next` when concrete shape emerges.

---

## Theme A — Multi-machine continuous sync

**The aspiration:** Search past conversations from any of his machines
and get a unified result set. New conversations on machine X are searchable
from machine Y within minutes.

**Why it matters:** the machines specialize — desktop for heavy
compute, laptop for travel, Mac for design. Conversations naturally
fragment. The memory's value drops with each fragmentation.

**Possible shapes:**

1. **Dropbox/iCloud-folder relay.** `~/.config/superpowers/` lives on a
   cloud-synced folder. Risk: SQLite + cloud sync = corruption. Would
   need careful per-row lockless writes or a switch to per-conversation
   files with a thin index.

2. **Self-hosted sync server.** A small node/Rust service Daniel runs on
   one machine; others push/pull deltas. Most reliable, most ops burden.

3. **Git-as-database.** Conversations + index as git-managed repo. Daniel
   already has git muscle memory; bonus: history. Cons: scale (175 MB
   already, growing), embedding-vector storage is binary-unfriendly.

4. **Hybrid: archive in cloud (read-only on most machines), index local.**
   The archive is append-only JSONL — cloud-sync friendly. The DB is
   rebuilt from archive on each machine. Sync cost = archive only.

**Foundations queued in `next.md` § Theme 6**: per-machine identity,
import/export. Once those land, machine-A → machine-B "copy this bundle"
becomes routine and one of the shapes above can be tested without
risking the index.

---

## Theme B — Agent-driven memory shaping

**The aspiration:** Memory isn't just a passive store — agents can write
to it, request consolidation, mark conversations as superseded, link
related sessions across projects.

**Why it matters:** Today the memory is "everything I ever said to
Claude/Codex." That's a lot of noise. An agent that periodically
consolidates ("here are the 5 themes from last week + the open questions")
makes memory more useful than raw retrieval.

**Possible shapes:**

- **Periodic consolidation agent** — runs weekly, identifies project-level
  themes, writes a meta-summary per project. New tool surface:
  `mcp:list_project_summaries`.
- **Supersession links** — when conversation N decides X, and N+1 reverses
  X, the search should know. New DB column: `supersedes_id`. Tool:
  `mcp:mark_superseded`.
- **Cross-conversation linking** — conversation A's open question gets
  answered by conversation B's resolution. Tool: `mcp:link_conversations`.
- **Conversation labels** — agents tag conversations with semantic labels
  (`auth`, `migration`, `architectural-decision`). Tool: `mcp:add_label`,
  `mcp:remove_label`. Indexed for faster filter-then-vector queries.

**Open question:** Where does agent write authority come from? Anyone
calling the MCP server can do this; in a multi-tenant or attacker-context
scenario that's a problem. May need MCP-level scoping.

---

## Theme C — Beyond-conversation memory

**The aspiration:** Episodic memory today indexes **conversations**.
the workflow generates more — research notes, paper drafts, code
review threads, voice memos. A unified memory could span them.

**Why it matters:** Daniel often asks "where did I work through this
idea?" The answer might be a Claude conversation, a paper draft section,
or a 30-minute voice memo transcript. Today they live in separate silos.

**Possible shapes:**

- **Plugin architecture for sources** — sync.ts becomes pluggable.
  Sources: Claude transcripts (today), Codex transcripts (today),
  Obsidian vault, Google Drive docs, plain markdown trees, voice-memo
  transcripts.
- **Cross-source ranking** — same exchange-row schema, but `harness`
  becomes `source_type`. Search returns mixed-source results.
- **Ingest pipeline** — each source gets its own parser + summarizer;
  output normalizes to the existing schema.

This is **adjacent to TensorJS / paper-reply-post workflows** Daniel
already has (see UPT notes). The ingest pattern from `paper-reply-post`
could be reused for paper-source indexing.

---

## Theme D — Personalized retrieval

**The aspiration:** The search ranker learns from the user's behavior. When
he clicks through to one result and ignores another, the next query
weights things accordingly.

**Why it matters:** Generic embeddings are 80% solution; the last 20% is
"I always want recent + project-X + outcomes" type personalization.

**Possible shapes:**

- **Implicit feedback loop** — track which results agents-acting-for-Daniel actually USE downstream. Re-rank on a per-user model.
- **Explicit pinning** — `mcp:pin_conversation` marks one as canonical for a topic; future searches for that topic prefer it.
- **Time-decay defaults** — recent always slightly preferred unless `before` filter explicit.
- **Project graph** — projects with shared file paths or commits weight together at search time.

**Big caveat:** any of this is meaningless without an eval set. See
[next.md § Theme 2 — Search quality experiments] for the eval foundation
that this builds on.

---

## Theme E — Embeddings as a moving target

**The aspiration:** Best-in-class embedders ship every quarter. We keep
up without forcing manual re-indexes on users.

**Why it matters:** A 1-year-old embedder is a 1-year-old search ceiling.
The migration story exists (`EMBEDDING_VERSION` + batch re-embed) but
nothing automated tracks the SOTA.

**Possible shapes:**

- **Periodic "your embedder is N months old" notifier.** Optional;
  user-driven upgrade.
- **A/B mode** — install with both old + new embedders for a transition
  week, search returns blended results, then drop old.
- **Encoder-agnostic exchange schema** — today the DB has
  `embedding_version` (an int). Make it richer: model name + size + dtype.
  Allows multiple embedders in the same DB simultaneously (cost: more
  storage, better resilience).

---

## Theme F — TensorJS adjacency

**The aspiration:** the user's TensorJS / universal-physics-tensor project
benefits from episodic-memory's recall. The reverse may be true too —
TensorJS's visual layers could render episodic-memory's search graph
interactively (which conversation talks to which, weighted by similarity).

This is speculative; logged here because the projects share an architect
(Daniel) and the structural-AST + numerical patterns of UPT could inform
how episodic-memory represents conversations long-term.

**Possible shapes:**

- Visualization: project-level graph view. Force-directed, nodes =
  conversations, edges = embedding cosine similarity above threshold.
- Memory-grounded reasoning: TensorJS bridge-equation derivations cite
  prior conversations where the same equation came up.

---

## Theme G — Ecosystem play

**The aspiration:** episodic-memory becomes a standard MCP surface that
multiple agentic tools can rely on. Other plugins can publish to it; it
can publish to other memory stores.

**Why it matters:** Today, memory is per-tool. Claude Code has skills,
Codex has rollouts, Continue has its own, Aider has its own. A standard
"semantic memory MCP" that any of them can write to (subject to user
authz) would be a real ecosystem primitive.

This is upstream-aligned in spirit but requires multi-stakeholder buy-in
to ship. Logged as a north star for the project's broader trajectory.

---

## Foundations that unlock the above

Looking across these themes, several foundations recur:

1. **Eval harness** (themes B, D, E depend on it) — quality measurement
   first, optimization second.
2. **Pluggable source ingest** (themes A, C, G) — clean separation of
   "where this came from" + "what's the canonical schema."
3. **Versioned schema migration** (themes A, B, E) — `EMBEDDING_VERSION`
   pattern generalized to other schema dimensions.
4. **Tool authorization model** (themes B, G) — who can write what.
5. **Per-row provenance** (themes A, C, E) — every exchange knows its
   source, time, embedder, transcript-format-version.

Each is small enough to do as a focused task; together they're the
backbone of "everything in `later.md` becomes possible."

---

## See also

- [`now.md`](now.md) · [`next.md`](next.md) · [`README.md`](README.md)
- [`upstream-sync.md`](upstream-sync.md) — how this fork stays current
- [`focus-areas/`](focus-areas/) — per-theme deep dives
