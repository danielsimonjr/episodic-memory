# next — 3-6 months

> Themes with sketched-out plans, not yet detailed enough for `now.md`.
> Each theme has a "why now" + the rough shape of what shipping looks like.

---

## Theme 1: Better first-run install story

**Why now:** The fork's wrapper sentinel check fixed the worst case, but the install flow is still fragile (~5s cold start, opaque progress, no recovery diagnostics when it fails).

**Shape:**
- **Progress reporting** — the wrapper currently emits two lines to stderr ("Installing..." / "May take 30-60 seconds"). Replace with structured progress that the Claude Code UI can render (or at least tail meaningfully): per-dep timing, native-build status, hoist verification.
- **Pre-flight check command** — `npx episodic-memory doctor install` runs the full install dry-run + dep verification + sentinel check, returning structured output. Useful for "before you report a bug" diagnostics.
- **Failure recovery hints** — when `npm install` fails, the wrapper's error message should suggest concrete next steps (clear cache, manual `npm install`, file an issue). Today it just says "run manually."
- **Optional dep audit** — `@huggingface/transformers` is huge (~250 packages, ~700 MB). Investigate whether sharp/native-binding parts can be made truly optional for the search-only case.

**Definition of "done" (rough):** Fresh install on a clean Windows VM completes in ≤90s with visible progress, and `doctor install` catches all known failure modes without false positives.

**Adjacent:** see [focus-areas/developer-experience.md](focus-areas/developer-experience.md).

---

## Theme 2: Search quality experiments

**Why now:** Upstream #74 wants summaries-in-search-results; #46 explores LEANN; both indicate search quality is the most user-visible area where improvements compound. Daniel has 2,739 indexed exchanges to ground-truth against — a real-world eval set.

