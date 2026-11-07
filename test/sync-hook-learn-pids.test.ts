import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { safeRmSync } from './test-utils.js';

const HOOK = new URL('../cli/sync-hook.js', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');

let dir: string;
let emptyBin: string;
let lister: string;
let logPath: string;
let indexDir: string;

// Two processes that both match the reaper's shapes. One is listed in `.learn.pids` (a live run
// owns it); the other is not, i.e. a genuine orphan this hook is supposed to reap. The PIDs are
// chosen free at test time: the hook really calls `process.kill`, and this suite must never be
// able to signal a live process on the machine.
const taken = new Set<number>();
const PROTECTED = freePid();
const ORPHAN = freePid();

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: any) {
    return err?.code === 'EPERM';
  }
}

/** A high, currently-unused PID, different on every call. */
function freePid(): number {
  for (let pid = 4_190_000 + Math.floor(Math.random() * 1000); pid > 4_000_000; pid -= 1) {
    if (!pidAlive(pid) && !taken.has(pid)) {
      taken.add(pid);
      return pid;
    }
  }
  throw new Error('no free PID found for the reaper test');
}

function commandLine(pid: number): string {
  return `${pid} claude.exe --session-id x --fork-session --resume C:\\archive\\s.jsonl`;
}

/**
 * A fake process lister.
 *
 * The answer changes per call. The reason: the hook lists once for the baseline, before spawning
 * the sync, and once more to reap. Both processes therefore appear only in the second listing.
 * Appearing there is exactly the "born during the sync" case that makes a baseline insufficient.
 */
function writeLister(): void {
  lister = join(dir, 'lister.mjs');
  const counter = join(dir, 'lists.txt');
  writeFileSync(
    lister,
    `import { appendFileSync, existsSync, readFileSync } from 'fs';
const counter = ${JSON.stringify(counter)};
export function listClaudeProcs() {
  const lists = existsSync(counter) ? readFileSync(counter, 'utf-8').length : 0;
  appendFileSync(counter, 'x');
  if (lists === 0) return [];
  return [
    { pid: ${PROTECTED}, commandLine: ${JSON.stringify(commandLine(PROTECTED))} },
    { pid: ${ORPHAN}, commandLine: ${JSON.stringify(commandLine(ORPHAN))} },
  ];
}
`,
    'utf-8'
  );
}

function runHook(extraEnv: Record<string, string> = {}) {
  const inherited = Object.fromEntries(
    Object.entries(process.env).filter(([k]) => k.toUpperCase() !== 'PATH')
  );
  return spawnSync(process.execPath, [HOOK], {
    env: {
      ...inherited,
      PATH: emptyBin,
      EPISODIC_MEMORY_CONFIG_DIR: dir,
      EPISODIC_MEMORY_SUMMARIZER_GUARD: '1',
      EPISODIC_MEMORY_OLLAMA_URL: 'http://127.0.0.1:9',
      FLEET_GPU_RESERVATION: join(dir, 'no-reservation.json'),
      EPISODIC_MEMORY_PROC_LISTER: lister,
      ...extraEnv,
    },
    input: '',
    encoding: 'utf-8',
    timeout: 60000,
  });
}

const readLog = () => (existsSync(logPath) ? readFileSync(logPath, 'utf-8') : '');

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'em-hook-learn-'));
  emptyBin = join(dir, 'empty-bin');
  mkdirSync(emptyBin);
  indexDir = join(dir, 'conversation-index');
  mkdirSync(indexDir, { recursive: true });
  logPath = join(dir, 'sync-errors.log');
  writeLister();
});

afterEach(() => safeRmSync(dir));

describe('SessionStart hook and a live learn run', () => {
  it('never kills a PID listed in .learn.pids, and reaps the one that is not', () => {
    writeFileSync(join(indexDir, '.learn.pids'), `${PROTECTED}\n`, 'utf-8');

    const run = runHook();

    expect(run.status).toBe(0);
    const log = readLog();
    // The orphan is selected (the kill itself fails: no such process, which is
    // the point of using a free PID). The protected PID must appear nowhere.
    expect(log).toContain(String(ORPHAN));
    expect(log).not.toContain(String(PROTECTED));
    // The reaper reports what it protected, so "nothing killed" cannot be mistaken for "never ran".
    expect(log).toContain('1 protected by learn');
  });

  it('reaps both when no learn run is live', () => {
    const run = runHook();

    expect(run.status).toBe(0);
    const log = readLog();
    expect(log).toContain(String(PROTECTED));
    expect(log).toContain(String(ORPHAN));
    expect(log).toContain('0 protected by learn');
  });
});
