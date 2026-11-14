/**
 * The embedding model files: their pinned identity, their location, their check and their download.
 *
 * This module imports Node built-ins, `paths.ts` and `fs-retry.ts` only. The database module loads it
 * in every process, so it must stay free of native dependencies.
 */
import { createHash, randomBytes } from 'node:crypto';
import { closeSync, createWriteStream, existsSync, mkdirSync, openSync, readdirSync, readSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import { superpowersDirPath } from './paths.js';
import { renameWithRetry } from './fs-retry.js';

/** One file of a model: its path in the repository, its size in bytes and its sha256. */
export interface ModelFile {
  path: string;
  size: number;
  sha256: string;
}

/** A model: the repository, the revision and the files that the embedding code reads. */
export interface ModelSpec {
  repo: string;
  revision: string;
  files: ModelFile[];
}

/** The embedding model that the index is built with. `EMBEDDING_MODEL` is the one source of the model identity. */
export const EMBEDDING_MODEL: ModelSpec = {
  repo: 'Xenova/bge-small-en-v1.5',
  revision: 'ea104dacec62c0de699686887e3f920caeb4f3e3',
  files: [
    { path: 'tokenizer.json', size: 711396, sha256: 'd241a60d5e8f04cc1b2b3e9ef7a4921b27bf526d9f6050ab90f9267a1f9e5c66' },
    { path: 'tokenizer_config.json', size: 366, sha256: '9261e7d79b44c8195c1cada2b453e55b00aeb81e907a6664974b4d7776172ab3' },
    { path: 'onnx/model_quantized.onnx', size: 34014426, sha256: '6c9c6101a956d62dfb5e7190c538226c0c5bb9cb27b651234b6df063ee7dbfe4' },
  ],
};

/** The command that downloads the model when a file is missing. */
export const FETCH_COMMAND = 'episodic-memory model fetch';

/** The marker file that records a failed download in the model folder. */
export const FETCH_FAILED_MARKER = '.model-fetch-failed';

/** The wait before the sync retries a failed download. */
export const FETCH_RETRY_MS = 24 * 60 * 60 * 1000;

/** The age after which the fetch removes a temporary file of a killed process. */
const STALE_TEMP_MS = 60 * 60 * 1000;

/** The time limit of one file download. */
const FETCH_TIMEOUT_MS = 10 * 60 * 1000;

/** The default host of the model files. The HF_ENDPOINT variable overrides this host. */
const DEFAULT_ENDPOINT = 'https://huggingface.co';

/** Attempts for the rename of a downloaded file, because a virus scan can hold a new file. */
const RENAME_ATTEMPTS = 10;

/**
 * The embedding backend did not load, or the model files are not ready.
 *
 * A caller that can work without embeddings catches this error. The sync, for example, still copies
 * the transcripts and runs the summaries. `cause` holds the underlying error.
 */
export class EmbeddingsUnavailableError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'EmbeddingsUnavailableError';
  }
}

/** The result of `modelState`: `ready` when every file matches, else `missing` with the bad paths. */
export interface ModelStateResult {
  state: 'ready' | 'missing';
  bad: string[];
}

/** The function that renames a downloaded file into place. Tests replace this function. */
export type RenameFn = (from: string, to: string) => void;

/** The options of `ensureModel`. */
export interface EnsureModelOptions {
  download: boolean;
  spec?: ModelSpec;
  dir?: string;
  endpoint?: string;
  rename?: RenameFn;
}

/**
 * Return the folder that holds the model files.
 *
 * The folder is `EPISODIC_MEMORY_MODEL_DIR` when that variable is set. Otherwise the folder is
 * `<superpowers dir>/models/<repo>/<revision>`, which lives outside `node_modules`.
 */
export function modelDir(): string {
  const override = process.env.EPISODIC_MEMORY_MODEL_DIR;
  if (override) return override;
  return join(superpowersDirPath(), 'models', EMBEDDING_MODEL.repo, EMBEDDING_MODEL.revision);
}

/** The read size of the streamed hash. The hash never holds a whole model file in memory. */
const HASH_CHUNK_BYTES = 1024 * 1024;

/** The verified results of this process, keyed by path, size, mtime and pinned sha256. The cache hashes each file once. */
const verifiedCache = new Map<string, boolean>();

