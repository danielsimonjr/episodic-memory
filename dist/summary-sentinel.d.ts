/** The summary file of an archived transcript: `<name>-summary.txt` beside `<name>.jsonl`. */
export declare function summaryPathFor(archivePath: string): string;
/** The failure record of an archived transcript: `<name>-summary.failed`. */
export declare function summaryFailPathFor(archivePath: string): string;
/**
 * Writes the record of a transcript that has no exchange: an empty summary file and a failure record
 * with the reason `no-exchanges`.
 *
 * Sync, the indexer and the verify repair all call this function. The empty file stops the summary loop
 * from queueing the transcript again, and `verify` finds a summary for it. The failure record says why
 * the file is empty. A failed write of the failure record is ignored.
 *
 * @param archivePath The archived `.jsonl` file.
 */
export declare function writeNoExchangeSummary(archivePath: string): void;
