#!/usr/bin/env node
/**
 * SessionStart hook entry point. Runs sync --background and logs failures to
 * sync-errors.log so hook stderr is not silently lost. Always exits 0 so hooks
 * stay non-blocking (upstream #94).
 */
import { spawn, execFileSync } from 'child_process';
import { selectOrphans } from '../dist/orphan-reaper.js';
import { readLearnPids } from '../dist/learn/learn-lock.js';
import { getIndexDir } from '../dist/paths.js';
import { ensureDeps } from './ensure-deps.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const episodicMemory = path.join(__dirname, 'episodic-memory.js');


// --- orphan reaping ------------------------------------------------------------------------
// The summariser's SDK call is bounded by a 120 s AbortController, but aborting stops the PARENT
// iterating and does NOT terminate the claude.exe --fork-session child or the transient daemon
// supervising it. Workers can outlive the bound by hours and leave dozens of processes and
// gigabytes of memory behind. So: snapshot before, sweep after.
async function listClaudeProcs() {
  // A test seam, and the only way to exercise the reaper inside a hook run without touching the
  // machine's real processes: an absolute path to an ESM module exporting `listClaudeProcs`.
  const override = process.env.EPISODIC_MEMORY_PROC_LISTER;
  if (override) {
    try {
      const mod = await import(pathToFileURL(override).href);
      return typeof mod.listClaudeProcs === 'function' ? mod.listClaudeProcs() : null;
    } catch {
      return null;   // FAIL OPEN, same as below: a broken lister reaps nothing.
    }
  }
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

async function reapOrphans(baselinePids, logPath, formatLogLine) {
  // EVERY PATH LOGS, INCLUDING THE QUIET ONE. This function used to `return` silently on three
  // separate paths - enumeration failure, an empty victim list, and all-kills-failing - so
  // "ran and found nothing" was INDISTINGUISHABLE from "never ran". A reaper that speaks only
  // when it kills is unfalsifiable, so every path writes a log line.
  const note = (level, msg) => {
    try { fs.appendFileSync(logPath, formatLogLine(level, `orphan-reaper: ${msg}`), 'utf-8'); } catch {}
  };

  const procs = await listClaudeProcs();
  if (!procs) {
    note('warn', 'could not enumerate processes - reaped NOTHING (failing open, by design)');
    return;
  }

  // A live `learn` run lists its own subprocesses in `.learn.pids`. They are young and match the
  // reaper signatures, so the baseline cannot protect them - only the run's registry can. Read
  // at reap time, not at baseline time: a run that started during this sync is exactly the case
  // this guard exists for.
  let protectedPids = new Set();
  try {
    protectedPids = readLearnPids(getIndexDir());
  } catch {
    // No index dir yet, or an unreadable file: protect nothing rather than skip the sweep.
  }

  const victims = selectOrphans(procs, baselinePids, protectedPids);
  if (!victims.length) {
    note('info',
      `ran, ${procs.length} claude process(es) seen, ${baselinePids.size} in baseline, ` +
      `${protectedPids.size} protected by learn, 0 to reap`);
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
    `ran, ${victims.length} orphan(s) selected (${protectedPids.size} protected by learn), ` +
    `${killed.length} killed${killed.length ? ' [' + killed.join(', ') + ']' : ''}` +
    (failed.length ? `, ${failed.length} FAILED [${failed.join(', ')}]` : ''));
}

async function main() {
  const { getSyncErrorsLogPath, formatLogLine } = await import('../dist/logging.js');
  const logPath = getSyncErrorsLogPath();

  // The ollama backend loads a model on the shared GPU, so the sync waits while another agent
  // holds the GPU (see src/gpu-reservation.ts). A failure here skips the sync and is logged by
  // the catch at the bottom of the file.
  const { summarizerBackend } = await import('../dist/ollama-backend.js');
  if (summarizerBackend() === 'ollama') {
    const { gpuReservationBlock } = await import('../dist/gpu-reservation.js');
    const reserved = gpuReservationBlock();
    if (reserved) {
      fs.appendFileSync(logPath, formatLogLine('info', `SessionStart sync skipped: ${reserved}`), 'utf-8');
      process.exit(0);
    }
  }

  // Repair node_modules BEFORE syncing. This hook never passes through the MCP wrapper, so a tree
  // missing better-sqlite3's compiled binding failed every background sync with nothing to fix it.
  try {
    const action = ensureDeps(path.join(__dirname, '..'));
    if (action !== 'none') {
      fs.appendFileSync(logPath, formatLogLine('info', `SessionStart deps repaired: ${action}`), 'utf-8');
    }
  } catch (err) {
    fs.appendFileSync(logPath, formatLogLine('error', `SessionStart deps repair failed: ${err.message}`), 'utf-8');
  }

  // Baseline BEFORE launch - the rule that makes reaping safe. Anything already running is
  // never ours, however much it looks like plumbing.
  const baselineProcs = await listClaudeProcs();
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
    if (canReap) {
      reapOrphans(baselinePids, logPath, formatLogLine)
        .catch(() => {})
        .finally(() => reportExit(code));
      return;
    }
    reportExit(code);
  });

  function reportExit(code) {
    if (code !== 0) {
      const detail = [stderr.trim(), stdout.trim()].filter(Boolean).join(' | ');
      fs.appendFileSync(
        logPath,
        formatLogLine('error', `SessionStart sync hook failed (exit ${code}): ${detail || 'no output'}`),
        'utf-8'
      );
    }
    process.exit(0);
  }

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
