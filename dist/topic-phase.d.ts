import type { Database } from './sqlite.js';
import type { TopicOptions, TopicResult } from './topic-job.js';
/**
 * The topic step of a sync run.
 *
 * Never throws, so a failure cannot stop the sync. With the flag off, or under the summarizer guard, the step
 * returns null and opens no database. The job and the database modules load only after those checks.
 *
 * @param opts the job options, and an open database. Without a database, the step opens and closes its own.
 */
export declare function runTopicPhase(opts?: TopicOptions & {
    db?: Database;
}): Promise<TopicResult | null>;
