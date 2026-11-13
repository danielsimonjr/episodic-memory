/**
 * The exclusion-marker scan of a transcript.
 *
 * The sync, the index commands, the verify command and the summary backfill use the scan. A conversation with a
 * marker stays out of the index and out of the summaries. The module imports only `fs` and `constants.ts`.
 */
import fs from 'fs';
import { SUMMARIZER_CONTEXT_MARKER } from './constants.js';

const EXCLUSION_MARKERS = [
  '<INSTRUCTIONS-TO-EPISODIC-MEMORY>DO NOT INDEX THIS CHAT</INSTRUCTIONS-TO-EPISODIC-MEMORY>',
  'Only use NO_INSIGHTS_FOUND',
  SUMMARIZER_CONTEXT_MARKER,
];

/** The size of one read of the marker scan. The scan reads the whole file, one chunk at a time. */
const MARKER_SCAN_CHUNK_BYTES = 1 << 20;

const EXCLUSION_MARKER_BYTES = EXCLUSION_MARKERS.map(marker => Buffer.from(marker, 'utf-8'));
const LONGEST_MARKER_BYTES = Math.max(...EXCLUSION_MARKER_BYTES.map(marker => marker.length));

/**
 * Tell whether the conversation must stay out of the index and out of the summaries.
 *
 * The function returns true when an exclusion marker occurs anywhere in the file. When the scan cannot read the
 * file, the function also returns true. The scan cannot then show that the file has no marker.
 */
export function shouldSkipConversation(filePath: string): boolean {
  return scanExclusionMarkers(filePath) !== 'clean';
}

/**
 * Scan the whole file for an exclusion marker.
 *
 * The scan compares bytes, one chunk at a time. Each chunk starts with the last bytes of the previous chunk.
 * As a result, a marker that crosses a chunk boundary still matches. The function never throws. A file that the
 * scan cannot open or read gives `'unreadable'`.
 */
export function scanExclusionMarkers(filePath: string): 'marker' | 'clean' | 'unreadable' {
  let fd: number | undefined;
  try {
    fd = fs.openSync(filePath, 'r');
    const carryBytes = LONGEST_MARKER_BYTES - 1;
    const window = Buffer.allocUnsafe(carryBytes + MARKER_SCAN_CHUNK_BYTES);
    let carried = 0;
    let bytesRead: number;
    while ((bytesRead = fs.readSync(fd, window, carried, MARKER_SCAN_CHUNK_BYTES, null)) > 0) {
      const filled = window.subarray(0, carried + bytesRead);
      if (EXCLUSION_MARKER_BYTES.some(marker => filled.includes(marker))) {
        return 'marker';
      }
      carried = Math.min(carryBytes, filled.length);
      filled.copy(window, 0, filled.length - carried);
    }
    return 'clean';
  } catch {
    return 'unreadable';
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        // The scan result stands. A failed close leaks one descriptor until the process exits.
      }
    }
  }
}
