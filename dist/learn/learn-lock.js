/**
 * One learning run at a time, and the PIDs it owns.
 *
 * `.learn.lock` lives in the index directory and goes through `lockfile.ts`, so
 * a crashed run's lock is recovered by the same PID-liveness and age rules the
 * sync and the embedding migration use. When it is held, `acquireLock` returns
 * `null` and does not say by whom, which is why this module reads the holder's
 * PID back out of the file and puts it in the error: "another run holds it" is
 * not actionable, "pid 4212 holds it" is.
 *
 * Beside it, `.learn.pids` lists the subprocesses the run currently owns — one
 * PID per line, rewritten on every add and remove, deleted on release. The
 * SessionStart orphan reaper reads that file and never touches a live run's
 * processes (spec §7 rule 11). The registry the solver writes to lives here and
 * not in `agent-runner.ts` because the CLI is what owns a run's lifetime.
 *
 * This module is imported statically by `cli/sync-hook.js`, so it stays light:
 * `fs`, `path`, `../lockfile.js`, `../paths.js` and nothing else.
 */
import fs from 'fs';
import path from 'path';
import { acquireLock, releaseLock } from '../lockfile.js';
import { getIndexDir } from '../paths.js';
export const LEARN_LOCK_NAME = '.learn.lock';
export const LEARN_PIDS_NAME = '.learn.pids';
/**
 * A stale lock is stealable after two hours. A real run is bounded by
 * `EPISODIC_MEMORY_LEARN_MAX_MINUTES` (60 by default), so two hours only ever
 * reclaims a lock whose holder is gone.
 */
export const LEARN_LOCK_STALE_MS = 2 * 60 * 60 * 1000;
/** The lock is held by another live run. */
export class LearnLockHeld extends Error {
    holderPid;
    lockPath;
    constructor(holderPid, lockPath) {
        super(holderPid === null
            ? `another learn run holds ${lockPath}`
            : `another learn run holds ${lockPath} (pid ${holderPid})`);
        this.holderPid = holderPid;
        this.lockPath = lockPath;
        this.name = 'LearnLockHeld';
    }
}
export function getLearnLockPath(indexDir) {
    return path.join(indexDir, LEARN_LOCK_NAME);
}
export function getLearnPidsPath(indexDir) {
    return path.join(indexDir, LEARN_PIDS_NAME);
}
/** The PID a lock file names, or null when it cannot be read. */
function readHolderPid(lockPath) {
    try {
        const pid = parseInt(fs.readFileSync(lockPath, 'utf-8').trim(), 10);
        return Number.isFinite(pid) && pid > 0 ? pid : null;
    }
    catch {
        return null;
    }
}
/**
 * The PIDs listed in `.learn.pids`, or an empty set when the file is absent or
 * unreadable. Used by the orphan reaper on its fast path, so it never throws.
 */
export function readLearnPids(indexDir) {
    const pids = new Set();
    let raw;
    try {
        raw = fs.readFileSync(getLearnPidsPath(indexDir), 'utf-8');
    }
    catch {
        return pids;
    }
    for (const line of raw.split('\n')) {
        const pid = parseInt(line.trim(), 10);
        if (Number.isFinite(pid) && pid > 0)
            pids.add(pid);
    }
    return pids;
}
/** A registry that mirrors itself into `<indexDir>/.learn.pids`. Best effort: never throws. */
function pidFileRegistry(pidsPath) {
    const live = new Set();
    const flush = () => {
        try {
            if (live.size === 0) {
                fs.rmSync(pidsPath, { force: true });
                return;
            }
            fs.writeFileSync(pidsPath, [...live].map(String).join('\n') + '\n', 'utf-8');
        }
        catch {
            // A run that cannot write its PID list must still run; the reaper's
            // baseline is the safety net when the list is short.
        }
    };
    return {
        add(pid) {
            if (!Number.isFinite(pid) || pid <= 0)
                return;
            live.add(pid);
            flush();
        },
        remove(pid) {
            if (live.delete(pid))
                flush();
        },
    };
}
/**
 * Hold the learning lock for the duration of `fn`.
 *
 * The lock is released on every exit path, and `.learn.pids` is deleted with it,
 * because a PID file that outlives its run would make the reaper refuse to reap
 * the next run's genuinely orphaned children.
 */
export async function withLearnLock(fn) {
    const indexDir = getIndexDir();
    const lockPath = getLearnLockPath(indexDir);
    const pidsPath = getLearnPidsPath(indexDir);
    const handle = acquireLock(lockPath, LEARN_LOCK_STALE_MS);
    if (!handle)
        throw new LearnLockHeld(readHolderPid(lockPath), lockPath);
    try {
        return await fn(pidFileRegistry(pidsPath));
    }
    finally {
        try {
            fs.rmSync(pidsPath, { force: true });
        }
        catch {
            // Nothing to clean up, or a locked file: the run is over either way.
        }
        releaseLock(handle);
    }
}
