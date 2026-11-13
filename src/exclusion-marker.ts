/**
 * The exclusion-marker scan of a transcript.
 *
 * The sync, the index commands, the verify command and the summary backfill use the scan. A conversation with a
 * marker stays out of the index and out of the summaries. A marker counts only in the text of a user or assistant
 * message. A session that reads a file with the marker has the marker in a tool input or a tool result, and that
 * session stays in the index. The module imports only `fs`, `constants.ts` and `content-text.ts`.
 */
import fs from 'fs';
import { SUMMARIZER_CONTEXT_MARKER } from './constants.js';
import { extractContentText } from './content-text.js';

const EXCLUSION_MARKERS = [
  '<INSTRUCTIONS-TO-EPISODIC-MEMORY>DO NOT INDEX THIS CHAT</INSTRUCTIONS-TO-EPISODIC-MEMORY>',
  'Only use NO_INSIGHTS_FOUND',
  SUMMARIZER_CONTEXT_MARKER,
];

/** The size of one read of the marker scan. The scan reads the whole file, one chunk at a time. */
const MARKER_SCAN_CHUNK_BYTES = 1 << 20;

const EXCLUSION_MARKER_BYTES = EXCLUSION_MARKERS.map(marker => Buffer.from(marker, 'utf-8'));
const NEWLINE = 0x0a;

/**
 * Return the message text of one transcript record, or an empty string for any other record.
 *
 * A Claude Code record of type `user` or `assistant` gives its string content or its `text` blocks. A Codex
 * `response_item` of type `message` from the user or the assistant gives its text. Tool uses, tool results,
 * `toolUseResult`, thinking blocks and every other record give no text.
 */
function messageText(record: unknown): string {
  if (!record || typeof record !== 'object') return '';
  const r = record as { type?: unknown; message?: { content?: unknown }; payload?: { type?: unknown; role?: unknown; content?: unknown } };
  if ((r.type === 'user' || r.type === 'assistant') && r.message && typeof r.message === 'object') {
    const content = r.message.content;
    if (typeof content === 'string') return content;
    if (!Array.isArray(content)) return '';
    return content
      .filter(block => block && block.type === 'text' && typeof block.text === 'string')
      .map(block => block.text as string)
      .join('\n');
  }
  const payload = r.payload;
  if (r.type === 'response_item' && payload && payload.type === 'message' && (payload.role === 'user' || payload.role === 'assistant')) {
    return extractContentText(payload.content);
  }
  return '';
}

/**
 * Tell whether one transcript line holds an exclusion marker in the text of a user or assistant message.
 *
 * The function parses only a line that holds the bytes of a marker. A line that does not parse can hold a message,
 * so the marker of that line counts.
 */
function lineHasMessageMarker(line: Buffer): boolean {
  if (!EXCLUSION_MARKER_BYTES.some(marker => line.includes(marker))) return false;
  let record: unknown;
  try {
    record = JSON.parse(line.toString('utf-8'));
  } catch {
    return true;
  }
  const text = messageText(record);
  return EXCLUSION_MARKERS.some(marker => text.includes(marker));
}

/**
 * Tell whether the conversation must stay out of the index and out of the summaries.
 *
 * The function returns true when an exclusion marker occurs in the text of a user or assistant message. When the scan
 * cannot read the file, the function also returns true. The scan cannot then show that the file has no marker.
 */
export function shouldSkipConversation(filePath: string): boolean {
  return scanExclusionMarkers(filePath) !== 'clean';
}

/**
 * Scan the whole file for an exclusion marker in the text of a user or assistant message.
 *
 * The scan reads the file one chunk at a time and checks one line at a time. A line that crosses a chunk boundary
 * is joined before the check. The function never throws. A file that the scan cannot open or read gives
 * `'unreadable'`.
 */
export function scanExclusionMarkers(filePath: string): 'marker' | 'clean' | 'unreadable' {
  let fd: number | undefined;
  try {
    fd = fs.openSync(filePath, 'r');
    const chunk = Buffer.allocUnsafe(MARKER_SCAN_CHUNK_BYTES);
    // The parts of the current line from earlier chunks. Each part is a copy, because the next read reuses `chunk`.
    let carried: Buffer[] = [];
    let bytesRead: number;
    while ((bytesRead = fs.readSync(fd, chunk, 0, MARKER_SCAN_CHUNK_BYTES, null)) > 0) {
      const filled = chunk.subarray(0, bytesRead);
      let start = 0;
      let end: number;
      while ((end = filled.indexOf(NEWLINE, start)) !== -1) {
        const part = filled.subarray(start, end);
        const line = carried.length > 0 ? Buffer.concat([...carried, part]) : part;
        carried = [];
        if (lineHasMessageMarker(line)) return 'marker';
        start = end + 1;
      }
      if (start < filled.length) carried.push(Buffer.from(filled.subarray(start)));
    }
    if (carried.length > 0 && lineHasMessageMarker(Buffer.concat(carried))) return 'marker';
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
