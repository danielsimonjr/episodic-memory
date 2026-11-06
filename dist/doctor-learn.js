/**
 * The `learn` section of `episodic-memory doctor`.
 *
 * Kept apart from `doctor.ts` because collecting it needs a read-only peek at
 * the learning trace and the memoryjs store, while `doctor.ts` stays importable
 * from a context with neither. `collectLearnDoctorSection()` is best-effort
 * throughout: a missing or half-written `learned/` is something to *report*,
 * never a reason for doctor itself to fail.
 *
 * Deliberately no audit-chain item: memoryjs records its governance chain only
 * under `MEMORY_GOVERNANCE_ENABLED=true`, which this plugin never sets, so an
 * empty chain would read as a defect when it is the normal state.
 */
import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import { getSuperpowersDir } from './paths.js';
const LEARNED_SKILLS_DIR = 'learned-skills';
const LEARNED_DIR_NAME = 'learned';
function emptyCounts() {
    return { candidate: 0, active: 0, retired: 0 };
}
export function emptyLearnSection(learnedDir = '') {
    return {
        present: false,
        learnedDir,
        knowledgeDbSizeBytes: null,
        learningDbSizeBytes: null,
        entryCounts: {
            instruction: emptyCounts(),
            skill: emptyCounts(),
            reflection: emptyCounts(),
        },
        candidatesAwaitingApproval: 0,
        latestRun: null,
        unresolvedSources: [],
        exportTree: { present: false, files: 0, bytes: 0 },
        betterSqlite3TopLevel: null,
        betterSqlite3FromMemoryjs: null,
        betterSqlite3Shared: true,
    };
}
function sizeOf(filePath) {
    try {
        return fs.statSync(filePath).size;
    }
    catch {
        return null;
    }
}
/** Recursive file count and byte total; a missing tree is `0/0`. */
function treeSize(root) {
    if (!fs.existsSync(root))
        return { present: false, files: 0, bytes: 0 };
    let files = 0;
    let bytes = 0;
    const walk = (dir) => {
        let entries;
        try {
            entries = fs.readdirSync(dir, { withFileTypes: true });
        }
        catch {
            return;
        }
        for (const entry of entries) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                walk(full);
            }
            else if (entry.isFile()) {
                files += 1;
                bytes += sizeOf(full) ?? 0;
            }
        }
    };
    walk(root);
    return { present: true, files, bytes };
}
/**
 * Where `better-sqlite3` resolves from a given base directory.
 *
 * `require.resolve`'s `paths` option is the only way to ask "what would a module
 * living *here* load?"; a plain import from this module would always answer for
 * the plugin root and hide a nested duplicate.
 */
function resolveBetterSqlite3(paths) {
    const bases = [
        // The plugin root, when the wrapper / doctor CLI knows it…
        process.env.CLAUDE_PLUGIN_ROOT,
        process.env.PLUGIN_ROOT,
        // …then this module's own install (dist/), which is the plugin root's child…
        path.dirname(fileURLToPath(import.meta.url)),
        // …then the invocation directory.
        process.cwd(),
    ].filter((base) => typeof base === 'string' && base.length > 0);
    for (const base of bases) {
        try {
            const requireFrom = createRequire(path.join(base, 'package.json'));
            return requireFrom.resolve('better-sqlite3', { paths });
        }
        catch {
            // Try the next base.
        }
    }
    return null;
}
/** The installed directory of a package, from wherever this process resolves it. */
function resolveModuleDir(specifier) {
    const bases = [
        process.env.CLAUDE_PLUGIN_ROOT,
        process.env.PLUGIN_ROOT,
        path.dirname(fileURLToPath(import.meta.url)),
        process.cwd(),
    ].filter((base) => typeof base === 'string' && base.length > 0);
    for (const base of bases) {
        try {
            const requireFrom = createRequire(path.join(base, 'package.json'));
            return path.dirname(requireFrom.resolve(`${specifier}/package.json`));
        }
        catch {
            // Try the next base.
        }
    }
    return null;
}
function metricsSummary(metrics) {
    const parts = [];
    const train = metrics.train;
    const rate = (value) => {
        if (!value || typeof value !== 'object')
            return 'n/a';
        const cell = value;
        return `${Number(cell.passed ?? 0)}/${Number(cell.total ?? 0)}`;
    };
    if (train)
        parts.push(`train ${rate(train.before)} → ${rate(train.after)}`);
    if (metrics.test !== undefined)
        parts.push(`test ${rate(metrics.test)}`);
    if (metrics.kept !== undefined)
        parts.push(`${Number(metrics.kept)} kept`);
    if (metrics.rejected !== undefined)
        parts.push(`${Number(metrics.rejected)} rejected`);
    return parts.length > 0 ? parts.join(', ') : 'n/a';
}
/** Which exchange ids the index still knows. */
function knownExchangeIds(indexIds, ids) {
    return ids.every(id => indexIds.has(id));
}
/**
 * Collect the learn section.
 *
 * Never throws: every probe is wrapped, and a failure leaves that field at its
 * empty value. The caller decides whether `present` or a resolution mismatch is
 * a warning.
 */