/** Return the sha256 of a file, as a hex string. The function reads the file in chunks of `HASH_CHUNK_BYTES`. */
function sha256Of(path: string): string {
  const hash = createHash('sha256');
  const buffer = Buffer.alloc(HASH_CHUNK_BYTES);
  const fd = openSync(path, 'r');
  try {
    for (;;) {
      const read = readSync(fd, buffer, 0, buffer.length, null);
      if (read === 0) break;
      hash.update(buffer.subarray(0, read));
    }
  } finally {
    closeSync(fd);
  }
  return hash.digest('hex');
}

/** True when the file exists with the pinned size and sha256. The hash runs once per path, size, mtime and sha256. */
function fileMatches(path: string, file: ModelFile): boolean {
  // Another process can remove, replace or lock the file between the stat and the read.
  // A file that cannot be read is a bad file, so the caller downloads the file again.
  try {
    if (!existsSync(path)) return false;
    const stat = statSync(path);
    if (!stat.isFile() || stat.size !== file.size) return false;
    const key = `${path}|${stat.size}|${stat.mtimeMs}|${file.sha256}`;
    const cached = verifiedCache.get(key);
    if (cached !== undefined) return cached;
    const matches = sha256Of(path) === file.sha256;
    verifiedCache.set(key, matches);
    return matches;
  } catch {
    return false;
  }
}

/**
 * Check every model file against its pinned size and sha256.
 *
 * @param options.spec the model. The default is `EMBEDDING_MODEL`.
 * @param options.dir the folder. The default is `modelDir()`.
 * @returns `ready` with no bad paths, or `missing` with the paths of the bad files in spec order.
 */
export function modelState(options: { spec?: ModelSpec; dir?: string } = {}): ModelStateResult {
  const spec = options.spec ?? EMBEDDING_MODEL;
  const dir = options.dir ?? modelDir();
  const bad = spec.files.filter(f => !fileMatches(join(dir, f.path), f)).map(f => f.path);
  return bad.length === 0 ? { state: 'ready', bad: [] } : { state: 'missing', bad };
}

/** Build the error for a model that is not ready. The message names each path, its hash and the fetch command. */
function notReadyError(spec: ModelSpec, dir: string, bad: string[]): EmbeddingsUnavailableError {
  const lines = bad.map(p => {
    const file = spec.files.find(f => f.path === p)!;
    return `  ${join(dir, p)} (expected sha256 ${file.sha256})`;
  });
  return new EmbeddingsUnavailableError(
    `The embedding model is not ready. Missing or changed file(s):\n${lines.join('\n')}\n` +
      `Run "${FETCH_COMMAND}" to download the model, or set EPISODIC_MEMORY_MODEL_DIR to a folder that holds the files.`
  );
}

/** Remove the temporary files that a killed process left more than one hour ago. */
function removeStaleTemp(dir: string): void {
  if (!existsSync(dir)) return;
  for (const name of readdirSync(dir, { recursive: true }).map(String)) {
    if (!name.includes('.tmp-')) continue;
    const full = join(dir, name);
    try {
      if (Date.now() - statSync(full).mtimeMs > STALE_TEMP_MS) rmSync(full, { force: true });
    } catch {
      // Another process removed or holds the file. The next run retries.
    }
  }
}

/**
 * Download one file to a unique temporary file, check its size and sha256, and rename it into place.
 *
 * @throws EmbeddingsUnavailableError when the request, the hash check or the rename fails
 */
async function fetchFile(spec: ModelSpec, file: ModelFile, dir: string, endpoint: string, rename: RenameFn): Promise<void> {
  const target = join(dir, file.path);
  const url = `${endpoint}/${spec.repo}/resolve/${spec.revision}/${file.path}`;
  mkdirSync(dirname(target), { recursive: true });
  // Each line goes to stderr. The MCP server reads stdout as JSON-RPC.
  console.error(`episodic-memory: downloading ${file.path} (${file.size} bytes) from ${url}`);

  const temp = `${target}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`;
  let response: Response;
  try {
    response = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  } catch (error) {
    throw new EmbeddingsUnavailableError(`Could not download ${file.path} from ${url}: ${(error as Error).message}`, { cause: error });
  }
  if (!response.ok || !response.body) {
    // Release the connection before the error. An unread body keeps the socket open.
    await response.body?.cancel().catch(() => {});
    throw new EmbeddingsUnavailableError(`Could not download ${file.path} from ${url}: HTTP ${response.status}`);
  }

  const hash = createHash('sha256');
  let size = 0;
  const body = Readable.fromWeb(response.body as unknown as WebReadableStream);
  try {
    // The hash runs on each chunk as the pipeline writes the chunk, so the code reads each byte once.
    await pipeline(
      body,
      async function* (source: AsyncIterable<Uint8Array>) {
        for await (const chunk of source) {
          hash.update(chunk);
          size += chunk.length;
          yield chunk;
        }
      },
      createWriteStream(temp)
    );
  } catch (error) {
    rmSync(temp, { force: true });
    throw new EmbeddingsUnavailableError(`Could not write ${file.path} from ${url}: ${(error as Error).message}`, { cause: error });
  }

  const digest = hash.digest('hex');
  if (size !== file.size || digest !== file.sha256) {
    rmSync(temp, { force: true });
    throw new EmbeddingsUnavailableError(
      `Downloaded ${file.path} has ${size} bytes and sha256 ${digest}. ` +
        `Expected ${file.size} bytes and sha256 ${file.sha256}. The file was not kept.`
    );
  }

  try {
    rename(temp, target);
  } catch (error) {
    // Another process can write the same correct file first. Accept that file.
    let accepted = false;
    try {
      accepted = fileMatches(target, file);
    } catch {
      accepted = false;
    }
    rmSync(temp, { force: true });
    if (accepted) return;
    throw new EmbeddingsUnavailableError(`Could not move ${file.path} into place at ${target}`, { cause: error });
  }
  console.error(`episodic-memory: ${file.path} ready (${size} bytes, sha256 verified)`);
}