**Shape:**
- **Summary-aware ranking** (upstream #74) — when a conversation has a summary, include it in the search result body. Could also weight scores using summary-level embeddings.
- **Multi-concept aggregation tuning** — `searchMultipleConcepts` exists but the dedup + score-merge logic is heuristic. Try BM25-style reciprocal rank fusion; A/B against current behavior on a held-out query set.
- **LEANN experiment** (upstream #46) — alternative to sqlite-vec for the vector path. Trade-offs: better recall, lower disk footprint, but adds a non-trivial dep. Feasibility study before commitment.
- **Eval harness** — `tests/search.test.ts` covers correctness; we need a quality harness measuring recall@k and MRR against a labeled query set. The labeled set comes from Daniel's own "find that conversation where I..." queries.

**Definition of "done":**
- Eval harness lands with ≥50 labeled queries
- One quality improvement (summary visibility OR rank-fusion) ships with measured improvement on the eval set
- LEANN experiment produces a written go/no-go recommendation

**Adjacent:** see [focus-areas/search-quality.md](focus-areas/search-quality.md).

---

## Theme 3: Embedding pipeline modernization

**Why now:** Current embedder is `Xenova/all-MiniLM-L6-v2` — fast, small (~80 MB), but the search-quality ceiling is low. Better embedders exist (bge, e5, mxbai) at modest size cost.

**Shape:**
- **Model comparison** — benchmark MiniLM-L6 vs bge-small-en, gte-small, mxbai-embed-large on Daniel's eval set. Disk + latency + recall trade-offs documented.
- **Reversible upgrade** — if a new model wins, the upgrade path needs:
  - Bump `EMBEDDING_VERSION`
  - Re-embed migration runs incrementally per existing pattern in `embedding-migration.ts`
  - Migration progress visible (sync log or doctor command)
  - Per-row stamp tells the search code which embedder produced each vector during the transition window
- **Optional GPU acceleration** — `onnxruntime-node` supports CUDA/Metal/DirectML; explore for users with hardware (Daniel's machine has a discrete GPU). Default stays CPU.
- **Late-interaction option** — ColBERT-style late interaction is a different shape than dense retrieval. Adjacent to LEANN exploration above.

**Definition of "done":**
- Comparison report exists with measured numbers (not vibes)
- If model upgrade ships, migration completes on Daniel's 2,739-exchange corpus without manual intervention
- New model passes `test/cosine-similarity.test.ts`-style invariants

**Adjacent:** see [focus-areas/embeddings.md](focus-areas/embeddings.md).

---

## Theme 4: Observability & debugging UX

**Why now:** When something breaks (sync hangs, search returns nothing, hook fails silently), there's no good signal trail. Upstream #45 wants debug logs; Daniel hit silent failures multiple times in May 2026 (the failure-cache bug, the partial-install bug).

**Shape:**
- **Structured sync log** — write to `~/.config/superpowers/sync.log` with rotation (last 7 days, capped at 50 MB). Lines tagged with PID, harness, project, file. Hook errors land here too (see [now.md § SessionStart silent-fail](now.md)).
- **`doctor` command expansion** — adds plugin install state, recent errors, EMBEDDING_VERSION drift, DB stats, hook history. (Part of this is queued in `now.md`.)
- **Debug verbosity flag** — `DEBUG=episodic:*` style namespaced logging via the existing `debug` package (already a transitive dep of @modelcontextprotocol/sdk).
- **Metric counters** (optional) — basic counters in a sidecar JSON file: queries served, sync runs, errors. Read by `doctor`. No external telemetry — local-only.

**Definition of "done":**
- After a `× failed` reproduction, `doctor` alone tells you the root cause
- Sync log retains last 7 days reliably
- Debug flag works without code changes

**Adjacent:** see [focus-areas/observability.md](focus-areas/observability.md).

---

## Theme 5: Cross-harness integration polish

**Why now:** v1.3.0 added Codex; cross-harness recall works end-to-end but the edge cases are rough (Codex transcript format quirks, harness detection, summarization fallbacks). Upstream is actively investing here.

**Shape:**
- **Stronger harness detection** — currently inferred from path heuristics; explicit metadata in the archive would be cleaner.
- **Future harness support** — Daniel uses Aider/Continue occasionally. Could the parser be generalized? Investigate without committing.
- **Cross-harness search ranking** — does a Claude conversation about React + a Codex conversation about React rank correctly? Add an eval case.
- **Summarization fallback chain** — when Claude SDK summary fails, today we silently skip. Better: try Codex, then a text-only extractive fallback, then mark as "needs-summary" for retry.

**Definition of "done":** Daniel's Codex transcripts indexed cleanly, ranked competitively with Claude conversations, with no manual intervention.

**Adjacent track upstream where possible** — this theme aligns with obra's signaled direction.

---

## Theme 6: Multi-machine awareness (foundation)

**Why now:** Daniel runs episodic-memory on 2+ Windows desktops + a Mac. Today, each machine has its own siloed index. Even a partial story for "I asked about X on the laptop, find it on the desktop" would be valuable.

This is the smaller foundation; the full sync is [later.md § Theme A](later.md).

**Shape:**
- **Per-machine identity** — stamp each row with a machine tag; queries can optionally filter by machine.
- **Read-only import** — `episodic-memory import <foreign-archive-path>` reads an exported archive from another machine into the local index without re-syncing. One-shot, manual.
- **Export bundle** — `episodic-memory export <output-path>` produces a portable bundle (archive JSONL + DB rows or re-embeddable JSON dump).

**Definition of "done":**
- Daniel can copy a bundle from machine A to machine B and run `import`, and search-on-B finds A's conversations
- No automatic sync (that's `later`); this is just the foundation

**Adjacent:** see [later.md § Theme A — Multi-machine continuous sync].

---

## Theme 7: Security hardening (continued)

**Why now:** The May 2026 audit closed the `read` tool path-traversal vector. The full threat model deserves a deeper sweep.

**Shape:**
- **Index poisoning analysis** — can a malicious conversation file cause RCE during parse/sync/summarize? What about during search-result rendering?
- **Hook-script sandboxing** — `hooks.json` invokes a node script with `${PLUGIN_ROOT}`. Confirm `PLUGIN_ROOT` can't be hijacked by env-var manipulation.
- **Secret-aware indexing** — many conversations contain API keys, tokens, OAuth secrets. Option to redact them before they hit the embedding model (which may cache or log). Off by default; opt-in.
- **DB at rest** — `~/.config/superpowers/conversation-index/db.sqlite` is plaintext. Consider an opt-in encryption flag (SQLCipher) for users on shared machines.

**Definition of "done":** A written threat-model doc (`docs/security.md`) covers the data flow + identified risks + mitigations. At least one of the above ships per the doc's prioritization.

**Adjacent:** see [focus-areas/security-hardening.md](focus-areas/security-hardening.md).

---

## Theme parking lot — not yet "next"

These have come up but aren't ready for promotion:

- **Browser extension surface** — could episodic-memory's index be queried from a browser context? Adjacent to the cross-harness story but a much bigger lift.
- **Long-form summary regeneration** — current summaries are LLM-quality but a year-old summary may not reflect updated convention. Periodic refresh logic?
- **Diff-based incremental embedding** — embeddings are computed per-exchange today; large conversations re-embed often. A diff-aware approach could save compute.
- **Export to Markdown/Obsidian/Logseq** — Daniel's note-taking workflow uses Obsidian. A "yesterday's notable conversations" digest could land in a vault.

## See also

- [`now.md`](now.md) — what's queued for 1-3 months
- [`later.md`](later.md) — 6-12+ month vision
- [`focus-areas/`](focus-areas/) — per-theme deep dives
- [`upstream-sync.md`](upstream-sync.md) — staying current with obra's work
