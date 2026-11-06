/**
 * Export the active skills as a tree of `SKILL.md` files.
 *
 * The knowledge store is the source of truth; this tree is generated output and
 * is the **only** place the feature replaces or removes files (spec §5.4, §7
 * rule 2). Two modes:
 *
 * - prune (the default, and only for the config-dir root): build the whole tree
 *   in a sibling `learned-skills.tmp-<pid>`, then rename the old root aside and
 *   the new tree into place. A rename that keeps failing with `EPERM` / `EBUSY`
 *   (a file open in a session on Windows) leaves the old tree alone, keeps the
 *   temp tree for the next run and reports a warning. It never throws.
 * - copy (`learn export --to <dir>`): write file by file into the target and
 *   remove nothing there, ever.
 *
 * Every field is screened and redacted again on the way out: this text lands in
 * a project directory and is read by later sessions and learners.
 */
import { type LearnDbs } from './types.js';
export interface ExportResult {
    /** Absolute paths of the `SKILL.md` files written. */
    written: string[];
    /** Absolute paths of skill directories the prune removed. */
    removed: string[];
    /** Non-fatal problems: a refused root, a failed rename, a withheld skill. */
    warnings: string[];
}
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