/** The in-flight calls, keyed by folder. Overlapping calls for one folder share one promise. */
const inFlight = new Map<string, Promise<void>>();

/**
 * Make the model files ready in the folder.
 *
 * With `download: false`, the function only checks the files. A missing or changed file throws
 * `EmbeddingsUnavailableError`. With `download: true`, the function fetches each bad file. The
 * environment variable `EPISODIC_MEMORY_MODEL_OFFLINE=1` turns a download into a check.
 *
 * @throws EmbeddingsUnavailableError when a file is not ready, or a download fails
 */
export async function ensureModel(options: EnsureModelOptions): Promise<void> {
  const spec = options.spec ?? EMBEDDING_MODEL;
  const dir = options.dir ?? modelDir();
  const offline = process.env.EPISODIC_MEMORY_MODEL_OFFLINE === '1';
  const download = options.download && !offline;
  const endpoint = (options.endpoint ?? process.env.HF_ENDPOINT ?? DEFAULT_ENDPOINT).replace(/\/+$/, '');
  const rename: RenameFn = options.rename ?? ((from, to) => renameWithRetry(from, to, RENAME_ATTEMPTS));

  const key = dir;
  const running = inFlight.get(key);
  if (running) return running;

  const run = (async () => {
    const before = modelState({ spec, dir });
    if (before.state === 'ready') return;
    if (!download) throw notReadyError(spec, dir, before.bad);
    removeStaleTemp(dir);
    for (const file of spec.files) {
      if (before.bad.includes(file.path)) await fetchFile(spec, file, dir, endpoint, rename);
    }
    const after = modelState({ spec, dir });
    if (after.state !== 'ready') throw notReadyError(spec, dir, after.bad);
  })();
  inFlight.set(key, run);
  try {
    await run;
  } finally {
    inFlight.delete(key);
  }
}

/**
 * Fetch the model during a sync, with the retry rule of the sync.
 *
 * The function does nothing when the files are ready. The function also does nothing when a failed download
 * left its marker less than `FETCH_RETRY_MS` ago. A failed download writes one stderr line and the
 * marker, and the sync continues without embeddings. The function catches only
 * `EmbeddingsUnavailableError`. Any other error is a defect, and the function rethrows the error.
 *
 * @throws Error when the error is not an EmbeddingsUnavailableError
 */
export async function fetchModelForSync(): Promise<void> {
  const dir = modelDir();
  if (modelState({ dir }).state === 'ready') return;
  // An offline sync is not a failed fetch. A marker would delay the first fetch after the
  // variable is cleared by 24 hours.
  if (process.env.EPISODIC_MEMORY_MODEL_OFFLINE === '1') return;
  const marker = join(dir, FETCH_FAILED_MARKER);
  if (existsSync(marker) && Date.now() - statSync(marker).mtimeMs < FETCH_RETRY_MS) return;
  try {
    await ensureModel({ download: true, dir });
    rmSync(marker, { force: true });
  } catch (error) {
    if (!(error instanceof EmbeddingsUnavailableError)) throw error;
    try {
      mkdirSync(dir, { recursive: true });
      writeFileSync(marker, String(error));
    } catch {
      // The marker is a retry hint. Without the marker, the next sync tries again.
    }
    console.error(`episodic-memory: embedding model not fetched; the sync continues without embeddings. ${(error as Error).message}`);
  }
}
