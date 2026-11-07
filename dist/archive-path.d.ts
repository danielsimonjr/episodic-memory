/**
 * Archive path confinement for the MCP `read` tool.
 *
 * Closes symlink / non-realpath escapes past a naive path.resolve + prefix check,
 * and provides streaming line-range reads so large JSONL files never need to land
 * fully in memory.
 */
/** Default cap for a full (no line-range) MCP read. Override via env. */
export declare const DEFAULT_MAX_READ_BYTES: number;
/**
 * Return the size limit, in bytes, for a full read without a line range.
 *
 * The function reads `EPISODIC_MEMORY_MAX_READ_BYTES` on each call. The default limit is 32 MiB. A value that `parseInt` does not read as a positive number gives the default.
 */
export declare function maxReadBytes(): number;
/**
 * Resolve a candidate path to a real path that is guaranteed to lie inside the conversation archive.
 *
 * The returned path also ends in `.jsonl`. The function rejects path traversal, symlink escapes,
 * non-jsonl files, and missing targets.
 */
export declare function resolveArchiveJsonlPath(candidatePath: string): string;
/**
 * Resolve a summary sidecar path only when the candidate JSONL path is lexically inside the archive.
 *
 * The summary file must exist and must not escape the archive through a symlink.
 * Returns null when the path is outside the archive or the summary is missing.
 */
export declare function safeArchiveSummaryPath(candidateJsonlPath: string): string | null;
/**
 * Stream a JSONL file, optionally restricted to a 1-indexed inclusive line range.
 * Enforces a byte-size cap when reading without an end bound on huge files.
 */
export declare function readJsonlLines(filePath: string, startLine?: number, endLine?: number): Promise<string>;
