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

import fs from 'fs';
import path from 'path';
import { getSuperpowersDir } from '../paths.js';
import { renameWithRetry, retryDelayMs, sleepSync, RETRY_ATTEMPTS } from '../fs-retry.js';
import { redactSecrets } from '../redact.js';
import { screenLearnedText } from './learned-text-screen.js';
import { redactKeepingMarks, type RedactFn } from './learn-inject.js';
import { isValidSlug, type KnowledgeEntry, type LearnDbs, type SourceRef } from './types.js';
import { compareByProject } from './entry-order.js';

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

/** The default root, a sibling of `learned/` under the config dir. */
const DEFAULT_ROOT_NAME = 'learned-skills';

/** A directory name for a project key. `*` (the global scope) becomes `global`. */
const GLOBAL_DIR = 'global';

/**
 * A portable directory name for a project key.
 *
 * A project key comes from a cwd by replacing each character outside `[A-Za-z0-9]` with `-`.
 * So the rewrite is normally the identity. The rewrite only defends against a hand-written key and
 * against `.`/`..`, which `path.join` would resolve as a traversal.
 */
function projectDir(project: string): string | null {
  if (project === '*') return GLOBAL_DIR;
  const safe = project.replace(/[^A-Za-z0-9._-]/g, '-');
  if (!safe || safe === '.' || safe === '..') return null;
  if (safe !== project) {
    // A key that needed rewriting would not round-trip through the directory name.
    // The export keeps its distance and writes no tree that a later reader cannot map back to an entry.
    return null;
  }
  return safe;
}

/** True when `root` is `<config dir>/learned-skills`, the only pruned root. */
function isDefaultExportRoot(root: string): boolean {
  const expected = path.resolve(path.join(getSuperpowersDir(), DEFAULT_ROOT_NAME));
  if (path.resolve(root) === expected) return true;
  try {
    if (fs.existsSync(root) && fs.existsSync(expected)) {
      return fs.realpathSync(root) === fs.realpathSync(expected);
    }
  } catch {
    return false;
  }
  return false;
}

