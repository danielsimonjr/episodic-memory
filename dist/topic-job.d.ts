import type Database from 'better-sqlite3';
/** Options for runTopics. The fields let tests replace the model call and the clock. */
export interface TopicOptions {
    /** Model call. Defaults to the digest model call of the configured backend; tests pass a fake. */
    model?: (prompt: string) => Promise<string>;
    /** The time for the quiet check, and for `since` on the first run. Defaults to the current time. */
    now?: Date;
}
/** The counts that runTopics returns. */
export interface TopicResult {
    /** Sessions whose edit was installed. */
    installed: number;
    /** Sessions whose answer added nothing. The job records them as done. */
    empty: number;
    /** Sessions that the job recorded as rejected in this run. */
    rejected: number;
    /** Sessions left out because they are quiet, trivial, or no exchange fits the prompt budget. */
    skipped: number;
    /** Edits that the `updated_at` check refused. The next run retries them. */
    stale: number;
    /** Failed model calls and edit faults. The next run retries them until the limit of failed calls. */
    failed: number;
    /** The reason of the deferral that stopped the run (`src/deferral.ts` lists the causes). */
    deferred?: string;
}
/**
 * Run the topic job. It organizes the exchanges of finished sessions into the topic documents of their project.
 *
 * The function returns at once, and writes nothing, when EPISODIC_MEMORY_TOPICS is not `1`, or when the summarizer
 * guard is set. It stores `since` on the first run, before the GPU check. It stops early when another agent holds
 * the shared GPU, or at another deferral (`src/deferral.ts` lists the causes). It reports the reason in `deferred`.
 *
 * @param db the open index database
 * @param opts replaces the model call or the clock
 */
export declare function runTopics(db: Database.Database, opts?: TopicOptions): Promise<TopicResult>;
