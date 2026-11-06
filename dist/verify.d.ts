/**
 * The problems that `verifyIndex` found, grouped by kind.
 *
 * - `missing`: an archived conversation has no summary file.
 * - `orphaned`: an indexed exchange names an archive file that `verifyIndex` did not find.
 * - `outdated`: an archived conversation is newer than its last indexing.
 * - `corrupted`: an archived conversation does not parse.
 *
 * `repairIndex` reads these lists.
 */
export interface VerificationResult {
    missing: Array<{
        path: string;
        reason: string;
    }>;
    orphaned: Array<{
        uuid: string;
        path: string;
    }>;
    outdated: Array<{
        path: string;
        fileTime: number;
        dbTime: number;
    }>;
    corrupted: Array<{
        path: string;
        error: string;
    }>;
}
/**
 * Compare the conversation archive with the index and list the differences.
 *
 * The function checks each archived conversation in a project that is not excluded. The function then checks each indexed exchange for an archive file. The function opens the index with `initDatabase`, which runs its migrations, and prints progress lines to standard output.
 *
 * The function returns an empty result when the archive folder does not exist. The function repairs nothing.
 */
export declare function verifyIndex(): Promise<VerificationResult>;
/**
 * Repair the problems that `verifyIndex` found.
 *
 * The function deletes the index rows of orphaned exchanges. For each missing or outdated conversation, the function parses the conversation again. The function then writes the summary file when the summary succeeds, and indexes the exchanges with new embeddings. A conversation that fails is logged and skipped, and the other conversations still run.
 *
 * The function does not repair corrupted conversations. The function prints them for manual review.
 *
 * The function throws when the index database or the embedding model cannot start.
 */
export declare function repairIndex(issues: VerificationResult): Promise<void>;
