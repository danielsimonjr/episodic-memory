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
import fs from 'fs';
import path from 'path';
import { getSuperpowersDir } from '../paths.js';
import { redactSecrets } from '../redact.js';
import { screenLearnedText } from './learned-text-screen.js';
import { redactKeepingMarks } from './learn-inject.js';
import { isValidSlug } from './types.js';
/** The default root, a sibling of `learned/` under the config dir. */
const DEFAULT_ROOT_NAME = 'learned-skills';
/** Rename/remove attempts, and the same backoff the tests' `safeRmSync` uses. */
const ATTEMPTS = 5;
/** A directory name for a project key. `*` (the global scope) becomes `global`. */
const GLOBAL_DIR = 'global';
function sleep(ms) {
    const start = Date.now();
    while (Date.now() - start < ms) {
        // Spin: the callers are synchronous, so there is nothing to await here.
    }
}
/**
 * A portable directory name for a project key.
 *
 * Project keys are made from a cwd (`[^A-Za-z0-9]` → `-`), so this is normally
 * the identity; the rewrite only defends against a hand-written key and against
 * `.`/`..`, which `path.join` would resolve as a traversal.
 */
function projectDir(project) {
    if (project === '*')
        return GLOBAL_DIR;
    const safe = project.replace(/[^A-Za-z0-9._-]/g, '-');
    if (!safe || safe === '.' || safe === '..')
        return null;
    if (safe !== project) {
        // A key that needed rewriting would not round-trip through the directory
        // name, so the export keeps its distance rather than writing a tree a later
        // reader cannot map back to an entry.
        return null;
    }
    return safe;
}
/** True when `root` is `<config dir>/learned-skills`, the only pruned root. */
function isDefaultExportRoot(root) {
    const expected = path.resolve(path.join(getSuperpowersDir(), DEFAULT_ROOT_NAME));
    if (path.resolve(root) === expected)
        return true;
    try {
        if (fs.existsSync(root) && fs.existsSync(expected)) {
            return fs.realpathSync(root) === fs.realpathSync(expected);
        }
    }
    catch {
        return false;
    }
    return false;
}
function isInsideConfigDir(target) {
    let base;
    try {
        base = fs.realpathSync(getSuperpowersDir());
    }
    catch {
        return false;
    }
    const resolved = path.resolve(target);
    let existing = resolved;
    const tail = [];
    while (!fs.existsSync(existing)) {
        const parent = path.dirname(existing);
        if (parent === existing)
            break;
        tail.unshift(path.basename(existing));
        existing = parent;
    }
    let real;
    try {
        real = fs.realpathSync(existing);
    }
    catch {
        return false;
    }
    const full = tail.length > 0 ? path.join(real, ...tail) : real;
    const rel = path.relative(base, full);
    return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}
