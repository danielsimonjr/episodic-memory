import type Database from 'better-sqlite3';
import { digestEnabled, runDigest, type DigestOptions, type DigestResult } from './digest-job.js';
import { initDatabase } from './db.js';

/**
 * The digest step of a sync run. Never throws and never blocks the sync: with the flag off it does nothing,
 * and any failure is logged and swallowed so the next run retries.
 */
export async function runDigestPhase(opts: DigestOptions & { db?: Database.Database } = {}): Promise<DigestResult | null> {
  if (!digestEnabled()) return null;
  const owned = !opts.db;
  let db: Database.Database | undefined;
  try {
    db = opts.db ?? initDatabase();
    const r = await runDigest(db, opts);
    console.error(
      `episodic-memory: digest: ${r.written} written, ${r.compressed ?? 0} compressed, ${r.skipped} skipped, ${r.failed} failed`
    );
    return r;
  } catch (err) {
    console.error('episodic-memory: digest phase error:', err instanceof Error ? err.message : err);
    return null;
  } finally {
    if (owned) db?.close();
  }
}
