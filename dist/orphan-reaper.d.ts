/**
 * Reaps the process tree the summariser's SDK call leaves behind.
 *
 * WHY THIS EXISTS. `callClaude` bounds its SDK call with an AbortController and a 120 s timeout.
 * That bound is real but it cannot reach the thing it is meant to bound: aborting stops the
 * PARENT iterating, while the `claude.exe --fork-session` child the SDK spawned — and the
 * transient daemon supervising it — keep running. Measured 2026-09-02: two such workers lived
 * 3 h 45 m against that 120 s timeout, accumulating CPU at ~1.2% with perfectly flat working
 * sets (an idle poll loop), and together accounted for 47 processes and ~5 GB.
 *
 * ORDER MATTERS, and this is not obvious: killing the workers alone is NOT enough. The transient
 * daemon RESPAWNS its pty-hosts within seconds — verified on a live machine. The daemon must die
 * first, then the workers.
 *
 * SAFETY. This kills only processes that (a) did not exist when the sync started, AND (b) match
 * one of the three SDK-plumbing signatures below. A human's session matches none of them: an
 * interactive session is `claude.exe --resume <name>` with no --fork-session, no `daemon run`,
 * and no --bg-pty-host. The baseline is what makes it safe to be wrong about the signature.
 */
export interface ProcSnapshot {
    pid: number;
    commandLine: string;
}
/**
 * Pure selection: which processes are ours to reap, in the order they must be killed.
 * Everything present in `baselinePids` is left alone no matter what it looks like — a process
 * that predates our sync is not our orphan, and that rule is what keeps a mis-tuned signature
 * from reaching a real session.
 *
 * `protectedPids` is the same rule for a different owner: a `learn` run lists the subprocesses
 * it is still using in `.learn.pids`, and those are young, signature-matching and NOT ours. The
 * baseline cannot cover them — they are born after the hook starts the sync — so the run's own
 * registry is the only thing that knows.
 */
export declare function selectOrphans(procs: ProcSnapshot[], baselinePids: Set<number>, protectedPids?: Set<number>): ProcSnapshot[];
