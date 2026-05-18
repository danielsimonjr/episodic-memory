# Focus area: Embeddings

> The embedding model is the search-quality ceiling. Today we use a
> 2022-era 80MB model; the SOTA has moved. This is the experiment plan
> for catching up without breaking everyone's indexes.

## Where we are

- **Model:** `Xenova/all-MiniLM-L6-v2` via `@huggingface/transformers`
- **Size on disk:** ~80 MB
- **Dimensions:** 384
- **Pooling:** mean
- **Normalization:** L2 (writer-side), so distance can be converted to cosine similarity via the identity in `search.ts:l2DistanceToCosineSimilarity`
- **EMBEDDING_VERSION:** 1
- **Indexed exchanges:** 2,739 (as of 2026-05-18, on Daniel's main machine)

## Why upgrade

The MiniLM-L6 model is a 6-layer distilled BERT. It was state-of-the-art
in 2021-2022; today it's at the floor of what you'd consider for
semantic search. Modern small embedders measurably outperform it:

| Model | Size | Dims | MTEB avg (approx) |
|---|---|---|---|
| MiniLM-L6-v2 (current) | 80 MB | 384 | ~56 |
| bge-small-en-v1.5 | 130 MB | 384 | ~62 |
| gte-small | 130 MB | 384 | ~61 |
| mxbai-embed-large-v1 | 670 MB | 1024 | ~64 |
| nomic-embed-text-v1.5 | 540 MB | 768 (variable) | ~63 |

(MTEB numbers are illustrative; the goal is to measure on Daniel's
actual conversation corpus, not on internet benchmarks.)

A 5-8 point MTEB lift is substantial — the difference between "search
mostly works" and "search nearly always finds it."

## The experiment plan

### Phase 1: Eval harness (prerequisite for everything else)

Without an eval set, we can't tell if an embedder change helped or hurt.

**Step 1.1: Build a labeled query set.** Daniel pulls 50 "I'm looking
for the conversation where I..." queries from his actual workflow,
labels the correct conversation_id for each. This lives at
`test/fixtures/eval-queries.json`:

```json
[
  {
    "query": "the conversation where I debugged the Windows MCP failure cache",
    "expected_conversation": "abc-def-...",
    "expected_in_top_k": 5
  },
  ...
]
```

**Step 1.2: Eval script.** `scripts/eval-search.js` runs each query
through `searchConversations`, measures whether the expected
conversation appears in top-K, computes recall@5, recall@10, MRR.

**Step 1.3: Baseline.** Run against current MiniLM-L6 to establish the
number. Likely somewhere in the 60-75% recall@5 range.

### Phase 2: Single-model comparison

For each candidate model (bge-small, gte-small, mxbai-embed-large):

**Step 2.1: Reindex into a side database.** Use
`EPISODIC_MEMORY_DB_PATH=/tmp/eval-bge.sqlite npm run sync` (or similar)
to build a parallel index without touching the real one.

**Step 2.2: Run eval.** Same query set, same script, different DB.
Record recall@5, recall@10, MRR.

**Step 2.3: Latency profile.** How long to embed a single query? How
long to embed 100 exchanges? Cold-start time?

**Step 2.4: Decision.** If any candidate beats baseline by >3 points
recall@5 AND latency is within 2x, it's a candidate for upgrade.

### Phase 3: Migration (if a winner emerges)

The `EMBEDDING_VERSION` + batch-migration scaffold is already in place
(see `src/embedding-migration.ts`). The migration story for users:

1. Bump `EMBEDDING_VERSION` from 1 → 2
2. Ship new model in `package.json` deps
3. On first launch after upgrade:
   - Detect version mismatch
   - Acquire migration lock
   - Re-embed in batches (say, 500 rows at a time)
   - Progress visible via sync log / doctor
4. Once all rows are at version 2, drop the old encoder pipeline

For Daniel's 2,739 exchanges:
- At ~50 ms/embed on CPU (MiniLM was ~30 ms, larger model ~50-80 ms)
- Total time: ~3 min for the full reindex
- One-time cost; afterwards normal incremental indexing

### Phase 4: Optional GPU acceleration

`onnxruntime-node` supports CUDA (Linux/Windows discrete NVIDIA),
DirectML (Windows AMD/Intel), and CoreML (Mac). Daniel's main machine
has a discrete GPU. For ad-hoc reindexes, GPU could be 10-50x faster.

Not in critical path; nice-to-have. Implementation:

```ts
const session = await ort.InferenceSession.create(modelPath, {
  executionProviders: ['cuda', 'directml', 'cpu'], // graceful fallback
});
```

## Cross-cutting concerns

### Re-embedding is expensive when models drift

If we upgrade embedders every 6 months, users see periodic 3-min
reindexes. Better:

- **Dual-write window** during migration — both old and new vectors
  stored, queries hit whichever is available. Drop old once migration
  completes.
- **Background migration** — don't block search during reindex; query
  blends old + new results until done.

This adds DB schema complexity (`embedding_version` becomes per-row;
already is) and storage (~2x during migration). Worth it for UX.

### Pooling/normalization invariants

`l2DistanceToCosineSimilarity` (in `search.ts`) relies on L2-normalized
vectors. **If a new encoder doesn't normalize at write time, that
identity breaks.** Test for this in the conformance suite.

Affected models:
- MiniLM-L6: normalized ✅
- bge-small-en-v1.5: NOT normalized by default; needs explicit normalize step ⚠️
- gte-small: not normalized ⚠️
- mxbai-embed-large: not normalized ⚠️

**Implementation:** always L2-normalize at the write boundary (in
`embeddings.ts`), regardless of what the encoder does internally. Test:
`expect(magnitude(vector)).toBeCloseTo(1, 5)`.

### Query-vs-document asymmetry

Some encoders (e.g., bge family) recommend a query prefix:
`"query: <query>"` for search-side, `"passage: <text>"` for stored side.
The current code doesn't do this for MiniLM (which doesn't need it).