export async function collectLearnDoctorSection() {
    // A plain join, not `getLearnedDir()`: that helper creates the directory, and
    // doctor is a read-only probe — running it must not bring `learned/` into
    // being (spec §7 rule 1: the databases appear on a flag-on write only).
    const learnedDir = path.join(getSuperpowersDir(), LEARNED_DIR_NAME);
    const section = emptyLearnSection(learnedDir);
    const knowledgeDb = path.join(learnedDir, 'knowledge.db');
    const learningDb = path.join(learnedDir, 'learning.sqlite');
    section.knowledgeDbSizeBytes = sizeOf(knowledgeDb);
    section.learningDbSizeBytes = sizeOf(learningDb);
    section.present = section.knowledgeDbSizeBytes !== null || section.learningDbSizeBytes !== null;
    section.exportTree = treeSize(path.join(getSuperpowersDir(), LEARNED_SKILLS_DIR));
    // A nested better-sqlite3 under memoryjs loads a second, possibly binding-less
    // copy. The `overrides` pin exists to make these two paths identical.
    const memoryjsDir = resolveModuleDir('@danielsimonjr/memoryjs');
    section.betterSqlite3TopLevel = resolveBetterSqlite3([process.cwd()]);
    section.betterSqlite3FromMemoryjs =
        memoryjsDir === null ? section.betterSqlite3TopLevel : resolveBetterSqlite3([memoryjsDir]);
    section.betterSqlite3Shared =
        section.betterSqlite3TopLevel === null ||
            section.betterSqlite3FromMemoryjs === null ||
            section.betterSqlite3TopLevel === section.betterSqlite3FromMemoryjs;
    if (!section.present)
        return section;
    let openedStore = null;
    let learning = null;
    let index = null;
    try {
        const { openKnowledgeStore } = await import('./learn/knowledge-store.js');
        openedStore = openKnowledgeStore({ dbPath: knowledgeDb });
        const entries = await openedStore.listByStatus(['candidate', 'active', 'retired']);
        for (const entry of entries) {
            section.entryCounts[entry.kind][entry.status] += 1;
            if (entry.status === 'candidate' && (entry.kind === 'skill' || entry.kind === 'instruction')) {
                section.candidatesAwaitingApproval += 1;
            }
        }
        // A candidate's cited exchanges must still exist for it to be approvable;
        // an entry whose whole citation set is gone is the "unresolved sources" item.
        const ids = new Set();
        for (const entry of entries) {
            for (const match of entry.body.matchAll(/#([0-9a-f]{32})/g))
                ids.add(match[1]);
        }
        if (ids.size > 0) {
            const known = new Set();
            try {
                const { getDbPath } = await import('./paths.js');
                const dbPath = getDbPath();
                if (fs.existsSync(dbPath)) {
                    // Opened only when it already exists: doctor reads, it never creates.
                    const { initDatabase } = await import('./db.js');
                    index = initDatabase();
                    const statement = index.prepare('SELECT id FROM exchanges WHERE id = ?');
                    for (const id of ids) {
                        if (statement.get(id))
                            known.add(id);
                    }
                }
            }
            catch {
                // An unreadable index leaves every id unknown, which is what it is.
            }
            // With no index at all every citation is unresolved — the honest reading,
            // and the same warning the missing-database issue already points at.
            for (const entry of entries) {
                const cited = [...entry.body.matchAll(/#([0-9a-f]{32})/g)].map(match => match[1]);
                if (cited.length === 0)
                    continue;
                if (!knownExchangeIds(known, cited)) {
                    section.unresolvedSources.push({
                        id: entry.id,
                        kind: entry.kind,
                        sources: cited.filter(id => !known.has(id)).length,
                    });
                }
            }
        }
    }
    catch {
        // A store that cannot open is a broken `learned/`, not a broken doctor.
    }
    finally {
        try {
            openedStore?.close();
        }
        catch {
            // best effort
        }
        try {
            index?.close();
        }
        catch {
            // best effort
        }
    }
    section.unresolvedSources.sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
    // The trace is plain sqlite, read-only and un-migrated: doctor never changes it.
    try {
        const Database = (await import('better-sqlite3')).default;
        learning = new Database(learningDb, { readonly: true });
        const row = learning
            .prepare('SELECT id, phase, status, metrics FROM learning_run ORDER BY started_at DESC, rowid DESC LIMIT 1')
            .get();
        if (row) {
            let metrics = {};
            try {
                metrics = JSON.parse(row.metrics);
            }
            catch {
                metrics = {};
            }
            section.latestRun = {
                id: row.id,
                phase: row.phase,
                status: row.status,
                metrics: metricsSummary(metrics),
            };
        }
    }
    catch {
        // No trace database yet, or an older schema: nothing to report.
    }
    finally {
        try {
            learning?.close();
        }
        catch {
            // best effort
        }
    }
    return section;
}
