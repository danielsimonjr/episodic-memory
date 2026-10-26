import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { safeRmSync } from './test-utils.js';

const HOOK = new URL('../cli/sync-hook.js', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');

let dir: string;
let emptyBin: string;
let probe: string;
let probeLog: string;
let reservation: string;
let logPath: string;

// Every run sets the reentrancy guard, so a sync that a faulty hook starts exits at once, and points
// the model URL at a closed port. No test run can put a model on a shared GPU.
//
// PATH points at an empty directory, so the hook cannot list the processes of the machine. The hook
// then does no orphan reaping at all: a test run must not kill a daemon that another agent starts in
// the same few seconds. Without the reaper line in the log, the evidence that the hook started a sync
// comes from a preload script (NODE_OPTIONS) that records the arguments of every node process the run
// starts.
function runHook(env: Record<string, string>) {
  const inherited = Object.fromEntries(Object.entries(process.env).filter(([k]) => k.toUpperCase() !== 'PATH'));
  return spawnSync(process.execPath, [HOOK], {
    env: {
      ...inherited,
      PATH: emptyBin,
      NODE_OPTIONS: `--require "${probe.replace(/\\/g, '/')}"`,
      EM_PROBE_LOG: probeLog,
      EPISODIC_MEMORY_CONFIG_DIR: dir,
      FLEET_GPU_RESERVATION: reservation,
      EPISODIC_MEMORY_SUMMARIZER_GUARD: '1',
      EPISODIC_MEMORY_OLLAMA_URL: 'http://127.0.0.1:9',
      ...env,
    },
    input: '',
    encoding: 'utf-8',
    timeout: 60000,
  });
}

const readLog = () => (existsSync(logPath) ? readFileSync(logPath, 'utf-8') : '');
const startedProcesses = () => (existsSync(probeLog) ? readFileSync(probeLog, 'utf-8') : '');

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'em-hook-gpu-'));
  emptyBin = join(dir, 'empty-bin');
  mkdirSync(emptyBin);
  probe = join(dir, 'probe.cjs');
  probeLog = join(dir, 'started.log');
  writeFileSync(probe, "require('fs').appendFileSync(process.env.EM_PROBE_LOG, process.argv.slice(1).join(' ') + '\\n');");
  reservation = join(dir, 'gpu-reserved.json');
  logPath = join(dir, 'sync-errors.log');
});
afterEach(() => safeRmSync(dir));

describe('SessionStart sync hook', () => {
  it('skips the sync and says why while the GPU is reserved and the backend is ollama', () => {
    writeFileSync(reservation, JSON.stringify({ holder: 'Starship' }));

    const run = runHook({ EPISODIC_MEMORY_SUMMARIZER_BACKEND: 'ollama' });

    expect(run.status).toBe(0);
    expect(readLog()).toContain('SessionStart sync skipped: fleet GPU reserved by Starship');
    // The probe saw the hook itself, so it works; it saw no sync.
    expect(startedProcesses()).toContain('sync-hook.js');
    expect(startedProcesses()).not.toContain('sync --background');
  });

  it('starts the sync when the GPU is free', () => {
    const run = runHook({ EPISODIC_MEMORY_SUMMARIZER_BACKEND: 'ollama' });

    expect(run.status).toBe(0);
    expect(readLog()).not.toContain('skipped');
    expect(startedProcesses()).toContain('sync --background');
  });

  it('starts the sync under a reservation when the backend is not ollama', () => {
    writeFileSync(reservation, JSON.stringify({ holder: 'Starship' }));

    const run = runHook({ EPISODIC_MEMORY_SUMMARIZER_BACKEND: 'claude' });

    expect(run.status).toBe(0);
    expect(readLog()).not.toContain('skipped');
    expect(startedProcesses()).toContain('sync --background');
  });
});
