/**
 * Shared types for the Recursa learned-knowledge store.
 *
 * Every import here is `import type`, which TypeScript erases: the compiled
 * module has no runtime imports, so it loads with no embedding runtime and no
 * database handle. `src/learn/knowledge-store.ts` is the only module that knows
 * how an entry is laid out on disk; every other module sees the shapes declared here.
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
/**
 * Return true when `slug` is safe to use as a directory name on every platform.
 *
 * A valid slug matches `SLUG_RE`. The pattern accepts lowercase letters, digits and hyphens. A slug has one to 64 characters. The first character must be a lowercase letter or a digit. The slug must not be a reserved Windows device name, such as `con`, `nul` or `com1`. An upper-case letter makes the check fail.
 */
export function isValidSlug(slug) {
    if (!SLUG_RE.test(slug))
        return false;
    return !WINDOWS_RESERVED_NAMES.has(slug.toLowerCase());
}
