/**
 * Shared types for the Recursa learned-knowledge store.
 *
 * Every import here is `import type`, which TypeScript erases: the compiled
 * module has no runtime imports, so it loads with no memoryjs, no transformers
 * and no database handle. `src/learn/knowledge-store.ts` is the only module that
 * imports memoryjs; every other module sees the shapes declared here.
 */
/** Names Windows refuses as file or directory names. */
const WINDOWS_RESERVED_NAMES = new Set([
    'con',
    'prn',
    'aux',
    'nul',
    ...Array.from({ length: 9 }, (_, i) => `com${i + 1}`),
    ...Array.from({ length: 9 }, (_, i) => `lpt${i + 1}`),
]);
/** A slug is also a directory name in the export, so it must be portable. */
export const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
export function isValidSlug(slug) {
    if (!SLUG_RE.test(slug))
        return false;
    return !WINDOWS_RESERVED_NAMES.has(slug.toLowerCase());
}
