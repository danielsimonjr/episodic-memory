/**
 * The SessionStart hooks of `hooks/hooks.json`, run as children with the payload that Claude Code
 * sends on stdin. Each case asserts an effect: an archive copy, a lock, a worker process, a killed
 * process, digest text on stdout, or a folder that the hook did or did not create. A hook's log
 * line is never the only signal.
 *
 * A case that fails because the PRODUCT is wrong is `it.skip('Dn pending: ...')`, with the measured
 * input and output in its title. No assertion is weakened to make a case pass.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  CLI_DIR, REPO_ROOT, cliBin, fakeOllama, makeSandbox, newSyncWorkers, openIndexDb, readHookLog,
  removeSandbox, runCli, runHook, seedDigestableSession, seedTranscript, syncLockPath, syncWorkerPids,
  waitForBackgroundSync, type FakeOllama, type Sandbox,
} from './harness.js';
import { useIsolation } from './isolation.js';

useIsolation();

/** The hook registry of the plugin. The test reads it; it never edits it. */
const HOOKS_JSON = path.join(REPO_ROOT, 'hooks', 'hooks.json');
/** The hooks that the registry names today. A new hook in the file fails the registry case until it is listed here. */
const KNOWN_HOOKS = ['digest-hook', 'sync-hook'];
/** The budget of one hook process, and of one foreground child (the case timeout is 120 s). */
const HOOK_MS = 100_000;
const CHILD_MS = 100_000;
/** The budget of a case that waits for the detached sync worker. */
const CASE_MS = 300_000;
const WORKER_MS = 240_000;

/** The script names of every command in hooks/hooks.json, in file order. */
function hookNamesFromRegistry(): string[] {
  const config = JSON.parse(readFileSync(HOOKS_JSON, 'utf-8')) as {
    hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>>;
  };
  const names: string[] = [];
  for (const groups of Object.values(config.hooks)) {
    for (const group of groups) {
      for (const hook of group.hooks) {
        const match = /cli\/([A-Za-z-]+)\.js/.exec(hook.command);
        if (!match) throw new Error(`hooks.json command names no cli/*.js script: ${hook.command}`);
        names.push(match[1]);
      }
    }
  }
  return names;
}

const REGISTERED = hookNamesFromRegistry();

/** The SessionStart payload of Claude Code: the fields a hook reads, and the ones it ignores. */
function payloadFor(cwd: string): object {
  return {
    session_id: randomUUID(),
    transcript_path: path.join(cwd, 'session.jsonl'),
    cwd,
    hook_event_name: 'SessionStart',
    source: 'startup',
  };
}

/**
 * The Claude project folder of a working directory. Claude names it with every non-alphanumeric
 * character replaced by `-`, which is the rule of src/digest-inject.ts (projectKeyFromCwd).
 */
function projectOf(cwd: string): string {
  return cwd.replace(/[^A-Za-z0-9]/g, '-');
}

/** The archived copies of one transcript file name under the archive folder. A missing folder holds none. */
function archivedCopies(sb: Sandbox, fileName: string): string[] {
  const found: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name === fileName) found.push(full);
    }
  };
  if (existsSync(sb.archive)) walk(sb.archive);
  return found;
}

/** Remove a sandbox that the case did not hand to `waitForBackgroundSync` (which removes it itself). */
function dropSandbox(sb: Sandbox): void {
  if (existsSync(sb.root)) removeSandbox(sb);
}

describe('hooks: registry', () => {
  it('registers exactly the known hooks, and each script exists in cli/', () => {
    expect([...REGISTERED].sort()).toEqual([...KNOWN_HOOKS].sort());
    for (const name of REGISTERED) expect(existsSync(path.join(CLI_DIR, `${name}.js`))).toBe(true);
  });
});

describe('hooks: each registered hook', () => {
  it.each(REGISTERED)('%s runs with a SessionStart payload and exits 0', async (name) => {
    const sb = makeSandbox();
    try {
      const before = syncWorkerPids();
      const result = await runCli(sb, cliBin(`${name}.js`), [], {
        stdin: JSON.stringify(payloadFor(path.join(sb.root, 'work'))),
        timeoutMs: HOOK_MS,
      });
      expect(result.code, result.stderr).toBe(0);
      if (name === 'sync-hook') await waitForBackgroundSync(sb, before, WORKER_MS);
    } finally {
      dropSandbox(sb);
    }
  }, CASE_MS);
});

