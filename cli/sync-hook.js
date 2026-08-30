#!/usr/bin/env node
/**
 * SessionStart hook entry point. Runs sync --background and logs failures to
 * sync-errors.log so hook stderr is not silently lost. Always exits 0 so hooks
 * stay non-blocking (upstream #94).
 */
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const episodicMemory = path.join(__dirname, 'episodic-memory.js');

async function main() {
  const { getSyncErrorsLogPath, formatLogLine } = await import('../dist/logging.js');
  const logPath = getSyncErrorsLogPath();

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
