import fs from 'fs';

/** The summary file of an archived transcript: `<name>-summary.txt` beside `<name>.jsonl`. */
export function summaryPathFor(archivePath: string): string {
  return archivePath.replace('.jsonl', '-summary.txt');
}

/** The failure record of an archived transcript: `<name>-summary.failed`. */
export function summaryFailPathFor(archivePath: string): string {
  return archivePath.replace('.jsonl', '-summary.failed');
}

/**
 * Writes the record of a transcript that has no exchange: an empty summary file and a failure record
 * with the reason `no-exchanges`.
 *
 * Sync, the indexer and the verify repair all call this function. The empty file stops the summary loop
 * from queueing the transcript again, and `verify` finds a summary for it. The failure record says why
 * the file is empty. Before the three paths shared the function, only sync wrote the file, so a rebuild
 * left `verify` reporting the summary as missing. A failed write of the failure record is ignored.
 *
 * @param archivePath The archived `.jsonl` file.
 */
export function writeNoExchangeSummary(archivePath: string): void {
  fs.writeFileSync(summaryPathFor(archivePath), '', 'utf-8');
  try {
    fs.writeFileSync(summaryFailPathFor(archivePath), JSON.stringify({
      reason: 'no-exchanges', recordedAt: new Date().toISOString(),
    }), 'utf-8');
  } catch {
    // The empty summary is the record that matters. The reason is a note for a reader.
  }
}
