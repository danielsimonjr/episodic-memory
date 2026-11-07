import { digestEnabled, runDigest } from './digest-job.js';
import { initDatabase } from './db.js';
/**
 * The digest step of a sync run.
 *
 * Never throws, so a failure cannot stop the sync. With the flag off, the digest step does nothing.
 * The digest step logs and swallows any failure, so the next run retries.
 */
export async function runDigestPhase(opts = {}) {
    if (!digestEnabled())
        return null;
    const owned = !opts.db;
    let db;
    try {
        db = opts.db ?? initDatabase();
        const r = await runDigest(db, opts);
        console.error(`episodic-memory: digest: ${r.written} written, ${r.compressed ?? 0} compressed, ${r.skipped} skipped, ${r.failed} failed`);
        return r;
    }
    catch (err) {
        console.error('episodic-memory: digest phase error:', err instanceof Error ? err.message : err);
        return null;
    }
    finally {
        if (owned)
            db?.close();
    }
}
