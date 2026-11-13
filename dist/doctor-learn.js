/**
 * The `learn` section of `episodic-memory doctor`.
 *
 * Kept apart from `doctor.ts` because collecting it needs a read-only peek at
 * the learning trace and the knowledge store, while `doctor.ts` stays importable
 * from a context with neither. `collectLearnDoctorSection()` is best-effort
 * throughout: a missing or half-written `learned/` is something to *report*,
 * never a reason for doctor itself to fail.
 */
import fs from 'fs';
import path from 'path';
import { getSuperpowersDir } from './paths.js';
const LEARNED_SKILLS_DIR = 'learned-skills';
const LEARNED_DIR_NAME = 'learned';
function emptyCounts() {
    return { candidate: 0, active: 0, retired: 0 };
}
/**
 * Returns a section that reports nothing found. The `learnedDir` field contains the given path.
 *
 * `collectLearnDoctorSection` starts from this section and fills in each value that the function finds.
 *
 * @param learnedDir The `learned` directory to report. Empty when `collectLearnDoctorSection` finds no value.
 */
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
        sqliteVersion: null,
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
 * The SQLite version that node:sqlite reports, read from an in-memory database.
 *
 * Returns null when the probe fails. The connection closes in every case.
 */
async function readSqliteVersion() {
    let db = null;
    try {
        const sqlite = await import('./sqlite.js');
        db = new sqlite.Database(':memory:');
        const row = db.prepare('SELECT sqlite_version() AS v').get();
        return row?.v ?? null;
    }
    catch {
        return null;
    }
    finally {
        try {
            db?.close();
        }
        catch {
            // best effort
        }
    }
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
    section.sqliteVersion = await readSqliteVersion();
    if (!section.present)
        return section;
    let openedStore = null;
    let learning = null;
    let index = null;
    try {
        // `openKnowledgeStore` creates `learned/` and `knowledge.db`. Doctor must
        // not: a missing store is reported by the size fields above and skipped.
        if (fs.existsSync(knowledgeDb)) {
            const { openKnowledgeStore } = await import('./learn/knowledge-store.js');
            openedStore = openKnowledgeStore({ dbPath: knowledgeDb });
        }
        const entries = openedStore
            ? await openedStore.listByStatus(['candidate', 'active', 'retired'])
            : [];
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
                    // Read-only and unmigrated. `initDatabase()` would open a writer,
                    // run migrations, and (via `openDatabase`) create a missing file.
                    const Database = (await import('./sqlite.js')).Database;
                    index = new Database(dbPath, { readonly: true, fileMustExist: true });
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
        const Database = (await import('./sqlite.js')).Database;
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
