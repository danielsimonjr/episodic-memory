import type Database from 'better-sqlite3';
import { shouldSkipReentrantSync } from './reentrancy.js';
import { topicsEnabled } from './constants.js';
import type { TopicOptions, TopicResult } from './topic-job.js';

/**
 * The topic step of a sync run.
 *
 * Never throws, so a failure cannot stop the sync. With the flag off, or under the summarizer guard, the step
 * returns null and opens no database. The job and the database modules load only after those checks.
 *
 * @param opts the job options, and an open database. Without a database, the step opens and closes its own.
 */
export async function runTopicPhase(opts: TopicOptions & { db?: Database.Database } = {}): Promise<TopicResult | null> {
  if (!topicsEnabled() || shouldSkipReentrantSync()) return null;
  const owned = !opts.db;
  let db: Database.Database | undefined;
  try {
    const { runTopics } = await import('./topic-job.js');
    db = opts.db ?? (await import('./db.js')).initDatabase();
    const r = await runTopics(db, opts);
    const deferred = r.deferred ? `, deferred: ${r.deferred}` : '';
    console.error(
      `episodic-memory: topics: ${r.installed} installed, ${r.empty} empty, ${r.rejected} rejected, ` +
        `${r.stale} stale, ${r.skipped} skipped, ${r.failed} failed${deferred}`
    );
    return r;
  } catch (err) {
    console.error('episodic-memory: topic phase error:', err instanceof Error ? err.message : err);
    return null;
  } finally {
    if (owned) {
      try {
        db?.close();
      } catch {
        // Closing must not stop the sync.
      }
    }
  }
}
