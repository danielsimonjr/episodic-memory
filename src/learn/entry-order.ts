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

/** The position of each known kind. A kind that is not in this table sorts after all known kinds. */
const KIND_POSITION: Readonly<Record<string, number>> = { instruction: 0, skill: 1, reflection: 2 };
const UNKNOWN_KIND_POSITION = 3;

function globalRank(entry: ProjectSlug): number {
  return entry.project === '*' ? 1 : 0;
}

function kindRank(entry: ProjectKindSlug): number {
  return Object.prototype.hasOwnProperty.call(KIND_POSITION, entry.kind) ? KIND_POSITION[entry.kind] : UNKNOWN_KIND_POSITION;
}

function compareProjectThenSlug(a: ProjectSlug, b: ProjectSlug): number {
  if (a.project !== b.project) return a.project < b.project ? -1 : 1;
  return a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0;
}

/**
 * Compare two entries: project rows before global rows, then project, then slug.
 * The `learn status` list and the `SKILL.md` export use this order.
 */
export function compareByProject(a: ProjectSlug, b: ProjectSlug): number {
  const globalDiff = globalRank(a) - globalRank(b);
  if (globalDiff !== 0) return globalDiff;
  return compareProjectThenSlug(a, b);
}

/**
 * Compare two entries by project, kind and slug.
 * Project rows come before global rows. The kind order is instruction, skill, reflection, then an unknown kind.
 * Then the order is by project, and then by slug. The store lists and the rendered block use this order.
 * The function never returns NaN, also for a kind that is not known.
 */
export function compareByProjectAndKind(a: ProjectKindSlug, b: ProjectKindSlug): number {
  const globalDiff = globalRank(a) - globalRank(b);
  if (globalDiff !== 0) return globalDiff;
  const kindDiff = kindRank(a) - kindRank(b);
  if (kindDiff !== 0) return kindDiff;
  return compareProjectThenSlug(a, b);
}
