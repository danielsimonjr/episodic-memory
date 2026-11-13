#!/usr/bin/env node
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { runChild } from './forward-child.js';
import { realpathSync } from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(realpathSync(__filename));

const command = process.argv[2];
const args = process.argv.slice(3);

/**
 * `learn` opens the knowledge store on better-sqlite3 13, which requires Node >= 22; `engines` only warns.
 * The function runs the check before the learn entry point is spawned.
 * A too-old Node then gets one readable line, not a failure deep inside a dependency.
 * The node-floor module is imported lazily, so every other command works on a tree whose dist/ is not built yet.
 * Only `learn` has a floor of its own. Returns true when the process should exit.
 */
async function blockedByNodeFloor() {
  if (command !== 'learn') return false;
  const { assertNodeFloor } = await import('../dist/node-floor.js');
  const floorError = assertNodeFloor();
  if (floorError === null) return false;
  console.error(floorError);
  return true;
}

function showHelp() {
  console.log(`episodic-memory - Manage and search Claude Code and Codex conversations

USAGE:
  episodic-memory <command> [options]

COMMANDS:
  sync        Sync conversations from Claude Code and Codex and index them
  backfill    Summarize archived conversations sync can no longer reach (see backfill --help)
  index       Index conversations for search
  search      Search indexed conversations
  show        Display a conversation in readable format
  stats       Show index statistics
  doctor      Diagnose Claude Code or Codex integration issues
  learn       Self-improving memory: tasks, solve, bootstrap, improve, status, report, approve, export, render (needs EPISODIC_MEMORY_LEARN=1)

Run 'episodic-memory <command> --help' for command-specific help.

EXAMPLES:
  # Index all conversations
  episodic-memory index --cleanup

  # Search for something
  episodic-memory search "React Router auth"

  # Display a conversation
  episodic-memory show path/to/conversation.jsonl

  # Generate HTML output
  episodic-memory show --format html conversation.jsonl > output.html`);
}

async function main() {
  try {
    if (await blockedByNodeFloor()) process.exit(1);

    const distDir = join(__dirname, '../dist');

    switch (command) {
      case 'index':
        await runChild(join(__dirname, 'index-conversations.js'), args);
        break;

      case 'search':
        await runChild(join(distDir, 'search-cli.js'), args);
        break;

      case 'show':
        await runChild(join(distDir, 'show-cli.js'), args);
        break;

      case 'stats':
        await runChild(join(distDir, 'stats-cli.js'), args);
        break;

      case 'doctor':
        await runChild(join(distDir, 'doctor-cli.js'), args);
        break;

      case 'sync':
        await runChild(join(distDir, 'sync-cli.js'), args);
        break;

      case 'backfill':
        await runChild(join(distDir, 'backfill-cli.js'), args);
        break;

      case 'learn':
        await runChild(join(distDir, 'learn-cli.js'), args);
        break;

      case '--help':
      case '-h':
      case undefined:
        showHelp();
        break;

      default:
        console.error(`Unknown command: ${command}`);
        console.error('Try: episodic-memory --help');
        process.exit(1);
    }
  } catch (error) {
    console.error(`Error: ${error.message}`);
    process.exit(error.exitCode ?? 1);
  }
}

main().catch((error) => {
  console.error(`Unexpected error: ${error.message}`);
  process.exit(1);
});
