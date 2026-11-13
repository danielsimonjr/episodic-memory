import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { mkdtempSync, existsSync, mkdirSync, writeFileSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { safeRmSync } from './test-utils.js';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const INDEX_CLI = join(REPO_ROOT, 'dist', 'index-cli.js');
const INDEX_WRAPPER = join(REPO_ROOT, 'cli', 'index-conversations.js');
const UMBRELLA = join(REPO_ROOT, 'cli', 'episodic-memory.js');

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'em-index-args-'));
});

afterEach(() => {
  safeRmSync(home);
});

/**
 * Run one entry point in an empty home. Every path variable points into the temporary folder, so a run of
 * the old code, which indexes on an unknown argument, can never read real transcripts or write the live index.
 */
function run(script: string, args: string[], input?: string) {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    EPISODIC_MEMORY_CONFIG_DIR: join(home, 'cfg'),
    CLAUDE_CONFIG_DIR: join(home, 'claude'),
    CODEX_HOME: join(home, 'codex'),
    XDG_CONFIG_HOME: join(home, 'xdg'),
  };
  for (const key of ['EPISODIC_MEMORY_SUMMARIZER_GUARD', 'EPISODIC_MEMORY_DB_PATH', 'PERSONAL_SUPERPOWERS_DIR',
    'TEST_DB_PATH', 'TEST_ARCHIVE_DIR', 'TEST_PROJECTS_DIR', 'CONVERSATION_SEARCH_EXCLUDE_PROJECTS']) {
    delete env[key];
  }
  return spawnSync(process.execPath, [script, ...args], { env, timeout: 30000, encoding: 'utf-8', input });
}

/** The index database of the temporary config folder. An index run creates the file; a refusal does not. */
const indexDb = () => join(home, 'cfg', 'conversation-index', 'db.sqlite');

/** Plant a marker index file and a summary file. rebuild deletes both; a refusal leaves both. */
function plantIndex(): { db: string; summary: string } {
  mkdirSync(join(home, 'cfg', 'conversation-index'), { recursive: true });
  mkdirSync(join(home, 'cfg', 'conversation-archive', 'proj'), { recursive: true });
  const db = indexDb();
  const summary = join(home, 'cfg', 'conversation-archive', 'proj', 'x-summary.txt');
  writeFileSync(db, 'marker');
  writeFileSync(summary, 'a summary');
  return { db, summary };
}

const untouched = (p: { db: string; summary: string }) =>
  readFileSync(p.db, 'utf-8') === 'marker' && existsSync(p.summary);

describe('index-cli arguments', () => {
  it('prints the usage for --help and indexes nothing', () => {
    const result = run(INDEX_CLI, ['--help']);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Usage: index-cli [command] [options]');
    expect(result.stdout).not.toMatch(/Initializing database|Scanning/);
    expect(existsSync(indexDb())).toBe(false);
  });

  it('refuses an unknown option with exit 2 and names it, before any index work', () => {
    const result = run(INDEX_CLI, ['--bogus']);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('episodic-memory index: unknown option --bogus');
    expect(result.stdout).not.toMatch(/Initializing database|Scanning/);
    expect(existsSync(indexDb())).toBe(false);
  });

  it('refuses an unknown command with exit 2', () => {
    const result = run(INDEX_CLI, ['bogus']);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('episodic-memory index: unknown command bogus');
    expect(existsSync(indexDb())).toBe(false);
  });

  it('refuses a second positional argument for a command that takes none', () => {
    const result = run(INDEX_CLI, ['verify', 'extra']);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('unknown argument extra');
  });

  it('refuses an option of another command: --dry-run without prune starts no real index', () => {
    const result = run(INDEX_CLI, ['--dry-run']);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('option --dry-run does not apply to index-all');
    expect(existsSync(indexDb())).toBe(false);
    expect(run(INDEX_CLI, ['verify', '--no-summaries']).status).toBe(2);
  });

  it('refuses a --concurrency value that is not an integer from 1 to 16, and a value option without a value', () => {
    const swallowed = run(INDEX_CLI, ['--concurrency', 'verify']);
    expect(swallowed.status).toBe(2);
    expect(swallowed.stderr).toContain('option --concurrency needs an integer from 1 to 16');
    expect(run(INDEX_CLI, ['-c', '17']).status).toBe(2);
    const missing = run(INDEX_CLI, ['index-cleanup', '--concurrency']);
    expect(missing.status).toBe(2);
    expect(missing.stderr).toContain('option --concurrency needs a value');
    expect(existsSync(indexDb())).toBe(false);
  });

  it('accepts a project key that starts with a dash, as on macOS and Linux', () => {
    const result = run(INDEX_CLI, ['prune', '--project', '-Users-name-repo', '--dry-run']);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Pruning 1 project(s): -Users-name-repo');
  });

  it('refuses rebuild without --yes and deletes nothing', () => {
    const planted = plantIndex();
    const result = run(INDEX_CLI, ['rebuild']);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('needs --yes');
    expect(untouched(planted)).toBe(true);
  });

  // The positive control of the refusal above: the same check can see a delete.
  it('rebuild --yes deletes the index and the summary files', () => {
    const planted = plantIndex();
    const result = run(INDEX_CLI, ['rebuild', '--yes', '--no-summaries']);
    expect(result.status).toBe(0);
    expect(existsSync(planted.summary)).toBe(false);
    expect(untouched(planted)).toBe(false);
  });

  it('still accepts the documented options: prune --project <name> --dry-run runs and deletes nothing', () => {
    const result = run(INDEX_CLI, ['prune', '--project', 'nothing-here', '--dry-run']);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Pruning 1 project(s): nothing-here');
    expect(result.stdout).toContain('Dry run');
  });

  it('still accepts --concurrency N and --no-summaries: index-session without an id stops at its own usage line', () => {
    const result = run(INDEX_CLI, ['index-session', '--concurrency', '2', '--no-summaries']);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Usage: index-cli index-session <session-id>');
    expect(result.stderr).not.toContain('unknown');
  });
});

