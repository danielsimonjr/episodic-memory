import fs from 'fs';
/** Best-effort chmod; no-op on platforms / FS that reject it. */
export declare function tryChmod(targetPath: string, mode: number): void;
/**
 * Get the Claude Code configuration directory.
 * Supports CLAUDE_CONFIG_DIR for multiple profiles.
 * Falls back to ~/.claude when not set.
 */
export declare function getClaudeDir(): string;
/**
 * Get the Codex configuration directory.
 * Supports CODEX_HOME for alternate profiles.
 * Falls back to ~/.codex when not set.
 */
export declare function getCodexDir(): string;
/**
 * Get all directories where supported harnesses store conversation files.
 * Checks Claude Code legacy (projects/) and current (transcripts/) locations,
 * plus Codex sessions.
 * Returns only directories that exist.
 */
export declare function getConversationSourceDirs(): string[];
/**
 * Recursively find all .jsonl files under a directory.
 * Returns paths relative to the given directory.
 *
 * `excludedDirNames` skips any subdirectory whose name matches an entry in
 * the set, at any depth. The indexer passes the excluded project names.
 * A listed name such as `subagents` also skips the `subagents/` directories inside session UUIDs (#80).
 */
export declare function findJsonlFiles(dir: string, excludedDirNames?: ReadonlySet<string>): string[];
/**
 * Return the stats of a path, or `null` when the function cannot read the path.
 *
 * The function follows a link, as `fs.statSync` does. A link whose target is gone gives `null`, not an error.
 * A storage migration can leave a link of this type in a projects folder. If an entry disappears after the listing, the function also gives `null`.
 * A caller skips an entry with `null` stats. As a result, one bad entry does not stop the walk of a folder.
 */
export declare function statIfExists(target: string): fs.Stats | null;
/**
 * Get the personal superpowers directory.
 *
 * Precedence:
 * 1. EPISODIC_MEMORY_CONFIG_DIR env var (if set, for testing)
 * 2. PERSONAL_SUPERPOWERS_DIR env var (if set)
 * 3. XDG_CONFIG_HOME/superpowers (if XDG_CONFIG_HOME is set)
 * 4. ~/.config/superpowers (default)
 */
export declare function getSuperpowersDir(): string;
/**
 * Returns the path that `getSuperpowersDir` uses, and creates nothing.
 *
 * A caller that only reads (doctor, the hooks, the read-only MCP tools) uses the `...Path` functions.
 * A read must leave a fresh config folder unchanged.
 */
export declare function superpowersDirPath(): string;
/**
 * Get conversation archive directory. Creates the directory when it is missing.
 */
export declare function getArchiveDir(): string;
/** Returns the path that `getArchiveDir` uses, and creates nothing. */
export declare function archiveDirPath(): string;
/**
 * Get conversation index directory. Creates the directory when it is missing.
 */
export declare function getIndexDir(): string;
/** Returns the path that `getIndexDir` uses, and creates nothing. */
export declare function indexDirPath(): string;
/**
 * Get database path. Creates nothing: `openDatabase` creates the folder of the file when it opens a writer.
 * A reader checks that the file exists first, so a read leaves a fresh config folder unchanged.
 */
export declare function getDbPath(): string;
/**
 * Get the learned-knowledge directory.
 *
 * The learned-knowledge directory is a sibling of `conversation-index/`, not a child.
 * So `index rebuild` and the `rm -rf conversation-index/` reset recipe cannot reach
 * learned knowledge or the learning trace.
 */
export declare function getLearnedDir(): string;
/** The knowledge store (a SQLite FILE path). */
export declare function getKnowledgeDbPath(): string;
/** The learning trace (runs, tasks, attempts, snapshots, rendered block). */
export declare function getLearningDbPath(): string;
/**
 * Get exclude config path.
 */
export declare function getExcludeConfigPath(): string;
/**
 * Get list of projects to exclude from indexing.
 * Configurable via env var or config file.
 */
export declare function getExcludedProjects(): string[];