function isInsideConfigDir(target: string): boolean {
  let base: string;
  try {
    base = fs.realpathSync(getSuperpowersDir());
  } catch {
    return false;
  }

  const resolved = path.resolve(target);
  let existing = resolved;
  const tail: string[] = [];
  while (!fs.existsSync(existing)) {
    const parent = path.dirname(existing);
    if (parent === existing) break;
    tail.unshift(path.basename(existing));
    existing = parent;
  }

  let real: string;
  try {
    real = fs.realpathSync(existing);
  } catch {
    return false;
  }
  const full = tail.length > 0 ? path.join(real, ...tail) : real;
  const rel = path.relative(base, full);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/** Best-effort recursive remove with the same backoff. Never throws. */
function removeTree(target: string): void {
  for (let attempt = 0; attempt < RETRY_ATTEMPTS; attempt += 1) {
    try {
      fs.rmSync(target, { recursive: true, force: true });
      return;
    } catch {
      sleepSync(retryDelayMs(attempt));
    }
  }
  try {
    fs.rmSync(target, { recursive: true, force: true });
  } catch {
    // The OS reclaims it eventually; a stale temp tree is not worth a failure.
  }
}

/** `<project>/<slug>` for every skill directory under `root`. */
function listSkillDirs(root: string): string[] {
  const found: string[] = [];
  let projects: string[];
  try {
    projects = fs.readdirSync(root);
  } catch {
    return found;
  }
  for (const project of projects) {
    const projectPath = path.join(root, project);
    let slugs: string[];
    try {
      if (!fs.statSync(projectPath).isDirectory()) continue;
      slugs = fs.readdirSync(projectPath);
    } catch {
      continue;
    }
    for (const slug of slugs) {
      try {
        if (fs.statSync(path.join(projectPath, slug)).isDirectory()) {
          found.push(path.join(project, slug));
        }
      } catch {
        // A vanished entry is not a skill directory.
      }
    }
  }
  return found;
}

/**
 * The addresses a skill cites.
 *
 * `KnowledgeEntry.sources` comes back empty from the store: sources live as
 * `cites` relations, not as observations. The body's `[#id]` marks are the same
 * set written at insert time. The function resolves them against the index here. An
 * entry that carries `sources` directly (a test seam, a future read-back) is
 * used as-is.
 */
function sourcesFor(dbs: LearnDbs, entry: KnowledgeEntry): SourceRef[] {
  if (entry.sources.length > 0) return entry.sources;

  const ids = new Set<string>();
  for (const match of entry.body.matchAll(/#([0-9a-f]{32})/g)) ids.add(match[1]);
  if (ids.size === 0) return [];

  const found = new Map<string, SourceRef>();
  const statement = 'SELECT archive_path, line_start, line_end, session_id FROM exchanges WHERE id = ?';
  for (const id of ids) {
    try {
      const row = dbs.index.prepare(statement).get(id) as
        | { archive_path: string; line_start: number; line_end: number; session_id: string | null }
        | undefined;
      if (!row) continue;
      found.set(id, {
        id,
        path: row.archive_path,
        lineStart: Number(row.line_start),
        lineEnd: Number(row.line_end),
        sessionId: row.session_id ?? null,
      });
    } catch {
      // A database without an `exchanges` table (a scratch handle) cites nothing.
      return [];
    }
  }
  return [...found.values()].sort((left, right) => (left.id < right.id ? -1 : 1));
}

function sourcesText(sources: readonly SourceRef[]): string {
  if (sources.length === 0) return 'none';
  return sources.map(source => `${source.path}:${source.lineStart}-${source.lineEnd}`).join('; ');
}

/**
 * One `SKILL.md`, or the reason that the export did not write it.
 *
 * A metadata field that fails the screen withholds the whole skill, as the
 * `skills` tool does. The plugin does not write a file whose description the screen rejects. The export drops a body line that fails the screen. If every line drops,
 * the export withholds the skill.
 */
function renderSkillFile(
  entry: KnowledgeEntry,
  sources: readonly SourceRef[],
  redact: RedactFn
): { text: string } | { withheld: string } {
  const prepare = (
    value: string,
    field: string
  ): { value: string } | { withheld: string } => {
    const redacted = redactKeepingMarks(value, redact);
    const screened = screenLearnedText(redacted, { kind: 'skill', field });
    return screened.ok ? { value: redacted } : { withheld: screened.reason };
  };

  const description = prepare(entry.description, 'description');
  if ('withheld' in description) return { withheld: description.withheld };
  const scope = prepare(entry.scope, 'scope');
  if ('withheld' in scope) return { withheld: scope.withheld };
  const sourcesField = prepare(sourcesText(sources), 'sources');
  if ('withheld' in sourcesField) return { withheld: sourcesField.withheld };

  const body: string[] = [];
  for (const raw of entry.body.split('\n')) {
    const trimmed = raw.trim();
    if (!trimmed) continue;
    const line = redactKeepingMarks(trimmed, redact);
    if (screenLearnedText(line, { kind: 'skill', field: 'body' }).ok) body.push(line);
  }
  if (body.length === 0 && entry.body.trim()) return { withheld: 'body' };

  const front = [
    '---',
    `name: ${entry.slug}`,
    `description: ${JSON.stringify(description.value)}`,
    'metadata:',
    `  scope: ${JSON.stringify(scope.value)}`,
    `  confidence: ${entry.confidence}`,
    `  sources: ${JSON.stringify(sourcesField.value)}`,
    `  version: ${entry.version}`,
    `  run: ${JSON.stringify(entry.runId)}`,
    '---',
  ];
  return { text: `${front.join('\n')}\n\n${body.join('\n')}\n` };
}

/**
 * Write the active skills under `rootDir`.
 *
 * Default root: `<configDir>/learned-skills`, replaced wholesale. `rootDir`
 * elsewhere means "copy here and remove nothing", which is what
 * `learn export --to <dir>` asks for.
 */
export async function exportSkills(
  dbs: LearnDbs,
  rootDir: string = path.join(getSuperpowersDir(), DEFAULT_ROOT_NAME),
  opts: ExportOptions = {}
): Promise<ExportResult> {
  const result: ExportResult = { written: [], removed: [], warnings: [] };
  const root = path.resolve(rootDir);
  // Prune replaces the tree. Pruning applies only to the default `<config>/learned-skills`
  // root. A custom root inside the config dir is a copy. The copy writes the active
  // skills and leaves everything else (spec: prune is default-root only).
  const prune = opts.prune !== false && isDefaultExportRoot(root);

  const redact: RedactFn = (text: string) => dbs.store.redactPii(redactSecrets(text));

  const entries = (await dbs.store.listByStatus(['active'], ['skill']))
    .filter(entry => entry.supersededBy === null)
    .sort(compareByProject);

  /** `path.relative(root, file)` → content, in the export's own order. */
  const files: Array<{ relative: string; text: string }> = [];
  for (const entry of entries) {
    // Re-check here, not only at insert, because the store can hold a slug that another
    // write put there. Such a slug must never reach `path.join` unvalidated.
    if (!isValidSlug(entry.slug)) {
      result.warnings.push(`skipped ${entry.project}/${entry.slug}: invalid slug`);
      continue;
    }
    const project = projectDir(entry.project);
    if (project === null) {
      result.warnings.push(`skipped ${entry.project}/${entry.slug}: unusable project key`);
      continue;
    }
    const rendered = renderSkillFile(entry, sourcesFor(dbs, entry), redact);
    if ('withheld' in rendered) {
      result.warnings.push(`withheld ${project}/${entry.slug}: ${rendered.withheld}`);
      continue;
    }
    files.push({ relative: path.join(project, entry.slug, 'SKILL.md'), text: rendered.text });
  }

  if (!prune) {
    // `--to` (explicit `prune: false`) may write outside the config dir and
    // removes nothing. Any other non-default root outside the config dir is
    // still a refusal: the caller did not opt into a copy.
    if (opts.prune !== false && !isInsideConfigDir(root)) {
      result.warnings.push(
        `refusing to replace ${root}: it is outside ${getSuperpowersDir()} (use --to to copy instead)`
      );
      return result;
    }
    for (const file of files) {
      const target = path.join(root, file.relative);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, file.text, 'utf-8');
      result.written.push(target);
    }
    return result;
  }

  if (!isInsideConfigDir(root)) {
    // The generated tree is the one thing the feature deletes. The feature deletes the tree
    // only under the config dir; a root anywhere else is a refusal, not a best-effort prune.
    result.warnings.push(
      `refusing to replace ${root}: it is outside ${getSuperpowersDir()} (use --to to copy instead)`
    );
    return result;
  }

  const tempRoot = `${root}.tmp-${process.pid}`;
  removeTree(tempRoot);
  // The export creates the temp tree even when no skill is active. With no active
  // skill, the export still replaces the tree with an empty one, rather than
  // leaving stale skills.
  fs.mkdirSync(tempRoot, { recursive: true, mode: 0o700 });
  for (const file of files) {
    const target = path.join(tempRoot, file.relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, file.text, 'utf-8');
    result.written.push(path.join(root, file.relative));
  }

  const previous = listSkillDirs(root);
  const writtenKeys = new Set(files.map(file => path.dirname(file.relative)));

  if (!fs.existsSync(root)) {
    try {
      renameWithRetry(tempRoot, root);
    } catch (error) {
      result.written = [];
      result.warnings.push(
        `could not place ${root} (${describe(error)}); the tree is kept at ${tempRoot}`
      );
      return result;
    }
  } else {
    const aside = `${root}.old-${process.pid}`;
    removeTree(aside);
    try {
      renameWithRetry(root, aside);
    } catch (error) {
      result.written = [];
      result.warnings.push(
        `could not replace ${root} (${describe(error)}); the old tree is unchanged and the new one is at ${tempRoot}`
      );
      return result;
    }
    try {
      renameWithRetry(tempRoot, root);
    } catch (error) {
      // Put the old tree back so a failed export never leaves no tree at all.
      try {
        renameWithRetry(aside, root);
      } catch {
        // Best effort: the warning below still names the aside directory.
      }
      result.written = [];
      result.warnings.push(
        `could not replace ${root} (${describe(error)}); the old tree is restored and the new one is kept at ${tempRoot}`
      );
      return result;
    }
    removeTree(aside);
  }

  for (const relative of previous) {
    if (writtenKeys.has(relative)) continue;
    result.removed.push(path.join(root, relative));
  }
  return result;
}

function describe(error: unknown): string {
  if (error instanceof Error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code ? `${code}: ${error.message}` : error.message;
  }
  return String(error);
}