describe('index-conversations wrapper', () => {
  it('passes the exit code 2 of an unknown option through', () => {
    const result = run(INDEX_WRAPPER, ['--bogus']);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('unknown option --bogus');
    expect(existsSync(indexDb())).toBe(false);
  });

  // Before the fix, the wrapper sent every unlisted first argument to index-all, so `index prune` ran a full index.
  it('routes prune to the prune command: without a target it stops at the prune usage line', () => {
    const result = run(INDEX_WRAPPER, ['prune']);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Usage: index-cli prune');
    expect(existsSync(indexDb())).toBe(false);
  });
});

describe('the rebuild confirmation', () => {
  // An option before the command hid rebuild from the prompt of the wrapper, and index-cli deleted the index.
  it('an option before rebuild cannot skip the prompt: the wrapper and the umbrella exit 2 and delete nothing', () => {
    const planted = plantIndex();
    const wrapper = run(INDEX_WRAPPER, ['--no-summaries', 'rebuild']);
    expect(wrapper.status).toBe(2);
    expect(wrapper.stderr).toContain('needs --yes');
    const umbrella = run(UMBRELLA, ['index', '--concurrency', '2', 'rebuild']);
    expect(umbrella.status).toBe(2);
    expect(untouched(planted)).toBe(true);
  });

  it('the answer no cancels rebuild and deletes nothing', () => {
    const planted = plantIndex();
    const result = run(INDEX_WRAPPER, ['rebuild'], 'no\n');
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Cancelled');
    expect(untouched(planted)).toBe(true);
  });

  it('rebuild --yes through the wrapper runs without the prompt, for a caller with no terminal', () => {
    const planted = plantIndex();
    const result = run(INDEX_WRAPPER, ['rebuild', '--yes', '--no-summaries']);
    expect(result.status).toBe(0);
    expect(result.stdout).not.toContain('Are you sure');
    expect(existsSync(planted.summary)).toBe(false);
  });

  it('the answer yes runs rebuild: the wrapper adds --yes', () => {
    const planted = plantIndex();
    const result = run(INDEX_WRAPPER, ['rebuild', '--no-summaries'], 'yes\n');
    expect(result.status).toBe(0);
    expect(existsSync(planted.summary)).toBe(false);
  });
});

describe('episodic-memory umbrella CLI', () => {
  it('passes the exit code 2 of index --bogus through', () => {
    const result = run(UMBRELLA, ['index', '--bogus']);
    expect(result.status).toBe(2);
    expect(existsSync(indexDb())).toBe(false);
  });

  it('passes the exit code 2 of sync --bogus through', () => {
    const result = run(UMBRELLA, ['sync', '--bogus']);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('episodic-memory sync: unknown option --bogus');
  });

  it('prints the index help for index --help', () => {
    const result = run(UMBRELLA, ['index', '--help']);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('index-conversations - Index and manage conversation archives');
    expect(result.stdout).toContain('prune');
  });
});