describe('hooks: SessionStart sync archives in the background', () => {
  it('archives a seeded transcript, indexes its exchanges, and leaves no sync worker behind', async () => {
    const sb = makeSandbox();
    try {
      const cwd = path.join(sb.root, 'work');
      const project = projectOf(cwd);
      const file = seedTranscript(sb, project, 'short-conversation.jsonl');
      const name = path.basename(file);
      const before = syncWorkerPids();
      const hook = await runHook(sb, 'sync-hook', payloadFor(cwd), {
        env: { EPISODIC_MEMORY_SKIP_SUMMARIES: '1' }, timeoutMs: HOOK_MS,
      });
      expect(hook.code, hook.stderr).toBe(0);
      // The worker writes the archive and the index. The inspect callback reads both while the sandbox exists.
      await waitForBackgroundSync(sb, before, WORKER_MS, () => {
        expect(archivedCopies(sb, name)).toHaveLength(1);
        const db = openIndexDb(sb);
        try {
          const rows = db.prepare('SELECT COUNT(*) AS n FROM exchanges WHERE project = ?').get(project) as { n: number };
          expect(rows.n).toBeGreaterThan(0);
        } finally {
          db.close();
        }
      });
    } finally {
      dropSandbox(sb);
    }
  }, CASE_MS);
});

describe('hooks: auto-sync off', () => {
  it('EPISODIC_MEMORY_DISABLE_AUTO_SYNC=1 starts no worker, takes no lock and archives nothing', async () => {
    const sb = makeSandbox();
    try {
      const cwd = path.join(sb.root, 'work');
      const name = path.basename(seedTranscript(sb, projectOf(cwd), 'short-conversation.jsonl'));
      const before = syncWorkerPids();
      const hook = await runHook(sb, 'sync-hook', payloadFor(cwd), {
        env: { EPISODIC_MEMORY_DISABLE_AUTO_SYNC: '1' }, timeoutMs: HOOK_MS,
      });
      expect(hook.code, hook.stderr).toBe(0);
      expect(newSyncWorkers(before, syncWorkerPids())).toEqual([]);
      expect(existsSync(syncLockPath(sb))).toBe(false);
      expect(archivedCopies(sb, name)).toEqual([]);
      // Control: the same transcript is syncable. A foreground sync, which the switch does not stop, archives it.
      const sync = await runCli(sb, cliBin('episodic-memory.js'), ['sync'], {
        env: { EPISODIC_MEMORY_SKIP_SUMMARIES: '1' }, timeoutMs: CHILD_MS,
      });
      expect(sync.code, sync.stderr).toBe(0);
      expect(archivedCopies(sb, name)).toHaveLength(1);
    } finally {
      dropSandbox(sb);
    }
  }, CASE_MS);

  it('sync-hook with EPISODIC_MEMORY_DISABLE_AUTO_SYNC=1 on an empty config folder creates no folder (D11)', async () => {
    const sb = makeSandbox();
    try {
      const hook = await runHook(sb, 'sync-hook', payloadFor(path.join(sb.root, 'work')), {
        env: { EPISODIC_MEMORY_DISABLE_AUTO_SYNC: '1' }, timeoutMs: HOOK_MS,
      });
      expect(hook.code, hook.stderr).toBe(0);
      expect(existsSync(sb.index)).toBe(false);
    } finally {
      dropSandbox(sb);
    }
  }, CASE_MS);
});

describe('hooks: GPU reservation', () => {
  it('a reservation that names a holder defers the SessionStart sync: the log names the holder, and no worker, lock or archive appears', async () => {
    const sb = makeSandbox();
    try {
      const cwd = path.join(sb.root, 'work');
      const name = path.basename(seedTranscript(sb, projectOf(cwd), 'short-conversation.jsonl'));
      const reserved = path.join(sb.root, 'reserved.json');
      writeFileSync(reserved, JSON.stringify({ holder: 'e2e-bench', why: 'e2e hook case', since: new Date().toISOString() }), 'utf-8');
      const before = syncWorkerPids();
      const hook = await runHook(sb, 'sync-hook', payloadFor(cwd), {
        env: { FLEET_GPU_RESERVATION: reserved }, timeoutMs: HOOK_MS,
      });
      expect(hook.code, hook.stderr).toBe(0);
      expect(readHookLog(sb)).toContain('SessionStart sync skipped: fleet GPU reserved by e2e-bench');
      expect(newSyncWorkers(before, syncWorkerPids())).toEqual([]);
      expect(existsSync(syncLockPath(sb))).toBe(false);
      expect(archivedCopies(sb, name)).toEqual([]);
    } finally {
      dropSandbox(sb);
    }
  }, CASE_MS);

  it('with no reservation file (the GPU is free) the same transcript is archived by the background sync', async () => {
    const sb = makeSandbox();
    try {
      const cwd = path.join(sb.root, 'work');
      const name = path.basename(seedTranscript(sb, projectOf(cwd), 'short-conversation.jsonl'));
      const before = syncWorkerPids();
      const hook = await runHook(sb, 'sync-hook', payloadFor(cwd), {
        env: { EPISODIC_MEMORY_SKIP_SUMMARIES: '1' }, timeoutMs: HOOK_MS,
      });
      expect(hook.code, hook.stderr).toBe(0);
      expect(readHookLog(sb)).not.toContain('SessionStart sync skipped');
      await waitForBackgroundSync(sb, before, WORKER_MS, () => {
        expect(archivedCopies(sb, name)).toHaveLength(1);
      });
    } finally {
      dropSandbox(sb);
    }
  }, CASE_MS);
});

