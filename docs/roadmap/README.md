# episodic-memory roadmap

A three-tier roadmap for **`danielsimonjr/episodic-memory`**, tracking
upstream `obra/episodic-memory` priorities + fork-specific contributions.

> **Scope:** what's coming next on this fork, why, and how it relates to
> upstream's direction. Not a commitment device — directional intent only.
> Concrete in-progress work is tracked in [`/todo.md`](../../todo.md).

## How this roadmap is organized

```
docs/roadmap/
├── README.md            ← you are here (index)
├── now.md               ← 1-3 months — concrete deliverables, queued
├── next.md              ← 3-6 months — themes with sketched plans
├── later.md             ← 6-12+ months — aspirational + visionary
├── upstream-sync.md     ← strategy for tracking obra/episodic-memory
└── focus-areas/         ← per-theme deep dives
    ├── windows-correctness.md
    ├── security-hardening.md
    ├── observability.md
    ├── embeddings.md
    ├── search-quality.md
    └── developer-experience.md
```

Read `now.md` first if you want to know what's actively happening. Read
`upstream-sync.md` to understand how this fork stays current with obra's
work.

## Roadmap shape

The roadmap is **upstream-aligned** — we track obra's signaled priorities
(via labels, issues, recent commits, and the existing CHANGELOG) as the
primary spine, then add fork-specific contributions as a side-track.

This is a fork, not a competitor. Where upstream is heading well, we
follow and contribute PRs back. Where upstream is silent on something we
need (e.g., Windows correctness, alternate embedding models, multi-machine
sync), we ship it on this fork and offer it upstream.

## Themes obra has signaled

From recent commit history, open issues, and label set:

| Area | Upstream signals | Fork stance |
|---|---|---|
| **MCP server** | Issue #49 (Windows MCP failures), the failing-deps experience is the worst first-run story | **Aggressive fork investment** — partially shipped (4 patches) |
| **Recall trigger reliability** | v1.4.0 + v1.3.1 both bumped this | **Follow upstream** — adopt upstream improvements as they ship |
| **Cross-harness support** | v1.3.0 added Codex; cross-harness recall is a strong upstream theme | **Follow + contribute** |
| **Sync correctness** | v1.4.1 fixed zero-exchange drain; #92 open on cross-project summarization | **Follow upstream + watch on Windows** |
| **Search quality** | #74 wants summaries-always-in-search; #46 explores LEANN | **Fork experiment candidate** (see [focus-areas/search-quality.md](focus-areas/search-quality.md)) |
| **Embedding model** | No bumps signaled; pinned to Xenova MiniLM-L6 currently | **Fork experiment candidate** (alternate models, see [focus-areas/embeddings.md](focus-areas/embeddings.md)) |
| **Sync alternatives** | #44 explores AWS Bedrock | **Watch upstream; contribute if direction matches** |
| **Observability** | #45 wants debug logs | **Fork-specific** — Windows debug story matters here |
| **Build/packaging** | v1.4.1 wrapper improvements; #86 fixed npm install flags | **Fork drove this** — sentinel check is the next iteration |

## Fork-specific themes (not signaled upstream, but Daniel wants them)

1. **Windows correctness** — fork has shipped 2 patches; more lurking. See [focus-areas/windows-correctness.md](focus-areas/windows-correctness.md).
2. **Security hardening** — fork already closed the `read`-tool path-traversal vector; the full threat-model deserves a sweep. See [focus-areas/security-hardening.md](focus-areas/security-hardening.md).
3. **Multi-machine sync** — Daniel runs episodic-memory across 2+ Windows desktops + a Mac. Today the index doesn't sync between them. See [later.md](later.md).
4. **Personal MCP-host coordination** — the fork is installed via `local-marketplace`. The "swap fork-vs-upstream" workflow needs better tooling. See [next.md](next.md).

## Time horizon definitions

- **`now.md`** — **1-3 months.** Concrete tasks with rough estimates. Status (`📦 shipped`, `🚧 in-progress`, `📋 queued`). Each task has an explicit "definition of done."
- **`next.md`** — **3-6 months.** Themes with sketched-out plans. Less detail per item; more about "this is the direction we're heading and roughly what it means."
- **`later.md`** — **6-12+ months.** Aspirational. Things we'd want to do but haven't committed to yet. Reasons to be excited about the project's trajectory.

Items move left (later → next → now → shipped) as concrete plans form
and capacity opens up.

## Status conventions

| Marker | Meaning |
|---|---|
| 📦 `shipped` | Landed on `main`, may or may not be tagged |
| 🚧 `in-progress` | Active work, see `/todo.md` for owner + ETA |
| 📋 `queued` | Plan exists, not yet started |
| 💭 `idea` | Not yet planned; may not happen |
| ⏸️ `paused` | Started, blocked, waiting for something |
| ❌ `dropped` | Considered, declined — kept here for posterity |
| 🔀 `upstream` | We're following obra's lead; no fork-specific work needed |

## Updating this roadmap

- When a task ships from `now.md`, mark it 📦 and leave it in place for one
  release cycle so the diff is visible, then move it into the relevant
  CHANGELOG release section.
- When a theme from `next.md` becomes concrete enough to scope, promote
  items into `now.md` with definition-of-done.
- When an idea from `later.md` gathers enough signal (issue traction,
  user request, or technical readiness), promote it into `next.md`.
- After a major upstream merge, re-read `upstream-sync.md` to check whether
  any fork-specific items just became redundant.

## See also

- [`/CLAUDE.md`](../../CLAUDE.md) — project conventions and gotchas
- [`/todo.md`](../../todo.md) — active task tracker (source of truth for what's next)
- [`/CHANGELOG.md`](../../CHANGELOG.md) — what's already shipped
- [obra/episodic-memory#95](https://github.com/obra/episodic-memory/issues/95) — the fork-patch upstream PR
