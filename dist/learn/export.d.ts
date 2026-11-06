/**
 * Export the active skills as a tree of `SKILL.md` files.
 *
 * The knowledge store is the source of truth. This tree contains generated output, and
 * the feature replaces or removes files only in this tree (spec §5.4, §7
 * rule 2). Two modes:
 *
 * - prune (the default, and only for the config-dir root): build the whole tree
 *   in a sibling `learned-skills.tmp-<pid>`. Then rename the old root aside and
 *   the new tree into place.
 *   A rename that keeps failing with `EPERM` / `EBUSY` (a file open in a session on
 *   Windows) leaves the old tree alone. The export keeps the temp tree for the next
 *   run and reports a warning instead of throwing.
 * - copy (`learn export --to <dir>`): write file by file into the target and
 *   remove nothing there, ever.
 *
 * The export screens and redacts every field again on the way out. This text lands in
 * a project directory, and later sessions and learners read it.
 */
import { type LearnDbs } from './types.js';
/** The outcome of an export that exportSkills runs. */
export interface ExportResult {
    /** Absolute paths of the `SKILL.md` files written. */
    written: string[];
    /** Absolute paths of skill directories the prune removed. */
    removed: string[];
    /** Non-fatal problems: a refused root, a failed rename, a withheld skill. */
    warnings: string[];
}
/** Options for exportSkills. */
export interface ExportOptions {
    /**
     * Replace the whole tree instead of copying into it. Default true. Only the
     * default config-dir root is ever pruned.
     */
    prune?: boolean;
}
/**
 * Write the active skills under `rootDir`.
 *
 * Default root: `<configDir>/learned-skills`, replaced wholesale. `rootDir`
 * elsewhere means "copy here and remove nothing", which is what
 * `learn export --to <dir>` asks for.
 */
export declare function exportSkills(dbs: LearnDbs, rootDir?: string, opts?: ExportOptions): Promise<ExportResult>;