/** A sacrificial process that the test owns. Its argv carries the fork marker that the reaper signature needs. */
function startFork(script: string, tag: string): ChildProcess {
  const child = spawn(process.execPath, [script, '--fork-session', tag], { stdio: 'ignore', windowsHide: true });
  if (child.pid === undefined) throw new Error(`could not start the sacrificial child ${script}`);
  return child;
}

/** Resolve once the OS has started the child, so its command line can be read. */
function spawned(child: ChildProcess): Promise<void> {
  return new Promise((resolve) => child.once('spawn', () => resolve()));
}

/** Resolve true when `child` exits within `ms`, false when it is still running. */
function exitedWithin(child: ChildProcess, ms: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), ms);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

/** A script that sleeps for two minutes. The test kills it in `finally`. */
function sleeperScript(sb: Sandbox): string {
  const file = path.join(sb.root, 'sleeper.cjs');
  writeFileSync(file, 'setTimeout(() => {}, 120000);\n', 'utf-8');
  return file;
}

/** Write the pid that the fake lister reports on the hook's second process-list call. */
function writePidFile(sb: Sandbox, pid: number): string {
  const file = path.join(sb.root, 'lister-pid.txt');
  writeFileSync(file, String(pid), 'utf-8');
  return file;
}

describe('hooks: orphan reaper', () => {
  it('kills the one process the lister reports (its nonce is in its real argv) and logs the kill', async () => {
    const sb = makeSandbox();
    const nonce = `e2e-nonce-${randomUUID()}`;
    const victim = startFork(sleeperScript(sb), nonce);
    try {
      await spawned(victim);
      const hook = await runHook(sb, 'sync-hook', payloadFor(path.join(sb.root, 'work')), {
        env: {
          EPISODIC_MEMORY_DISABLE_AUTO_SYNC: '1',
          E2E_LISTER_PID_FILE: writePidFile(sb, victim.pid!),
          E2E_LISTER_NONCE: nonce,
        },
        timeoutMs: HOOK_MS,
      });
      expect(hook.code, hook.stderr).toBe(0);
      expect(await exitedWithin(victim, 15_000)).toBe(true);
      expect(readHookLog(sb)).toContain(`1 orphan(s) selected (0 protected by learn), 1 killed [${victim.pid}]`);
    } finally {
      victim.kill();
      dropSandbox(sb);
    }
  }, CASE_MS);

  it('leaves a fork-marked process alive when the lister does not report it: its argv lacks the nonce', async () => {
    const sb = makeSandbox();
    const control = startFork(sleeperScript(sb), `control-${randomUUID()}`);
    try {
      await spawned(control);
      const hook = await runHook(sb, 'sync-hook', payloadFor(path.join(sb.root, 'work')), {
        env: {
          EPISODIC_MEMORY_DISABLE_AUTO_SYNC: '1',
          E2E_LISTER_PID_FILE: writePidFile(sb, control.pid!),
          E2E_LISTER_NONCE: `e2e-nonce-${randomUUID()}`,
        },
        timeoutMs: HOOK_MS,
      });
      expect(hook.code, hook.stderr).toBe(0);
      // The lister refuses the pid: zero processes are seen, so the reaper selects nothing.
      expect(readHookLog(sb)).toContain('ran, 0 claude process(es) seen');
      expect(readHookLog(sb)).toContain('0 to reap');
      expect(await exitedWithin(control, 1_000)).toBe(false);
      expect(() => process.kill(control.pid!, 0)).not.toThrow();
    } finally {
      control.kill();
      dropSandbox(sb);
    }
  }, CASE_MS);
});

