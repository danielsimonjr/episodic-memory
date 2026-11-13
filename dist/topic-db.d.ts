import type { Database } from './sqlite.js';
/** A staged edit: the validated text of each written document, and the slugs to delete. */
export interface TopicEdit {
    /** The validated text of each written document. Every paragraph has an identifier. */
    files: {
        slug: string;
        text: string;
    }[];
    /** The slugs of the documents to delete. */
    deletes: string[];
    /** The session that the edit organizes. When set, the install records it as `done` in the same transaction. */
    sessionId?: string;
}
/** The status of a session in topic memory. */
export type TopicSessionStatus = 'pending' | 'done' | 'rejected';
/** The progress row of one session. */
export interface TopicSession {
    status: TopicSessionStatus;
    /** The number of failed model calls. */
    attempts: number;
    /** The last error text, or null. */
    error: string | null;
}
/** A unit that a search found. */
export interface TopicUnitHit {
    project: string;
    slug: string;
    heading: string;
    unitId: string;
    text: string;
    /** The event times of the unit. With a range, the times that overlap the range. */
    times: string[];
}
/** A unit at the other end of a link. */
export interface TopicLinkedUnit {
    slug: string;
    heading: string;
    unitId: string;
    text: string;
}
/** One footnote, placed on the timeline. */
export interface TopicEvent {
    time: string;
    /** The text of the paragraph up to the footnote reference. */
    statement: string;
    unitId: string;
    slug: string;
    heading: string;
    /** The exchange ids that the footnote cites. */
    sources: string[];
}
/** A time range. Each bound is a YYYY, YYYY-MM or YYYY-MM-DD value, and both bounds are inclusive. */
export interface TopicRange {
    from?: string;
    to?: string;
}
/** The schema of the topic tables. The function creates each table when it does not exist. */
export declare function ensureTopicSchema(db: Database): void;
/**
 * Install one edit and rebuild the derived tables of the project, in one transaction.
 *
 * The function first compares the stored `updated_at` of each shown document with `expectedUpdatedAt`.
 * On a mismatch, or when a shown document is gone, it returns `stale` and writes nothing. Otherwise it
 * writes the documents, rebuilds the units, links, events and full-text rows of the project, and keeps
 * the `seq` of each unit that stays. When `edit.sessionId` is set, it records that session as `done`.
 * A failed write throws, and the transaction rolls back every change.
 *
 * @param db the open index database
 * @param project the project key
 * @param edit the validated texts and the deleted slugs
 * @param expectedUpdatedAt the `updated_at` that each shown document had when the prompt was built, by slug
 */
export declare function installTopicEdit(db: Database, project: string, edit: TopicEdit, expectedUpdatedAt: ReadonlyMap<string, string>): 'installed' | 'stale';
/**
 * List the documents of a project with their title and unit count, by slug.
 *
 * @param db the open index database
 * @param project the project key
 */
export declare function listTopicDocs(db: Database, project: string): {
    slug: string;
    title: string;
    unitCount: number;
}[];
/**
 * Read one document of a project.
 *
 * @param db the open index database
 * @param project the project key
 * @param slug the slug of the document
 * @returns the text and its `updated_at`, or null when the document does not exist
 */
export declare function readTopicDoc(db: Database, project: string, slug: string): {
    slug: string;
    text: string;
    updatedAt: string;
} | null;
/**
 * Search the paragraphs of the topic documents with full-text search.
 *
 * The function keeps only letters, digits and underscores from the query, and matches every remaining word.
 * With `from` or `to`, the function keeps a unit only when one of its events overlaps the range, and it
 * lists the overlapping times. Without a range, it lists every event time. The function returns at most
 * `limit` units (default 10), in rank order.
 *
 * @param db the open index database
 * @param query the words to search for
 * @param opts `project` limits the search to one project. `from` and `to` set the range. `limit` caps the result.
 */
export declare function searchTopicUnits(db: Database, query: string, opts?: {
    project?: string;
    from?: string;
    to?: string;
    limit?: number;
}): TopicUnitHit[];
/**
 * List the outgoing links and the backlinks of one unit.
 *
 * @param db the open index database
 * @param project the project key
 * @param unitId the identifier of the unit
 */
export declare function topicLinks(db: Database, project: string, unitId: string): {
    outgoing: TopicLinkedUnit[];
    backlinks: TopicLinkedUnit[];
} | null;
/**
 * List the footnote events of a project in time order, optionally within a range.
 *
 * Each event has its time, its statement, its unit and the exchange ids it cites. An event is in the range
 * when its precision-padded interval overlaps the range. A month `2026-08` covers `2026-08-01` to `2026-08-31`.
 *
 * @param db the open index database
 * @param project the project key
 * @param range the optional bounds, inclusive
 */
export declare function topicTimeline(db: Database, project: string, range?: TopicRange): TopicEvent[];
/**
 * Read the progress row of one session.
 *
 * @param db the open index database
 * @param project the project key
 * @param sessionId the session id
 * @returns the row, or null when the session has no row
 */
export declare function getTopicSession(db: Database, project: string, sessionId: string): TopicSession | null;
/**
 * Set the status of a session and its last error. The attempt count does not change.
 *
 * @param db the open index database
 * @param project the project key
 * @param sessionId the session id
 * @param status the new status
 * @param error the error text, or null
 */
export declare function setTopicSessionStatus(db: Database, project: string, sessionId: string, status: 'done' | 'rejected', error?: string | null): void;
/**
 * Count one failed model call for a session and return the new count.
 *
 * The function creates the row as `pending` on the first failure. It keeps the status as it is.
 *
 * @param db the open index database
 * @param project the project key
 * @param sessionId the session id
 * @param error the error text of the failed call
 */
export declare function recordTopicFailedCall(db: Database, project: string, sessionId: string, error: string): number;
/**
 * Read a value of the topic meta table.
 *
 * @param db the open index database
 * @param key the key to read
 * @returns the value, or null when the key is not set
 */
export declare function getTopicMeta(db: Database, key: string): string | null;
/**
 * Set a value of the topic meta table. The function replaces an earlier value.
 *
 * @param db the open index database
 * @param key the key to set
 * @param value the new value
 */
export declare function setTopicMeta(db: Database, key: string, value: string): void;
