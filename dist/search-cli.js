import { searchConversations, formatResults, searchMultipleConcepts, formatMultiConceptResults } from './search.js';
import { positiveIntegerOption, refuseUsage } from './cli-usage.js';
const args = process.argv.slice(2);
// Parse arguments
let mode = 'both';
let after;
let before;
let project;
let sessionId;
let gitBranch;
let limit = 10;
const queries = [];
/** The value of a value option, or a usage error when the option is the last argument. */
function optionValue(option, value) {
    if (value === undefined)
        refuseUsage('search', `option ${option} needs a value`);
    return value;
}
for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--help' || arg === '-h') {
        console.log(`
Usage: episodic-memory search [OPTIONS] <query>

Search indexed conversations using semantic similarity or exact text matching.

MODES:
  (default)      Combined vector + text search (also --both)
  --vector       Vector similarity only (semantic)
  --text         Text matching only: each word must appear (for git SHAs, error codes)

OPTIONS:
  --after DATE          Only conversations after YYYY-MM-DD
  --before DATE         Only conversations before YYYY-MM-DD
  --project NAME        Filter by project name (exact match)
  --session-id ID       Filter by session ID (exact match)
  --git-branch BRANCH   Filter by git branch name (exact match)
  --limit N             Max results (default: 10)
  --help, -h            Show this help
  --                    End of options: every later argument is a query

EXAMPLES:
  # Semantic search
  episodic-memory search "React Router authentication errors"

  # Find exact string
  episodic-memory search --text "a1b2c3d4e5f6"

  # Time filtering
  episodic-memory search --after 2025-09-01 "refactoring"

  # Filter to one project
  episodic-memory search --project my-app "auth flow"

  # Filter to one git branch
  episodic-memory search --git-branch feature/login "validation"

  # Combine modes
  episodic-memory search --both "React Router data loading"

  # Multi-concept search (AND - all concepts must match)
  episodic-memory search "React Router" "authentication" "JWT"
`);
        process.exit(0);
    }
    else if (arg === '--') {
        queries.push(...args.slice(i + 1));
        break;
    }
    else if (arg === '--both') {
        mode = 'both';
    }
    else if (arg === '--vector') {
        mode = 'vector';
    }
    else if (arg === '--text') {
        mode = 'text';
    }
    else if (arg === '--after') {
        after = optionValue(arg, args[++i]);
    }
    else if (arg === '--before') {
        before = optionValue(arg, args[++i]);
    }
    else if (arg === '--project') {
        project = optionValue(arg, args[++i]);
    }
    else if (arg === '--session-id') {
        sessionId = optionValue(arg, args[++i]);
    }
    else if (arg === '--git-branch') {
        gitBranch = optionValue(arg, args[++i]);
    }
    else if (arg === '--limit') {
        limit = positiveIntegerOption('search', arg, args[++i]);
    }
    else if (arg.startsWith('-')) {
        // A misspelled flag would otherwise become a query term and change the search silently.
        refuseUsage('search', `unknown option ${arg}`);
    }
    else {
        queries.push(arg);
    }
}
if (queries.length === 0) {
    console.error('Usage: episodic-memory search [OPTIONS] <query> [query2] [query3]...');
    console.error('Try: episodic-memory search --help');
    process.exit(1);
}
// Multi-concept search if multiple queries provided
if (queries.length > 1) {
    const options = { limit, after, before, project, session_id: sessionId, git_branch: gitBranch };
    searchMultipleConcepts(queries, options)
        .then(async (results) => {
        console.log(await formatMultiConceptResults(results, queries));
    })
        .catch(error => {
        console.error('Error searching:', error);
        process.exit(1);
    });
}
else {
    // Single query - use regular search
    const options = {
        mode,
        limit,
        after,
        before,
        project,
        session_id: sessionId,
        git_branch: gitBranch,
    };
    searchConversations(queries[0], options)
        .then(async (results) => {
        console.log(await formatResults(results));
    })
        .catch(error => {
        console.error('Error searching:', error);
        process.exit(1);
    });
}
