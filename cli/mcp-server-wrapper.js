#!/usr/bin/env node
/**
 * Cross-platform wrapper script for MCP server that ensures dependencies are installed
 * This runs before the MCP server starts and works on Windows, macOS, and Linux
 */

import { spawn } from 'child_process';
import { existsSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { ensureDeps } from './ensure-deps.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Determine plugin root directory
const PLUGIN_ROOT = process.env.CLAUDE_PLUGIN_ROOT || join(__dirname, '..');

async function main() {
  try {
    // Install missing dependencies and build a missing native binding. Directory existence, and
    // even better-sqlite3's JS, are not enough - see NATIVE_ADDON in src/deps-health.ts.
    ensureDeps(PLUGIN_ROOT);

    // Start the MCP server
    const mcpServerPath = join(PLUGIN_ROOT, 'dist', 'mcp-server.js');

    if (!existsSync(mcpServerPath)) {
      console.error(`ERROR: MCP server not found at ${mcpServerPath}`);
      console.error('Please run: npm run build');
      process.exit(1);
    }

    // Use spawn with shell: false for better cross-platform compatibility
    const child = spawn(process.execPath, [mcpServerPath], {
      stdio: 'inherit',
      shell: false
    });

    // Forward signals to the child process
    process.on('SIGTERM', () => child.kill('SIGTERM'));
    process.on('SIGINT', () => child.kill('SIGINT'));
    process.on('SIGHUP', () => child.kill('SIGHUP'));

    // Detect parent process death via stdin close
    // When Claude exits (normally or abnormally), stdin will close
    process.stdin.on('end', () => {
      child.kill();
      process.exit(0);
    });

    // Backstop parent-liveness poll (F11). With `stdio: 'inherit'` the child owns
    // stdin, so the wrapper's stdin 'end' may never fire — and on Windows there's
    // no SIGHUP. Without this, an abnormal Claude exit can orphan the MCP server,
    // which keeps the SQLite DB (and its WAL) open → "database is locked" on the
    // next start. Poll the original parent PID and shut down if it disappears.
    const parentPid = process.ppid;
    const parentWatch = setInterval(() => {
      let alive = true;
      try {
        process.kill(parentPid, 0);
      } catch (err) {
        alive = err.code === 'EPERM'; // exists but not signalable → alive
      }
      if (!alive) {
        clearInterval(parentWatch);
        child.kill();
        process.exit(0);
      }
    }, 5000);
    if (typeof parentWatch.unref === 'function') parentWatch.unref();

    child.on('exit', (code, signal) => {
      clearInterval(parentWatch);
      if (signal) {
        process.kill(process.pid, signal);
      } else {
        process.exit(code || 0);
      }
    });

    child.on('error', (err) => {
      console.error(`ERROR: Failed to start MCP server: ${err.message}`);
      process.exit(1);
    });

  } catch (error) {
    console.error(`ERROR: ${error.message}`);
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(`Unexpected error: ${error.message}`);
  process.exit(1);
});
