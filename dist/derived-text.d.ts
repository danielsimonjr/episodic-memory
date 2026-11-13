import type Database from 'better-sqlite3';
/** The counts of one call of `removeDerivedText`. */
export interface DerivedTextResult {
    /** Digest lines removed, in entries that stay and in entries that go. */
    digestLinesRemoved: number;
    /** Digest entries deleted because no line stayed. */
    digestEntriesDeleted: number;
}
/**
 * Remove the stored digest lines that cite a removed exchange.
 *
 * The function reads the mark groups of each line with `citedExchangeIds`, the reader of the digest search.
 * The function drops a whole line when the line cites an id in `removed`. A line without its marks states a claim
 * that no exchange supports. The function keeps the other lines in order. The function rebuilds the sources from the
 * kept lines, deduplicated, in first-seen order.
 *
 * @param text the stored text of a digest entry, one line for each statement
 * @param removed the ids of the exchanges that are no longer in the index
 */
export declare function dropLinesCiting(text: string, removed: ReadonlySet<string>): {
    text: string;
    sources: string[];
    dropped: number;
};
/**
 * Remove the digest text that cites deleted exchanges.
 *
 * A digest line cites the exchanges that the line comes from. After the index deletes an exchange, a line that cites
 * the exchange can still repeat the deleted conversation. The function drops each matching line from every digest
 * entry, active or superseded. An entry that keeps a line gets the new text, the new sources and a new full-text row. The function
 * deletes an entry with no line left and its full-text row. The entries that a deleted entry superseded become active
 * again. The next compression step can merge these entries again.
 *
 * The function calls no model and runs in one transaction. A database without the digest tables returns zero counts.
 * Call the function after the index deletes the exchanges. Pass the ids of the deleted exchanges.
 *
 * @param db The open database connection to change.
 * @param ids The ids of the exchanges that the index deleted.
 */
export declare function removeDerivedText(db: Database.Database, ids: readonly string[]): DerivedTextResult;
