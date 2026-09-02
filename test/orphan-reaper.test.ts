import { describe, it, expect } from 'vitest';
import { selectOrphans, type ProcSnapshot } from '../src/orphan-reaper.js';

const p = (pid: number, commandLine: string): ProcSnapshot => ({ pid, commandLine });

// Real command lines observed on a live machine 2026-09-02. String.raw because Windows paths
// are full of backslashes and a bare string turns \1 into a legacy octal escape (which is a
// hard error in an ES module, and cost one RED run to notice).
const DAEMON = p(23324, String.raw`claude.exe daemon run --origin transient --spawned-by {"label":"claude","cwd":"C:\Users\danie\Github","pid":17648}`);
const PTY    = p(4300,  String.raw`claude.exe --bg-pty-host \.\pipe\cc-daemon-f89674ac-pty-3a699f1f 157 62 -- claude.exe --session-id 3a699f1f --fork-session --resume C:\Users\danie\.claude\projects\C--Users-danie-Github\17dd5da0.jsonl`);
const FORK   = p(25644, String.raw`claude.exe --session-id 3a699f1f --fork-session --resume C:\Users\danie\.claude\projects\C--Users-danie-Github\17dd5da0.jsonl --model claude-opus-5 --permission-mode bypassPermissions`);
// A human's interactive session - the shape that must NEVER be touched.
const HUMAN  = p(25452, String.raw`"claude.exe" --resume Mothership --dangerously-skip-permissions --remote-control`);
const HUMAN2 = p(23252, String.raw`"claude.exe" --resume ZBOOK_Home --dangerously-skip-permissions --remote-control`);

describe('orphan reaper selection', () => {
  it('selects daemon, pty-host and fork - and returns the DAEMON FIRST', () => {
    // Order is load-bearing: killing workers alone lets the daemon respawn them within seconds.
    const got = selectOrphans([FORK, HUMAN, PTY, DAEMON], new Set());
    expect(got.map((x) => x.pid)).toEqual([23324, 4300, 25644]);
  });

  // The whole safety argument rests on this: anything predating the sync is untouchable.
  it('never selects a process that existed BEFORE the sync started', () => {
    const baseline = new Set([23324, 4300, 25644]);
    expect(selectOrphans([DAEMON, PTY, FORK], baseline)).toEqual([]);
  });

  // CONTROL: without this, "it kills the orphans" cannot be told apart from "it kills everything".
  it('never selects a human interactive session, even with an empty baseline', () => {
    expect(selectOrphans([HUMAN, HUMAN2], new Set())).toEqual([]);
  });

  it('leaves humans alone while reaping orphans in the same sweep', () => {
    const got = selectOrphans([HUMAN, DAEMON, HUMAN2, FORK, PTY], new Set());
    expect(got.map((x) => x.pid)).toEqual([23324, 4300, 25644]);
    expect(got.some((x) => x.pid === 25452 || x.pid === 23252)).toBe(false);
  });

  it('classifies each process exactly once', () => {
    const got = selectOrphans([DAEMON, PTY, FORK], new Set());
    expect(new Set(got.map((x) => x.pid)).size).toBe(got.length);
  });

  it('is empty when nothing new appeared', () => {
    expect(selectOrphans([HUMAN], new Set([25452]))).toEqual([]);
  });
});
