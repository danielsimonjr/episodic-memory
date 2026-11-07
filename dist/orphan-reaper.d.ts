/**
 * Reaps the process tree the summariser's SDK call leaves behind.
 *
 * WHY THE REAPER EXISTS. `callClaude` bounds its SDK call with an AbortController and a 120 s timeout.
 * That bound is real. But the bound cannot reach the processes that the timeout is meant to bound.
 * Aborting stops the PARENT iterating. The `claude.exe --fork-session` child the SDK spawned
 * keeps running, and so does the transient daemon supervising the child. Such workers outlive
 * the 120 s timeout by hours. They poll while idle, and together they hold dozens of processes
 * and gigabytes of memory.
 *
 * ORDER MATTERS, and the ordering is not obvious: killing the workers alone is NOT enough. The transient
 * daemon RESPAWNS its pty-hosts within seconds — verified on a live machine. The daemon must die
 * first, then the workers.
 *
 * SAFETY. The reaper kills only processes that (a) did not exist when the sync started. Such a
 * process must also (b) match one of the three SDK-plumbing signatures below. A human's session
 * matches none of them. The reason: an interactive session is `claude.exe --resume <name>` with
 * no --fork-session, no `daemon run`, and no --bg-pty-host. The baseline is what makes the
 * reaper safe to be wrong about the signature.
 */
/** One process from the process table: its pid and its full command line. */
export interface ProcSnapshot {
    pid: number;
    commandLine: string;
}
/**
 * Pure selection: which processes are ours to reap, in the order they must be killed.
 * Everything present in `baselinePids` is left alone, no matter what it looks like.
 * A process that predates our sync is not our orphan. That rule keeps a mis-tuned signature
 * from reaching a real session.
 *
 * `protectedPids` is the same rule for a different owner. A `learn` run lists the subprocesses
 * that the run still uses in `.learn.pids`. The listed subprocesses are young, signature-matching,
 * and NOT ours. The baseline cannot cover the listed subprocesses. The subprocesses are born
 * after the hook starts the sync. So the run's own registry is the only thing that knows.
 */
export declare function selectOrphans(procs: ProcSnapshot[], baselinePids: Set<number>, protectedPids?: Set<number>): ProcSnapshot[];
