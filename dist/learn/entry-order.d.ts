/**
 * The sort orders of learned entries. Imports nothing.
 *
 * Project rows come before the global rows (`project` is `*`). A reader therefore sees a project rule before a global rule.
 */
/** The fields that `compareByProject` reads. */
export interface ProjectSlug {
    project: string;
    slug: string;
}
/** The fields that `compareByProjectAndKind` reads. */
export interface ProjectKindSlug extends ProjectSlug {
    kind: string;
}
/**
 * Compare two entries: project rows before global rows, then project, then slug.
 * The `learn status` list and the `SKILL.md` export use this order.
 */
export declare function compareByProject(a: ProjectSlug, b: ProjectSlug): number;
/**
 * Compare two entries by project, kind and slug.
 * Project rows come before global rows. The kind order is instruction, skill, reflection, then an unknown kind.
 * Then the order is by project, and then by slug. The store lists and the rendered block use this order.
 * The function never returns NaN, also for a kind that is not known.
 */
export declare function compareByProjectAndKind(a: ProjectKindSlug, b: ProjectKindSlug): number;
