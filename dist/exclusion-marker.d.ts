/**
 * Tell whether the conversation must stay out of the index and out of the summaries.
 *
 * The function returns true when an exclusion marker occurs in the text of a user or assistant message. When the scan
 * cannot read the file, the function also returns true. The scan cannot then show that the file has no marker.
 */
export declare function shouldSkipConversation(filePath: string): boolean;
/**
 * Scan the whole file for an exclusion marker in the text of a user or assistant message.
 *
 * The scan reads the file one chunk at a time and checks one line at a time. A line that crosses a chunk boundary
 * is joined before the check. The function never throws. A file that the scan cannot open or read gives
 * `'unreadable'`.
 */
export declare function scanExclusionMarkers(filePath: string): 'marker' | 'clean' | 'unreadable';
