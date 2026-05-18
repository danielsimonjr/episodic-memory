# Focus area: Search quality

> Embeddings get you 80%. The remaining 20% is rank fusion, summary
> visibility, multi-concept aggregation, time-decay, and personalization.
> This is where the user-perceived value lives.

## The current search stack

```
user query
    ↓
SearchOptions: { query, mode: 'both', limit: 10, project?, session_id?,
                  git_branch?, after?, before?, concepts? }
    ↓
[ vector branch ]                [ text branch ]
    ↓                                ↓
embedQuery(query)              LIKE '%query%' on user_message + assistant_message
    ↓                                ↓
sqlite-vec MATCH                 SELECT with metadata filters
    ↓                                ↓
results (with L2 distance)       results (no relevance score)
    ↓                                ↓
    └────────── merge ──────────────┘
                ↓
        dedup by exchange.id, keep best score
                ↓
        apply optional `concepts` aggregation
                ↓
        return top `limit`
```

## What works well

- **Vector branch** finds semantically related conversations even when
  exact words differ
- **Text branch** catches keyword-exact matches the vector branch misses
- **Hybrid mode (`both`)** is the default and is mostly right
- **Project/session/branch/date filters** correctly narrow the result set
- **Multi-concept aggregation** is a clever way to handle compound queries

## What's lossy today

### 1. Summary-blind results (upstream issue #74)

When a conversation has a summary (most do, after the sync flow runs),
the summary captures the high-level shape better than any individual
exchange snippet. But the search result returns exchange snippets only,
ignoring summaries.

**Impact:** the agent receives a less-useful result. If it then calls
`read` to get the full conversation (1000+ tokens), it's wasted
context.

**Fix:** include the summary in the search result inline. Schema change
in the `ConversationExchange` returned by `search`:

```ts
interface ConversationExchange {
  // ... existing fields ...
  summary?: string;        // NEW: the summary if it exists for this conversation
  summaryWordCount?: number; // NEW: for budget-aware agents
}
```

`searchConversations` already reads summaries opportunistically (see
`src/search.ts:214`). Just expose them in the return value.

**Risk:** larger response sizes. Mitigation: optional `includeSummary`
parameter, default true; agents can opt out for token-tight contexts.

### 2. Text-branch has no relevance score

The text branch uses `LIKE '%query%'` which is binary — matches or
doesn't. No scoring. When merged with the vector branch's continuous
score, text-branch results either dominate (one match wins) or are
ignored (many matches all tied).

**Fix:** use SQLite FTS5 (full-text search extension) instead of LIKE.
Provides BM25 scoring out of the box.

**Migration cost:** a new virtual table `fts_exchanges` mirroring
`exchanges.user_message + assistant_message`. Sync rewrites to maintain
both tables. Schema migration via `migrateSchema`.

**Recall lift:** moderate; matters most for keyword queries where the
vector branch underperforms.

### 3. Score fusion is naive

Today: `searchConversations` merges by `id`, keeping the lowest distance
(best score). Better: reciprocal rank fusion or weighted blend.

**Example:** result A is rank 1 in vector branch (score 0.1), rank 5 in
text branch (score 1.0). Result B is rank 3 in vector (score 0.5), rank
1 in text (score 0.5). Today A wins (lower min distance). RRF (k=60):

- A: 1/(60+1) + 1/(60+5) = 0.0164 + 0.0154 = 0.0318
- B: 1/(60+3) + 1/(60+1) = 0.0159 + 0.0164 = 0.0323

B wins. The right answer depends on the corpus.

**Fix:** implement RRF, A/B against current behavior on the eval set.

### 4. Multi-concept aggregation is heuristic

`searchMultipleConcepts` (in `src/search.ts`) runs N separate queries
and aggregates results. The aggregation logic combines scores in a
hand-tuned way.

This works reasonably well, but:

- No measurement against alternatives
- Tied results break in unintuitive ways
- Doesn't take advantage of cross-concept reinforcement (a result that
  matches ALL concepts should beat one that matches only the
  highest-weighted)

**Fix:** experiment with score-product (×) vs score-sum (+) vs
log-likelihood under a held-out eval set. Likely modest improvements.

### 5. No time-decay

A conversation from 2 days ago about "the auth bug" should typically
outrank a 6-month-old conversation about the same topic, all else
equal. Today neither query branch knows about time.

**Fix:** add a configurable decay factor to scores:

```ts
score_final = score_raw * exp(-age_days / half_life)
```

Half-life 60 days (configurable). Off by default for backwards
compatibility; opt-in via `SearchOptions.timeDecay`.

### 6. No project graph

When two projects share a parent dir, share a git branch, or
frequently exchange exchanges, they're probably related. Search could
boost results from related projects when the current cwd matches one
of them.

**Fix:** future work. Requires building the project-relationship graph
(cwd overlap, commit-author overlap, archive_path prefix overlap).
Logged for `later.md`.

## The eval-driven approach

None of the above improvements should ship without **measured impact**
on a real query set. The eval harness from
[focus-areas/embeddings.md § Phase 1](embeddings.md#phase-1-eval-harness-prerequisite-for-everything-else)
serves search-quality experiments too.

Suggested experiment order (each takes a few days, runs against the
eval set):

1. **Baseline** — current code, current model
2. **+ Summary visibility** — should be +3-5 points recall@5
3. **+ FTS5 + RRF fusion** — should be +2-5 points recall@5 on
   keyword-shaped queries; might hurt semantic-shaped ones
4. **+ Time-decay (opt-in)** — measure separately; likely small but
   user-relevant
5. **Combined** — verify they compose without interfering

## The downstream impact

When search quality improves, the agent behavior changes:

- **Fewer `read` calls** — agents need less context if the search
  result is more complete (the summary visibility fix is mostly about
  this)
- **Faster sessions** — finding the right past conversation in 1 query
  instead of 3
- **Better recall triggers** — the upstream "skill description" work
  (v1.4.0) and search quality compound; better search makes the skill
  more likely to actually help

## Things NOT to change

- **The result schema beyond `summary`** — agents already depend on the
  current shape. Add fields, don't rename or remove.
- **Default `mode: 'both'`** — works for the most user queries.
- **The `limit: 10` default** — tested to be roughly right.
- **The `archive_path` semantics** — used by the `read` tool boundary
  check.

## See also

- [`../next.md`](../next.md) § Theme 2 — Search quality experiments
- [`embeddings.md`](embeddings.md) — the upstream of all search quality
- [upstream #74](https://github.com/obra/episodic-memory/issues/74) — summary visibility
- [upstream #46](https://github.com/obra/episodic-memory/issues/46) — LEANN exploration
