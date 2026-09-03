#!/usr/bin/env node
/**
 * SessionStart hook entry point. Runs sync --background and logs failures to
 * sync-errors.log so hook stderr is not silently lost. Always exits 0 so hooks
 * stay non-blocking (upstream #94).
 */
import { spawn, execFileSync } from 'child_process';
import { selectOrphans } from '../dist/orphan-reaper.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const episodicMemory = path.join(__dirname, 'episodic-memory.js');


// --- orphan reaping ------------------------------------------------------------------------
// The summariser's SDK call is bounded by a 120 s AbortController, but aborting stops the PARENT
// iterating and does NOT terminate the claude.exe --fork-session child or the transient daemon
// supervising it. Measured 2026-09-02: two workers lived 3 h 45 m against that 120 s bound,
// ~47 processes and ~5 GB between them. So: snapshot before, sweep after.
function listClaudeProcs() {
  try {
    if (process.platform !== 'win32') {
      const out = execFileSync('ps', ['-eo', 'pid=,args='], {encoding: 'utf8', timeout: 15000});
      return out.split('\n').map((l) => l.trim()).filter(Boolean).map((l) => {
        const i = l.indexOf(' ');
        return {pid: Number(l.slice(0, i)), commandLine: l.slice(i + 1)};
      }).filter((x) => Number.isFinite(x.pid) && /claude/i.test(x.commandLine));
    }
    const ps = "Get-CimInstance Win32_Process -Filter \"Name='claude.exe'\" | " +
               "Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress";
    const out = execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps],
      {encoding: 'utf8', timeout: 20000});
    const raw = JSON.parse(out || '[]');
    const arr = Array.isArray(raw) ? raw : [raw];
    return arr.filter(Boolean).map((r) => ({pid: r.ProcessId, commandLine: r.CommandLine || ''}));
  } catch {
    return null;   // FAIL OPEN: if we cannot enumerate, we reap NOTHING.
  }
}

function reapOrphans(baselinePids, logPath, formatLogLine) {
  // EVERY PATH LOGS, INCLUDING THE QUIET ONE. This function used to `return` silently on three
  // separate paths - enumeration failure, an empty victim list, and all-kills-failing - so
  // "ran and found nothing" was INDISTINGUISHABLE from "never ran". On 2026-09-02 five orphans
  // survived a run and the log held zero Reaped lines; that fact carried NO information and I
  // could not tell which had happened. A reaper that speaks only when it kills is unfalsifiable.
  const note = (level, msg) => {
    try { fs.appendFileSync(logPath, formatLogLine(level, `orphan-reaper: ${msg}`), 'utf-8'); } catch {}
  };

  const procs = listClaudeProcs();
  if (!procs) {
    note('warn', 'could not enumerate processes - reaped NOTHING (failing open, by design)');
    return;
  }
  const victims = selectOrphans(procs, baselinePids);
  if (!victims.length) {
    note('info', `ran, ${procs.length} claude process(es) seen, ${baselinePids.size} in baseline, 0 to reap`);
    return;
  }
  const killed = [];
  const failed = [];
  for (const v of victims) {
    try {
      process.kill(v.pid, 'SIGKILL');
      killed.push(v.pid);
    } catch (e) {
      failed.push(`${v.pid} (${e && e.code ? e.code : 'unknown'})`);
    }
  }
  // Report BOTH outcomes. A kill list that silently all-failed previously logged nothing at all,
  // which reads exactly like a clean run.
  note(killed.length ? 'warn' : 'error',
    `ran, ${victims.length} orphan(s) selected, ${killed.length} killed${killed.length ? ' [' + killed.join(', ') + ']' : ''}` +
    (failed.length ? `, ${failed.length} FAILED [${failed.join(', ')}]` : ''));
}

async function main() {
  const { getSyncErrorsLogPath, formatLogLine } = await import('../dist/logging.js');
  const logPath = getSyncErrorsLogPath();

  // Baseline BEFORE launch - the rule that makes reaping safe. Anything already running is
  // never ours, however much it looks like plumbing.
  const baselineProcs = listClaudeProcs();
  const baselinePids = new Set((baselineProcs || []).map((x) => x.pid));
  const canReap = baselineProcs !== null;   // no baseline -> no reaping, ever

  const child = spawn(process.execPath, [episodicMemory, 'sync', '--background'], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: process.env,
  });

  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => {
    stdout += chunk;
  });
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });

  child.on('close', (code) => {
    if (canReap) reapOrphans(baselinePids, logPath, formatLogLine);
    if (code !== 0) {
      const detail = [stderr.trim(), stdout.trim()].filter(Boolean).join(' | ');
      fs.appendFileSync(
        logPath,
        formatLogLine('error', `SessionStart sync hook failed (exit ${code}): ${detail || 'no output'}`),
        'utf-8'
      );
    }
    process.exit(0);
  });

  child.on('error', (err) => {
    fs.appendFileSync(
      logPath,
      formatLogLine('error', `SessionStart sync hook spawn failed: ${err.message}`),
      'utf-8'
    );
    process.exit(0);
  });
}

main().catch((err) => {
  import('../dist/logging.js')
    .then(({ getSyncErrorsLogPath, formatLogLine }) => {
      fs.appendFileSync(
        getSyncErrorsLogPath(),
        formatLogLine('error', `SessionStart sync hook unexpected error: ${err.message}`),
        'utf-8'
      );
    })
    .finally(() => process.exit(0));
});
