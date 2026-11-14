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
/** The embedding model that the index is built with. This is the one source of the model identity. */
export declare const EMBEDDING_MODEL: ModelSpec;
/** The command that downloads the model when a file is missing. */
export declare const FETCH_COMMAND = "episodic-memory model fetch";
/** The marker file that records a failed download in the model folder. */
export declare const FETCH_FAILED_MARKER = ".model-fetch-failed";
/** The wait before the sync retries a failed download. */
export declare const FETCH_RETRY_MS: number;
/**
 * The embedding backend did not load, or the model files are not ready.
 *
 * A caller that can work without embeddings catches this error. The sync, for example, still copies
 * the transcripts and runs the summaries. `cause` holds the underlying error.
 */
export declare class EmbeddingsUnavailableError extends Error {
    constructor(message: string, options?: {
        cause?: unknown;
    });
}
/** The result of `modelState`: `ready` when every file matches, else `missing` with the bad paths. */
export interface ModelStateResult {
    state: 'ready' | 'missing';
    bad: string[];
}
/** The function that renames a downloaded file into place. Tests replace it. */
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
 * The folder is `EPISODIC_MEMORY_MODEL_DIR` when that variable is set. Otherwise it is
 * `<superpowers dir>/models/<repo>/<revision>`, which lives outside `node_modules`.
 */
export declare function modelDir(): string;
/**
 * Check every model file against its pinned size and sha256.
 *
 * @param options.spec the model. The default is `EMBEDDING_MODEL`.
 * @param options.dir the folder. The default is `modelDir()`.
 * @returns `ready` with no bad paths, or `missing` with the paths of the bad files in spec order.
 */
export declare function modelState(options?: {
    spec?: ModelSpec;
    dir?: string;
}): ModelStateResult;
/**
 * Make the model files ready in the folder.
 *
 * With `download: false`, the function only checks the files. A missing or changed file throws
 * `EmbeddingsUnavailableError`. With `download: true`, the function fetches each bad file. The
 * environment variable `EPISODIC_MEMORY_MODEL_OFFLINE=1` turns a download into a check.
 *
 * @throws EmbeddingsUnavailableError when a file is not ready, or a download fails
 */
export declare function ensureModel(options: EnsureModelOptions): Promise<void>;
/**
 * Fetch the model during a sync, with the retry rule of the sync.
 *
 * The function does nothing when the files are ready. It does nothing when a failed download
 * left its marker less than `FETCH_RETRY_MS` ago. A failed download writes one stderr line and the
 * marker, and the sync continues without embeddings. The function catches only
 * `EmbeddingsUnavailableError`. Any other error is a defect, and the function rethrows it.
 *
 * @throws Error when the error is not an EmbeddingsUnavailableError
 */
export declare function fetchModelForSync(): Promise<void>;
