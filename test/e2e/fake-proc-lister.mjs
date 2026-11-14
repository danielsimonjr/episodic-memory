/**
 * Test seam for the orphan reaper: the module named by EPISODIC_MEMORY_PROC_LISTER.
 *
 * `cli/sync-hook.js` imports this file and calls `listClaudeProcs()` twice in one process: once
 * for the baseline before its spawn and once for the sweep after it. The hook then reaps every
 * process that appears only in the sweep and matches the SDK signatures. Without this seam the
 * hook lists the REAL `claude.exe` processes of the machine.
 *
 * Default: an empty list, on every call. A case that proves the reaper works writes the pid of a
 * sacrificial process it owns into the file named by E2E_LISTER_PID_FILE. The pid then appears on
 * the SECOND call only, so it is absent from the baseline and present in the sweep.
 *
 * The pid is reported ONLY when its REAL command line (queried from the OS now) contains the
 * per-run nonce in E2E_LISTER_NONCE. The test puts that nonce in the sacrificial child's argv.
 * So a stale or reused pid of a process the test does not own is never reported, and the
 * command line returned is the one the OS reports, never a fabricated one.
 */
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

/** Absolute paths: the child runs with an empty PATH (see harness.ts buildEnv). */
const POWERSHELL_WIN = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
const PS_POSIX = '/bin/ps';

let calls = 0;

/**
 * The real command line of `pid`, or null when the OS does not report one. A failed query returns
 * null and the lister reports nothing: a broken query shows as a missing reap, never as a kill.
 */
export function realCommandLine(pid) {
  try {
    if (process.platform === 'win32') {
      const script = `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}" | Select-Object -ExpandProperty CommandLine)`;
      const out = execFileSync(POWERSHELL_WIN, ['-NoProfile', '-NonInteractive', '-Command', script],
        { encoding: 'utf-8', timeout: 20000, windowsHide: true });
      return out.trim() || null;
    }
    const out = execFileSync(PS_POSIX, ['-o', 'args=', '-p', String(pid)],
      { encoding: 'utf-8', timeout: 15000 });
    return out.trim() || null;
  } catch {
    return null;
  }
}

/** Return the processes the reaper sees on this call. Module-scope state counts the calls. */
export function listClaudeProcs() {
  calls += 1;
  if (calls !== 2) return [];
  const file = process.env.E2E_LISTER_PID_FILE;
  if (!file) return [];
  // A missing or unreadable file throws. The hook catches the throw and logs that it could not
  // enumerate, so a broken positive control shows in the log and is never a silent pass.
  const pid = Number(readFileSync(file, 'utf-8').trim());
  if (!Number.isInteger(pid) || pid <= 0) throw new Error(`E2E_LISTER_PID_FILE holds no pid: ${file}`);
  const nonce = process.env.E2E_LISTER_NONCE;
  if (!nonce) return [];
  const commandLine = realCommandLine(pid);
  if (commandLine === null || !commandLine.includes(nonce)) return [];
  return [{ pid, commandLine }];
}