/** Rename, retrying the Windows sharing violations; rethrow anything else. */
function renameWithRetry(from, to) {
    let lastError;
    for (let attempt = 0; attempt < ATTEMPTS; attempt += 1) {
        try {
            fs.renameSync(from, to);
            return;
        }
        catch (error) {
            const code = error.code;
            if (code !== 'EPERM' && code !== 'EBUSY')
                throw error;
            lastError = error;
            sleep(20 * 2 ** attempt);
        }
    }
    throw lastError;
}
/** Best-effort recursive remove with the same backoff. Never throws. */
function removeTree(target) {
    for (let attempt = 0; attempt < ATTEMPTS; attempt += 1) {
        try {
            fs.rmSync(target, { recursive: true, force: true });
            return;
        }
        catch {
            sleep(20 * 2 ** attempt);
        }
    }
    try {
        fs.rmSync(target, { recursive: true, force: true });
    }
    catch {
        // The OS reclaims it eventually; a stale temp tree is not worth a failure.
    }
}
/** `<project>/<slug>` for every skill directory under `root`. */
function listSkillDirs(root) {
    const found = [];
    let projects;
    try {
        projects = fs.readdirSync(root);
    }
    catch {
        return found;
    }
    for (const project of projects) {
        const projectPath = path.join(root, project);
        let slugs;
        try {
            if (!fs.statSync(projectPath).isDirectory())
                continue;
            slugs = fs.readdirSync(projectPath);
        }
        catch {
            continue;
        }
        for (const slug of slugs) {
            try {
                if (fs.statSync(path.join(projectPath, slug)).isDirectory()) {
                    found.push(path.join(project, slug));
                }
            }
            catch {
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
 * set written at insert time, so they are resolved against the index here. An
 * entry that carries `sources` directly (a test seam, a future read-back) is
 * used as-is.
 */
function sourcesFor(dbs, entry) {
    if (entry.sources.length > 0)
        return entry.sources;
    const ids = new Set();
    for (const match of entry.body.matchAll(/#([0-9a-f]{32})/g))
        ids.add(match[1]);
    if (ids.size === 0)
        return [];
    const found = new Map();
    const statement = 'SELECT archive_path, line_start, line_end, session_id FROM exchanges WHERE id = ?';
    for (const id of ids) {
        try {
            const row = dbs.index.prepare(statement).get(id);
            if (!row)
                continue;
            found.set(id, {
                id,
                path: row.archive_path,
                lineStart: Number(row.line_start),
                lineEnd: Number(row.line_end),
                sessionId: row.session_id ?? null,
            });
        }
        catch {
            // A database without an `exchanges` table (a scratch handle) cites nothing.
            return [];
        }
    }
    return [...found.values()].sort((left, right) => (left.id < right.id ? -1 : 1));
}
function sourcesText(sources) {
    if (sources.length === 0)
        return 'none';
    return sources.map(source => `${source.path}:${source.lineStart}-${source.lineEnd}`).join('; ');
}
/** Project rows first, then the global ones, then slug — `listActive`'s order. */
function orderForExport(a, b) {
    const aGlobal = a.project === '*' ? 1 : 0;
    const bGlobal = b.project === '*' ? 1 : 0;
    if (aGlobal !== bGlobal)
        return aGlobal - bGlobal;
    if (a.project !== b.project)
        return a.project < b.project ? -1 : 1;
    return a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0;
}
/**
 * One `SKILL.md`, or a reason it was withheld.
 *
 * A metadata field that fails the screen withholds the whole skill (the same
 * rule the `skills` tool applies): a file whose description cannot be trusted is
 * not one the plugin should put on disk. A single body line that fails is
 * dropped; if every line drops, the skill is withheld.
 */
function renderSkillFile(entry, sources, redact) {
    const prepare = (value, field) => {
        const redacted = redactKeepingMarks(value, redact);
        const screened = screenLearnedText(redacted, { kind: 'skill', field });
        return screened.ok ? { value: redacted } : { withheld: screened.reason };
    };
    const description = prepare(entry.description, 'description');
    if ('withheld' in description)
        return { withheld: description.withheld };
    const scope = prepare(entry.scope, 'scope');
    if ('withheld' in scope)
        return { withheld: scope.withheld };
    const sourcesField = prepare(sourcesText(sources), 'sources');
    if ('withheld' in sourcesField)
        return { withheld: sourcesField.withheld };
    const body = [];
    for (const raw of entry.body.split('\n')) {
        const trimmed = raw.trim();
        if (!trimmed)
            continue;
        const line = redactKeepingMarks(trimmed, redact);
        if (screenLearnedText(line, { kind: 'skill', field: 'body' }).ok)
            body.push(line);
    }
    if (body.length === 0 && entry.body.trim())
        return { withheld: 'body' };
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
export async function exportSkills(dbs, rootDir = path.join(getSuperpowersDir(), DEFAULT_ROOT_NAME), opts = {}) {
    const result = { written: [], removed: [], warnings: [] };
    const root = path.resolve(rootDir);
    // Prune replaces the tree. That is only the default `<config>/learned-skills`
    // root. A custom root inside the config dir is a copy: write the active
    // skills and leave everything else (spec: prune is default-root only).
    const prune = opts.prune !== false && isDefaultExportRoot(root);
    const redact = (text) => dbs.store.redactPii(redactSecrets(text));
    const entries = (await dbs.store.listByStatus(['active'], ['skill']))
        .filter(entry => entry.supersededBy === null)
        .sort(orderForExport);
    /** `path.relative(root, file)` → content, in the export's own order. */
    const files = [];
    for (const entry of entries) {
        // Re-checked here, not only at insert: a slug that reached the store through
        // an older build must never reach `path.join` unvalidated.
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
            result.warnings.push(`refusing to replace ${root}: it is outside ${getSuperpowersDir()} (use --to to copy instead)`);
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
        // The tree is generated output and the one thing the feature deletes. It is
        // only ever allowed to do that under the config dir; a root anywhere else is
        // a refusal, not a best-effort prune.
        result.warnings.push(`refusing to replace ${root}: it is outside ${getSuperpowersDir()} (use --to to copy instead)`);
        return result;
    }
    const tempRoot = `${root}.tmp-${process.pid}`;
    removeTree(tempRoot);
    // Created even when nothing is active: an export that learns nothing must
    // still replace the tree (an empty one) rather than leave stale skills.
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
        }
        catch (error) {
            result.written = [];
            result.warnings.push(`could not place ${root} (${describe(error)}); the tree is kept at ${tempRoot}`);
            return result;
        }
    }
    else {
        const aside = `${root}.old-${process.pid}`;
        removeTree(aside);
        try {
            renameWithRetry(root, aside);
        }
        catch (error) {
            result.written = [];
            result.warnings.push(`could not replace ${root} (${describe(error)}); the old tree is unchanged and the new one is at ${tempRoot}`);
            return result;
        }
        try {
            renameWithRetry(tempRoot, root);
        }
        catch (error) {
            // Put the old tree back so a failed export never leaves no tree at all.
            try {
                renameWithRetry(aside, root);
            }
            catch {
                // Best effort: the warning below still names the aside directory.
            }
            result.written = [];
            result.warnings.push(`could not replace ${root} (${describe(error)}); the old tree is restored and the new one is kept at ${tempRoot}`);
            return result;
        }
        removeTree(aside);
    }
    for (const relative of previous) {
        if (writtenKeys.has(relative))
            continue;
        result.removed.push(path.join(root, relative));
    }
    return result;
}
function describe(error) {
    if (error instanceof Error) {
        const code = error.code;
        return code ? `${code}: ${error.message}` : error.message;
    }
    return String(error);
}
