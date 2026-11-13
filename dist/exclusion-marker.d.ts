/**
 * Tell whether the conversation must stay out of the index and out of the summaries.
 *
 * The function returns true when an exclusion marker occurs anywhere in the file. When the scan cannot read the
 * file, the function also returns true. The scan cannot then show that the file has no marker.
 */
export declare function shouldSkipConversation(filePath: string): boolean;
/**
 * Scan the whole file for an exclusion marker.
 *
 * The scan compares bytes, one chunk at a time. Each chunk starts with the last bytes of the previous chunk.
 * As a result, a marker that crosses a chunk boundary still matches. The function never throws. A file that the
 * scan cannot open or read gives `'unreadable'`.
 */
export declare function scanExclusionMarkers(filePath: string): 'marker' | 'clean' | 'unreadable';
