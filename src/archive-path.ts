/**
 * Archive path confinement for the MCP `read` tool.
 *
 * Closes symlink / non-realpath escapes past a naive path.resolve + prefix check,
 * and provides streaming line-range reads so large JSONL files never need to land
 * fully in memory.
 */

import fs from 'fs';
import path from 'path';
import readline from 'readline';
import { getArchiveDir } from './paths.js';

/** Default cap for a full (no line-range) MCP read. Override via env. */
export const DEFAULT_MAX_READ_BYTES = 32 * 1024 * 1024;

export function maxReadBytes(): number {
  const raw = process.env.EPISODIC_MEMORY_MAX_READ_BYTES;
  if (raw === undefined) return DEFAULT_MAX_READ_BYTES;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_MAX_READ_BYTES;
}

function normalizeForCompare(p: string): string {
  const resolved = path.resolve(p);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

/**
 * Resolve a candidate path to a real path that is guaranteed to lie inside
 * the conversation archive and end in `.jsonl`. Rejects path traversal,
 * symlink escapes, non-jsonl files, and missing targets.
 */
export function resolveArchiveJsonlPath(candidatePath: string): string {
  if (!candidatePath || typeof candidatePath !== 'string') {
    throw new Error('Path is required');
  }

  const archiveRoot = getArchiveDir();
  let archiveReal: string;
  try {
    archiveReal = fs.realpathSync(archiveRoot);
  } catch {
    throw new Error(`Archive directory is not accessible: ${archiveRoot}`);
  }

  // Lexical resolve first so missing files still get a clear "outside archive"
  // error when the path clearly escapes, before we hit realpath ENOENT.
  const lexical = path.resolve(candidatePath);
  const archiveNorm = normalizeForCompare(archiveReal);
  const lexicalNorm = normalizeForCompare(lexical);
  const lexicalInside =
    lexicalNorm === archiveNorm ||
    lexicalNorm.startsWith(archiveNorm + path.sep);
  if (!lexicalInside) {
    throw new Error(`Path is outside the conversation archive: ${candidatePath}`);
  }

  if (!lexical.toLowerCase().endsWith('.jsonl')) {
    throw new Error(
      `Path must point to a .jsonl conversation file: ${candidatePath}`
    );
  }

  if (!fs.existsSync(lexical)) {
    throw new Error(`File not found: ${candidatePath}`);
  }

  // Refuse symlink leaves that escape the archive (realpath follows them).
  let realPath: string;
  try {
    realPath = fs.realpathSync(lexical);
  } catch (err) {
    throw new Error(
      `Unable to resolve path: ${candidatePath} (${err instanceof Error ? err.message : String(err)})`
    );
  }

  const realNorm = normalizeForCompare(realPath);
  const realInside =
    realNorm === archiveNorm || realNorm.startsWith(archiveNorm + path.sep);
  if (!realInside) {
    throw new Error(
      `Path resolves outside the conversation archive (symlink escape rejected): ${candidatePath}`
    );
  }

  if (!realPath.toLowerCase().endsWith('.jsonl')) {
    throw new Error(
      `Path must point to a .jsonl conversation file: ${candidatePath}`
    );
  }

  const stat = fs.lstatSync(lexical);
  if (!stat.isFile() && !stat.isSymbolicLink()) {
    throw new Error(`Path is not a file: ${candidatePath}`);
  }

  return realPath;
}

/**
 * Stream a JSONL file, optionally restricted to a 1-indexed inclusive line range.
 * Enforces a byte-size cap when reading without an end bound on huge files.
 */
export async function readJsonlLines(
  filePath: string,
  startLine?: number,
  endLine?: number
): Promise<string> {
  const stat = fs.statSync(filePath);
  const hasRange = startLine !== undefined || endLine !== undefined;
  const cap = maxReadBytes();

  if (!hasRange && stat.size > cap) {
    throw new Error(
      `File is ${stat.size} bytes, which exceeds the ${cap}-byte MCP read cap. ` +
        `Pass startLine/endLine to read a slice, or raise EPISODIC_MEMORY_MAX_READ_BYTES.`
    );
  }

  const from = startLine !== undefined ? Math.max(1, startLine) : 1;
  const to = endLine !== undefined ? endLine : Number.POSITIVE_INFINITY;
  if (to < from) {
    throw new Error(`endLine (${endLine}) must be >= startLine (${startLine ?? 1})`);
  }

  const stream = fs.createReadStream(filePath, { encoding: 'utf-8' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

  const selected: string[] = [];
  let lineNo = 0;
  let bytesAccumulated = 0;

  try {
    for await (const line of rl) {
      lineNo++;
      if (lineNo < from) continue;
      if (lineNo > to) break;

      // Cap even ranged reads so a huge endLine can't OOM the process.
      bytesAccumulated += Buffer.byteLength(line, 'utf-8') + 1;
      if (bytesAccumulated > cap) {
        throw new Error(
          `Selected line range exceeds the ${cap}-byte MCP read cap. ` +
            `Narrow startLine/endLine or raise EPISODIC_MEMORY_MAX_READ_BYTES.`
        );
      }
      selected.push(line);
    }
  } finally {
    rl.close();
    stream.destroy();
  }

  return selected.join('\n');
}
