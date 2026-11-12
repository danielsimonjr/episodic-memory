import type Database from 'better-sqlite3';
import type { ConversationExchange } from './types.js';
/** Options for runDigest. The fields let tests replace the model call and the clock. */
export interface DigestOptions {
    /** Model call. Defaults to the configured summarizer backend; tests pass a fake. */
    model?: (prompt: string) => Promise<string>;
    /** The time that the job uses for the recent-session check and for compression. Defaults to the current time. */
    now?: Date;
}
/** The counts that runDigest returns. */
export interface DigestResult {
    /** Session entries that the job inserted. */
    written: number;
    /** Sessions left out because their last exchange is recent, or because they hold one trivial exchange. */
    skipped: number;
    /** Failed summarizer calls, for sessions and for compression. */
    failed: number;
    /** Day and week entries created by compression. Undefined when the job stopped before compression. */
    compressed?: number;
    /** The reason that the job stopped, when another agent holds the shared GPU. The job counts this as a deferral, not a failure. */
    deferred?: string;
}
/** A session whose last exchange is newer than this is still running; summarize it next time. */
export declare const QUIET_MS: number;
/**
 * Return true when the digest feature is on.
 *
 * The feature is on only when EPISODIC_MEMORY_DIGEST is exactly `1`. Other values, such as `true`, leave it off.
 */
export declare function digestEnabled(): boolean;
/** One exchange row, as the exchanges table returns it. */
export interface ExchangeRow {
    id: string;
    project: string;
    timestamp: string;
    user_message: string;
    assistant_message: string;
    archive_path: string;
    line_start: number;
    line_end: number;
}
/** Map an exchange row to the public shape. */
export declare function toExchange(r: ExchangeRow): ConversationExchange;
/** The exchanges of one session, oldest first. */
export declare function sessionExchanges(db: Database.Database, project: string, sessionId: string): ConversationExchange[];
/** Tell whether a session is trivial: one exchange that is `/exit` or is shorter than 100 characters. */
export declare function isTrivial(exchanges: ConversationExchange[]): boolean;
/**
 * Run the digest job. The job writes session entries, then compresses older entries.
 *
 * The function returns at once, and writes nothing, when EPISODIC_MEMORY_DIGEST is not `1`.
 * The function also returns at once when EPISODIC_MEMORY_SUMMARIZER_GUARD is `1`, which marks a summarizer subprocess.
 * The job stops early when another agent holds the shared GPU and reports the reason in `deferred`.
 *
 * @param db the open index database
 * @param opts replaces the model call or the clock. Without it, the job uses the default summarizer call and the current time.
 */
export declare function runDigest(db: Database.Database, opts?: DigestOptions): Promise<DigestResult>;