/** Run a foreground sync with the digest on and the fake model, so the index holds a digest row for `project`. */
async function syncWithDigest(sb: Sandbox, fake: FakeOllama): Promise<void> {
  const before = fake.requests.length;
  const sync = await runCli(sb, cliBin('episodic-memory.js'), ['sync'], {
    env: { EPISODIC_MEMORY_OLLAMA_URL: fake.url, EPISODIC_MEMORY_DIGEST: '1' }, timeoutMs: CHILD_MS,
  });
  expect(sync.code, sync.stderr).toBe(0);
  // The fake answered the digest prompt: a zero-write run would not show it.
  expect(fake.requests.slice(before).map((r) => r.kind)).toContain('digest');
}

describe('hooks: digest', () => {
  it('prints nothing and makes no model call with EPISODIC_MEMORY_DIGEST unset, on an indexed project', async () => {
    const sb = makeSandbox();
    const fake = await fakeOllama('ok');
    try {
      const cwd = path.join(sb.root, 'work');
      seedDigestableSession(sb, projectOf(cwd), { exchanges: 2, ageMinutes: 60 });
      await syncWithDigest(sb, fake);
      const calls = fake.requests.length;
      const off = await runHook(sb, 'digest-hook', payloadFor(cwd), {
        env: { EPISODIC_MEMORY_OLLAMA_URL: fake.url }, timeoutMs: HOOK_MS,
      });
      expect(off.code, off.stderr).toBe(0);
      expect(off.stdout).toBe('');
      expect(fake.requests.length).toBe(calls);
    } finally {
      await fake.close();
      dropSandbox(sb);
    }
  }, CASE_MS);

  it('emits the digest as additionalContext with EPISODIC_MEMORY_DIGEST=1, and prints nothing under the summarizer guard', async () => {
    const sb = makeSandbox();
    const fake = await fakeOllama('ok');
    try {
      const cwd = path.join(sb.root, 'work');
      seedDigestableSession(sb, projectOf(cwd), { exchanges: 2, ageMinutes: 60 });
      await syncWithDigest(sb, fake);
      const on = await runHook(sb, 'digest-hook', payloadFor(cwd), {
        env: { EPISODIC_MEMORY_DIGEST: '1' }, timeoutMs: HOOK_MS,
      });
      expect(on.code, on.stderr).toBe(0);
      const out = JSON.parse(on.stdout) as { hookSpecificOutput: { hookEventName: string; additionalContext: string } };
      expect(out.hookSpecificOutput.hookEventName).toBe('SessionStart');
      expect(out.hookSpecificOutput.additionalContext).toContain('The user asked about X.');
      const guarded = await runHook(sb, 'digest-hook', payloadFor(cwd), {
        env: { EPISODIC_MEMORY_DIGEST: '1', EPISODIC_MEMORY_SUMMARIZER_GUARD: '1' }, timeoutMs: HOOK_MS,
      });
      expect(guarded.code, guarded.stderr).toBe(0);
      expect(guarded.stdout).toBe('');
    } finally {
      await fake.close();
      dropSandbox(sb);
    }
  }, CASE_MS);
});

describe('hooks: empty config folder', () => {
  it('the digest hook with the flag unset creates nothing in an empty config folder', async () => {
    const sb = makeSandbox();
    try {
      const hook = await runHook(sb, 'digest-hook', payloadFor(path.join(sb.root, 'work')), { timeoutMs: HOOK_MS });
      expect(hook.code, hook.stderr).toBe(0);
      expect(readdirSync(sb.cfg)).toEqual([]);
    } finally {
      dropSandbox(sb);
    }
  }, CASE_MS);

  it('digest-hook with EPISODIC_MEMORY_DIGEST=1 on an empty config folder creates no folder (D4)', async () => {
    const sb = makeSandbox();
    try {
      const hook = await runHook(sb, 'digest-hook', payloadFor(path.join(sb.root, 'work')), {
        env: { EPISODIC_MEMORY_DIGEST: '1' }, timeoutMs: HOOK_MS,
      });
      expect(hook.code, hook.stderr).toBe(0);
      expect(existsSync(sb.index)).toBe(false);
    } finally {
      dropSandbox(sb);
    }
  }, CASE_MS);
});
