import { readFileSync } from 'fs';
import { formatConversationAsMarkdown, formatConversationAsHTML } from './show.js';
import { refuseUsage } from './cli-usage.js';

const args = process.argv.slice(2);

// Parse arguments
let format: 'markdown' | 'html' = 'markdown';
let filePath: string | null = null;

for (let i = 0; i < args.length; i++) {
  const arg = args[i];

  if (arg === '--format' || arg === '-f') {
    const value = args[++i];
    if (value !== 'markdown' && value !== 'html') refuseUsage('show', `option ${arg} needs markdown or html`);
    format = value;
  } else if (arg === '--help' || arg === '-h') {
    console.log(`
Usage: episodic-memory show [OPTIONS] <file>

Display a conversation from a JSONL file in a human-readable format.

OPTIONS:
  --format, -f FORMAT    Output format: markdown or html (default: markdown)
  --help, -h             Show this help

EXAMPLES:
  # Show conversation as markdown
  episodic-memory show conversation.jsonl

  # Generate HTML for browser viewing
  episodic-memory show --format html conversation.jsonl > output.html

  # View with pipe
  episodic-memory show conversation.jsonl | less
`);
    process.exit(0);
  } else if (arg.startsWith('-')) {
    // A flag that show does not know was read as the file name, and the command failed with ENOENT.
    refuseUsage('show', `unknown option ${arg}`);
  } else if (!filePath) {
    filePath = arg;
  } else {
    refuseUsage('show', `unknown argument ${arg}`);
  }
}

if (!filePath) {
  console.error('Error: No file specified');
  console.error('Usage: episodic-memory show [OPTIONS] <file>');
  console.error('Try: episodic-memory show --help');
  process.exit(1);
}

try {
  const jsonl = readFileSync(filePath, 'utf-8');

  if (format === 'html') {
    console.log(formatConversationAsHTML(jsonl));
  } else {
    console.log(formatConversationAsMarkdown(jsonl));
  }
} catch (error) {
  console.error(`Error reading file: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
