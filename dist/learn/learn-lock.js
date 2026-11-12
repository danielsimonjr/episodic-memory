/**
 * One learning run at a time, and the PIDs that the run owns.
 *
 * `.learn.lock` lives in the index directory and goes through `lockfile.ts`.
 * `lockfile.ts` recovers a crashed run's lock with the same PID-liveness and age rules that sync and the embedding migration use.
 * When another run holds the lock, `acquireLock` returns `null`. The return value does not name the holder.
 * This module therefore reads the holder's PID from the file and puts that PID in the error.
 * A message such as "another run holds it" is not actionable. A message such as "pid 4212 holds it" is.
 *
 * The `.learn.pids` file lists the subprocesses that the run currently owns. The file holds one PID per line.
 * The run rewrites the file on every add and remove, and deletes the file on release.
 * The SessionStart orphan reaper reads that file and never touches a live run's processes (spec §7 rule 11).
 * The solver writes its registry here. The CLI owns the lifetime of a run, so the registry lives here, not in `agent-runner.ts`.
 *
 * This module is imported statically by `cli/sync-hook.js`, so it stays light:
 * `fs`, `path`, `../lockfile.js`, `../paths.js` and nothing else.
 */
import fs from 'fs';
import path from 'path';
import { acquireLock, isLockHeld, releaseLock } from '../lockfile.js';
import { getIndexDir } from '../paths.js';
/** The file name of the learning lock. The lock file lives in the index directory. */
export const LEARN_LOCK_NAME = '.learn.lock';
/** The file name of the PID list that a learning run keeps while the run is live. */
export const LEARN_PIDS_NAME = '.learn.pids';
/**
 * The code steals a stale lock after two hours.
 * `EPISODIC_MEMORY_LEARN_MAX_MINUTES` bounds a real run (60 by default). So two hours only ever reclaims a lock whose holder is gone.
 */
export const LEARN_LOCK_STALE_MS = 2 * 60 * 60 * 1000;
/** Another live run holds the lock. */
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
/**
 * Returns the path of the learning lock file in `indexDir`.
 *
 * @param indexDir The index directory that holds the lock.
 */
export function getLearnLockPath(indexDir) {
    return path.join(indexDir, LEARN_LOCK_NAME);
}
/**
 * Returns the path of the PID list file in `indexDir`.
 *
 * @param indexDir The index directory that holds the PID list.
 */
export function getLearnPidsPath(indexDir) {
    return path.join(indexDir, LEARN_PIDS_NAME);
}
/** The PID that a lock file names, or null when the function cannot read the file. */
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
 * Read the PIDs listed in `.learn.pids`.
 *
 * The function returns an empty set when the file is absent or unreadable.
 * The function also returns an empty set when the process named in `.learn.lock` is not alive.
 * A killed run leaves its file behind, and a dead run's PIDs must protect nothing.
 * The age of the lock does not count here. A live step can outlast the steal age, and its children
 * must stay protected.
 * The orphan reaper calls this function at reap time, so the function never throws.
 */
export function readLearnPids(indexDir) {
    const pids = new Set();
    try {
        if (!isLockHeld(getLearnLockPath(indexDir), Number.POSITIVE_INFINITY))
            return pids;
    }
    catch {
        return pids;
    }
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
 * The function releases the lock on every exit path. The function also deletes `.learn.pids` with the lock.
 * A PID file that outlives its run would make the reaper refuse to reap the next run's genuinely orphaned children.
 * A killed run skips that cleanup, so the function also deletes a left-over file when it takes the lock.
 */
export async function withLearnLock(fn) {
    const indexDir = getIndexDir();
    const lockPath = getLearnLockPath(indexDir);
    const pidsPath = getLearnPidsPath(indexDir);
    const handle = acquireLock(lockPath, LEARN_LOCK_STALE_MS);
    if (!handle)
        throw new LearnLockHeld(readHolderPid(lockPath), lockPath);
    try {
        // A run that never spawns a child never writes the file, so a killed run's list would stay.
        fs.rmSync(pidsPath, { force: true });
    }
    catch {
        // The registry rewrites the file on its first add, and the release removes the file.
    }
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
