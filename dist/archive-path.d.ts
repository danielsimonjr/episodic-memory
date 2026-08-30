/**
 * Archive path confinement for the MCP `read` tool.
 *
 * Closes symlink / non-realpath escapes past a naive path.resolve + prefix check,
 * and provides streaming line-range reads so large JSONL files never need to land
 * fully in memory.
 */
/** Default cap for a full (no line-range) MCP read. Override via env. */
export declare const DEFAULT_MAX_READ_BYTES: number;
export declare function maxReadBytes(): number;
/**
 * Resolve a candidate path to a real path that is guaranteed to lie inside
 * the conversation archive and end in `.jsonl`. Rejects path traversal,
 * symlink escapes, non-jsonl files, and missing targets.
 */
export declare function resolveArchiveJsonlPath(candidatePath: string): string;
/**
 * Resolve a summary sidecar path only when the candidate JSONL path is
 * lexically inside the archive and the summary file exists without symlink escape.
 * Returns null when the path is outside the archive or the summary is missing.
 */
export declare function safeArchiveSummaryPath(candidateJsonlPath: string): string | null;
/**
 * Stream a JSONL file, optionally restricted to a 1-indexed inclusive line range.
 * Enforces a byte-size cap when reading without an end bound on huge files.
 */
export declare function readJsonlLines(filePath: string, startLine?: number, endLine?: number): Promise<string>;
