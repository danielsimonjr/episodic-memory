#!/usr/bin/env node
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { runChild } from './forward-child.js';
import { realpathSync } from 'fs';
import { createInterface } from 'readline';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(realpathSync(__filename));

/** Run one index-cli command, and wait for the child. */
function runIndexCli(command, args) {
  return runChild(join(__dirname, '../dist/index-cli.js'), [command, ...args]);
}

function askConfirmation(question) {
  return new Promise((resolve) => {
    const rl = createInterface({
      input: process.stdin,
      output: process.stdout
    });

    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.toLowerCase() === 'yes');
    });
  });
}

function showHelp() {
  console.log(`index-conversations - Index and manage conversation archives

USAGE:
  index-conversations [COMMAND] [OPTIONS]

COMMANDS:
  (default)      Index all conversations
  --cleanup      Process only unindexed conversations (fast, cheap)
  --session ID   Index specific session (used by hook)
  --verify       Check index health
  --repair       Fix detected issues
  --rebuild      Delete DB and re-index everything (requires confirmation)
  prune          Remove the rows of projects: --excluded, or --project NAME; add --dry-run to count only
  vacuum         Return the free pages of the index database to disk

  The index-cli names also work: index-all, index-session ID, index-cleanup, verify, repair,
  rebuild (requires confirmation). For an unknown command or option, or an option of
  another command, the command writes one error line, exits 2 and does no work.
  While a sync or another index command runs, the command writes one error line, exits 75
  and does no work. Run the command again when the other run ends.

OPTIONS:
  --concurrency N    Parallel summarization (1-16, default: 1)
  -c N               Short form of --concurrency
  --no-summaries     Skip AI summary generation (free, but no summaries in results)
  --yes              With --rebuild or rebuild: skip the confirmation
  --help, -h         Show this help

EXAMPLES:
  # Index all unprocessed (recommended for backfill)
  index-conversations --cleanup

  # Index with 8 parallel summarizations (8x faster)
  index-conversations --cleanup --concurrency 8

  # Index without AI summaries (free, fast)
  index-conversations --cleanup --no-summaries

  # Check index health
  index-conversations --verify

  # Fix any issues found
  index-conversations --repair

  # Nuclear option (deletes everything, re-indexes)
  index-conversations --rebuild

WORKFLOW:
  1. Initial setup: index-conversations --cleanup
  2. Ongoing: Auto-indexed by sessionEnd hook
  3. Health check: index-conversations --verify (weekly)
  4. Recovery: index-conversations --repair (if issues found)

SEE ALSO:
  INDEXING.md - Setup and maintenance guide
  DEPLOYMENT.md - Production runbook`);
}

async function main() {
  const command = process.argv[2];
  const args = process.argv.slice(3);

  try {
    switch (command) {
      case '--help':
      case '-h':
        showHelp();
        process.exit(0);
        break;

      case undefined:
        await runIndexCli('index-all', args);
        break;

      case '--session':
        await runIndexCli('index-session', args);
        break;

      case '--cleanup':
        await runIndexCli('index-cleanup', args);
        break;

      case '--verify':
        await runIndexCli('verify', args);
        break;

      case '--repair':
        await runIndexCli('repair', args);
        break;

      case '--rebuild':
      case 'rebuild':
        console.log('⚠️  This will DELETE the entire database and re-index everything.');
        // --yes skips the question for a caller with no terminal. index-cli refuses rebuild without
        // --yes, so only the answer yes or an explicit --yes can start the delete.
        const confirmed = args.includes('--yes') || await askConfirmation('Are you sure? [yes/NO]: ');
        if (confirmed) {
          await runIndexCli('rebuild', args.includes('--yes') ? args : ['--yes', ...args]);
        } else {
          console.log('Cancelled');
        }
        break;

      // Every other argument goes to index-cli unchanged. index-cli runs its own commands (prune, vacuum and
      // the rest), runs index-all when there is no command, and refuses an unknown argument.
      default:
        await runIndexCli(command, args);
        break;
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
