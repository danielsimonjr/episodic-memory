import os from 'os';
import path from 'path';
import fs from 'fs';

/**
 * Ensure a directory exists, creating it if necessary.
 * New directories are mode 0o700 so conversation archives/indexes are not
 * world-readable on multi-user Unix hosts (umask alone is not enough).
 * Existing dirs are left alone (chmod can fail on some platforms / ACLs).
 */
function ensureDir(dir: string): string {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  return dir;
}

/** Best-effort chmod; no-op on platforms / FS that reject it. */
export function tryChmod(targetPath: string, mode: number): void {
  try {
    fs.chmodSync(targetPath, mode);
  } catch {
    // Windows / exotic FS: ignore
  }
}

/**
 * Get the Claude Code configuration directory.
 * Supports CLAUDE_CONFIG_DIR for multiple profiles.
 * Falls back to ~/.claude when not set.
 */
export function getClaudeDir(): string {
  return process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
}

/**
 * Get the Codex configuration directory.
 * Supports CODEX_HOME for alternate profiles.
 * Falls back to ~/.codex when not set.
 */
export function getCodexDir(): string {
  return process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
}

/**
 * Get all directories where supported harnesses store conversation files.
 * Checks Claude Code legacy (projects/) and current (transcripts/) locations,
 * plus Codex sessions.
 * Returns only directories that exist.
 */
export function getConversationSourceDirs(): string[] {
  const testDir = process.env.TEST_PROJECTS_DIR;
  if (testDir) return [testDir];

  const claudeDir = getClaudeDir();
  const codexDir = getCodexDir();
  return [
    path.join(claudeDir, 'projects'),
    path.join(claudeDir, 'transcripts'),
    path.join(codexDir, 'sessions'),
  ].filter(d => fs.existsSync(d));
}

/**
 * Recursively find all .jsonl files under a directory.
 * Returns paths relative to the given directory.
 *
 * `excludedDirNames` skips any subdirectory whose name matches an entry in
 * the set, at any depth. The indexer passes the excluded project names.
 * A listed name such as `subagents` also skips the `subagents/` directories inside session UUIDs (#80).
 */
export function findJsonlFiles(dir: string, excludedDirNames?: ReadonlySet<string>): string[] {
  const results: string[] = [];
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isFile() && entry.name.endsWith('.jsonl')) {
        results.push(entry.name);
      } else if (entry.isDirectory()) {
        if (excludedDirNames?.has(entry.name)) continue;
        const subDir = path.join(dir, entry.name);
        for (const f of findJsonlFiles(subDir, excludedDirNames)) {
          results.push(path.join(entry.name, f));
        }
      }
    }
  } catch {
    // Directory might not be readable
  }
  return results;
}

/**
 * Return the stats of a path, or `null` when the function cannot read the path.
 *
 * The function follows a link, as `fs.statSync` does. A link whose target is gone gives `null`, not an error.
 * A storage migration can leave a link of this type in a projects folder. If an entry disappears after the listing, the function also gives `null`.
 * A caller skips an entry with `null` stats. As a result, one bad entry does not stop the walk of a folder.
 */
export function statIfExists(target: string): fs.Stats | null {
  try {
    return fs.statSync(target);
  } catch {
    return null;
  }
}

/**
 * Get the personal superpowers directory.
 *
 * Precedence:
 * 1. EPISODIC_MEMORY_CONFIG_DIR env var (if set, for testing)
 * 2. PERSONAL_SUPERPOWERS_DIR env var (if set)
 * 3. XDG_CONFIG_HOME/superpowers (if XDG_CONFIG_HOME is set)
 * 4. ~/.config/superpowers (default)
 */
export function getSuperpowersDir(): string {
  return ensureDir(superpowersDirPath());
}

/**
 * Returns the path that `getSuperpowersDir` uses, and creates nothing.
 *
 * A caller that only reads (doctor, the hooks, the read-only MCP tools) uses the `...Path` functions.
 * A read must leave a fresh config folder unchanged.
 */
export function superpowersDirPath(): string {
  let dir: string;

  if (process.env.EPISODIC_MEMORY_CONFIG_DIR) {
    dir = process.env.EPISODIC_MEMORY_CONFIG_DIR;
  } else if (process.env.PERSONAL_SUPERPOWERS_DIR) {
    dir = process.env.PERSONAL_SUPERPOWERS_DIR;
  } else {
    const xdgConfigHome = process.env.XDG_CONFIG_HOME;
    if (xdgConfigHome) {
      dir = path.join(xdgConfigHome, 'superpowers');
    } else {
      dir = path.join(os.homedir(), '.config', 'superpowers');
    }
  }

  return dir;
}

/**
 * Get conversation archive directory. Creates the directory when it is missing.
 */
export function getArchiveDir(): string {
  return ensureDir(archiveDirPath());
}

/** Returns the path that `getArchiveDir` uses, and creates nothing. */
export function archiveDirPath(): string {
  // Allow test override
  if (process.env.TEST_ARCHIVE_DIR) return process.env.TEST_ARCHIVE_DIR;
  return path.join(superpowersDirPath(), 'conversation-archive');
}

/**
 * Get conversation index directory. Creates the directory when it is missing.
 */
export function getIndexDir(): string {
  return ensureDir(indexDirPath());
}

/** Returns the path that `getIndexDir` uses, and creates nothing. */
export function indexDirPath(): string {
  return path.join(superpowersDirPath(), 'conversation-index');
}

/**
 * Get database path. Creates nothing: `openDatabase` creates the folder of the file when it opens a writer.
 * A reader checks that the file exists first, so a read leaves a fresh config folder unchanged.
 */
export function getDbPath(): string {
  // Allow test override with direct DB path
  if (process.env.EPISODIC_MEMORY_DB_PATH || process.env.TEST_DB_PATH) {
    return process.env.EPISODIC_MEMORY_DB_PATH || process.env.TEST_DB_PATH!;
  }

  return path.join(indexDirPath(), 'db.sqlite');
}

/**
 * Get the learned-knowledge directory.
 *
 * The learned-knowledge directory is a sibling of `conversation-index/`, not a child.
 * So `index rebuild` and the `rm -rf conversation-index/` reset recipe cannot reach
 * learned knowledge or the learning trace.
 */
export function getLearnedDir(): string {
  return ensureDir(path.join(getSuperpowersDir(), 'learned'));
}

/** The knowledge store (a SQLite FILE path). */
export function getKnowledgeDbPath(): string {
  return path.join(getLearnedDir(), 'knowledge.db');
}

/** The learning trace (runs, tasks, attempts, snapshots, rendered block). */
export function getLearningDbPath(): string {
  return path.join(getLearnedDir(), 'learning.sqlite');
}

/**
 * Get exclude config path.
 */
export function getExcludeConfigPath(): string {
  return path.join(getIndexDir(), 'exclude.txt');
}

/**
 * Get list of projects to exclude from indexing.
 * Configurable via env var or config file.
 */
export function getExcludedProjects(): string[] {
  // Check env variable first
  if (process.env.CONVERSATION_SEARCH_EXCLUDE_PROJECTS) {
    return process.env.CONVERSATION_SEARCH_EXCLUDE_PROJECTS.split(',').map(p => p.trim());
  }

  // Check for config file
  const configPath = getExcludeConfigPath();
  if (fs.existsSync(configPath)) {
    const content = fs.readFileSync(configPath, 'utf-8');
    return content.split('\n').map(line => line.trim()).filter(line => line && !line.startsWith('#'));
  }

  // Default: no exclusions
  return [];
}