When upgrading, audit `embeddings.ts`:
- `embedQuery(text)` — apply query prefix if model expects it
- `embedExchange(text)` — apply passage prefix if model expects it

Test: `test/query-prefix.test.ts` (already exists in the codebase!) —
extend with the new model's behavior.

## Adjacent work

### Late-interaction retrieval (ColBERT-style)

Different shape entirely. Late interaction stores per-token vectors and
does matching at query time. Pros: dramatically better recall on
keyword-shaped queries. Cons: 100-1000x storage cost, fundamentally
different DB schema.

Logged in `later.md` Theme C as an experiment, not a near-term plan.

### Multi-vector per exchange

Today each exchange has one embedding (the combined user+assistant
message). Could split:
- One for user message
- One for assistant message  
- One for the conversation summary
- Query against all three, take best score

Storage cost: 4x. Recall lift: probably significant for some query
classes ("where did Claude suggest X" vs "where did I ask about X").

Logged as a Phase-3 experiment if Phase 1-2 don't deliver enough lift
on their own.

## Open questions

1. **Cloud embedders?** OpenAI's `text-embedding-3-small` is 1536-dim
   at ~$0.02/M tokens. Could be a faster path to quality if Daniel's
   OK with cloud cost. But conflicts with episodic-memory's
   "everything local" identity. Decision deferred.

2. **Caching strategy.** Embedding the same query twice should hit a
   cache. We don't have one today. Worth ~5 ms per query at the cost
   of ~100 KB of LRU storage in memory.

3. **Multilingual?** MiniLM is English-only. Daniel's conversations
   are 99%+ English so this is academic, but worth noting.

## See also

- [`../next.md`](../next.md) § Theme 3 — Embedding pipeline modernization
- [`../later.md`](../later.md) § Theme E — Embeddings as a moving target
- [`/CLAUDE.md`](../../../CLAUDE.md) § Critical gotcha 5 — Embedding migration
