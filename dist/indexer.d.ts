/**
 * Index the conversations in every source folder.
 *
 * The function opens the index and loads the embedding model before it scans. Each file is copied to the archive when no copy exists, and then parsed. Files without exchanges are skipped. Unless `noSummaries` is set, the function writes a summary for each conversation that has none.
 *
 * `limitToProject` restricts the run to one project. `maxConversations` stops the run after a project when the processed count reaches that number. `concurrency` sets how many summaries run at once.
 */
export declare function indexConversations(limitToProject?: string, maxConversations?: number, concurrency?: number, noSummaries?: boolean): Promise<void>;
/**
 * Archive and index the first conversation file whose path contains the session id.
 *
 * The function searches every source folder. The function writes a summary for the file when the file has exchanges, has no summary, and `noSummaries` is not set. When no file matches, the function logs a message and returns without an error.
 *
 * @param sessionId Text that the file path must contain.
 * @param concurrency Has no effect. The function handles one file.
 * @param noSummaries Set to skip summary generation.
 */
export declare function indexSession(sessionId: string, concurrency?: number, noSummaries?: boolean): Promise<void>;
/**
 * Index the new exchanges of every conversation.
 *
 * The transcripts are append-only. For each file, the function reads the last line that the index holds. The function then indexes only the exchanges that start after that line. The function refreshes the archive copy of each file that has indexed lines.
 *
 * Unless `noSummaries` is set, the function writes missing summaries and runs `concurrency` of them at a time. When no file has new exchanges, the function prints a message and returns.
 */
export declare function indexUnprocessed(concurrency?: number, noSummaries?: boolean): Promise<void>;
