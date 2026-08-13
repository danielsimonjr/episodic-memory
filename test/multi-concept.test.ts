import { describe, it, expect, beforeAll } from 'vitest';
import { searchMultipleConcepts } from '../src/search.js';
import { initEmbeddings } from '../src/embeddings.js';

describe('multi-concept search', () => {
  // Pre-warm the embedder once per worker, matching integration.test.ts and
  // verify.test.ts. Without it the FIRST test here pays the cold model load on
  // top of its query, and under full-suite contention (41 files, parallel
  // workers each loading the heavy transformers stack) that pushed it past the
  // 30 s default and timed out. Measured: 1,598 ms for this file's first test
  // when run alone vs a 30,000 ms timeout in the full suite — a ~20x gap that
  // is contention and cold start, not query cost. No assertion or timeout was
  // widened; CLAUDE.md names exactly this cause ("suspect a new
  // embedding-heavy hook without warm-up").
  beforeAll(async () => {
    await initEmbeddings();
  }, 120000);

  it('should find conversations matching all concepts', async () => {
    // This test will use the actual database
    // Looking for conversations that discuss both "React Router" AND "authentication"
    const results = await searchMultipleConcepts(['React', 'Router'], { limit: 5 });

    // Should return results
    expect(Array.isArray(results)).toBe(true);

    // Results should be sorted by average similarity
    if (results.length > 1) {
      expect(results[0].averageSimilarity).toBeGreaterThanOrEqual(results[1].averageSimilarity);
    }
  });

  it('ranks concepts present in the corpus above random nonsense', async () => {
    // The fixture corpus mentions "skills" and "research" repeatedly.
    // Random nonsense should not produce a higher confidence than those terms.
    const corpusRelevant = await searchMultipleConcepts(['skills', 'research'], { limit: 5 });
    const nonsense = await searchMultipleConcepts(['xyzabc123', 'qwerty789'], { limit: 5 });

    if (corpusRelevant.length > 0 && nonsense.length > 0) {
      expect(corpusRelevant[0].averageSimilarity).toBeGreaterThan(nonsense[0].averageSimilarity);
    }
  });

  it('returns averageSimilarity values within the cosine range [-1, 1]', async () => {
    // Whatever the corpus, cosine similarity is mathematically bounded.
    const results = await searchMultipleConcepts(['xyzabc123', 'qwerty789'], { limit: 5 });
    for (const r of results) {
      expect(r.averageSimilarity).toBeGreaterThanOrEqual(-1);
      expect(r.averageSimilarity).toBeLessThanOrEqual(1);
    }
  });

  it('should respect limit parameter', async () => {
    const results = await searchMultipleConcepts(['React', 'Router'], { limit: 2 });

    expect(results.length).toBeLessThanOrEqual(2);
  });

  it('should include similarity scores for each concept', async () => {
    const results = await searchMultipleConcepts(['React', 'Router'], { limit: 1 });

    if (results.length > 0) {
      expect(results[0].conceptSimilarities).toBeDefined();
      expect(results[0].conceptSimilarities?.length).toBe(2);
      expect(results[0].averageSimilarity).toBeDefined();
    }
  });
});
