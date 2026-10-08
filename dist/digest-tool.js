import { initDatabase } from './db.js';
import { insertDigestEntry, searchDigest } from './digest-db.js';
import { buildDigestText, digestMaxChars, projectKeyFromCwd } from './digest-inject.js';
import { redactEntryText } from './digest-validate.js';
const HANDOFF_MAX_CHARS = 500;
/** One-line, redacted, capped note text. */
export function normalizeHandoff(note) {
    const oneLine = redactEntryText(note).replace(/\s+/g, ' ').trim();
    return oneLine.length > HANDOFF_MAX_CHARS ? `${oneLine.slice(0, HANDOFF_MAX_CHARS - 3)}...` : oneLine;
}
/** Behavior of the `digest` MCP tool. Exactly one of expand, handoff, query, or the default view runs. */
export function digestToolText(params) {
    const db = initDatabase();
    try {
        const project = params.project ?? projectKeyFromCwd(process.cwd());
        if (params.expand) {
            const row = db
                .prepare('SELECT archive_path, line_start, line_end, project, timestamp FROM exchanges WHERE id = ?')
                .get(params.expand);
            if (!row)
                throw new Error(`No exchange with id ${params.expand}`);
            return `Exchange ${params.expand} (${row.project}, ${row.timestamp})\npath: ${row.archive_path}\nstartLine: ${row.line_start}\nendLine: ${row.line_end}\nPass path, startLine and endLine to the read tool.`;
        }
        if (params.handoff) {
            const note = normalizeHandoff(params.handoff);
            if (!note)
                throw new Error('The handoff note is empty after redaction');
            const now = new Date().toISOString();
            const id = insertDigestEntry(db, {
                tier: 'session',
                project,
                periodStart: now,
                periodEnd: now,
                text: note,
                sources: [],
                model: 'handoff',
                handoff: true,
            });
            return id === null ? 'A note with the same timestamp already exists; try again.' : `Handoff note saved for ${project}.`;
        }
        if (params.query) {
            const hits = searchDigest(db, params.query, params.project, params.limit ?? 10);
            if (hits.length === 0)
                return `No digest entries match "${params.query}".`;
            return hits.map(h => `## ${h.tier} ${h.periodStart.slice(0, 10)} (${h.project})\n${h.text}`).join('\n\n');
        }
        const text = buildDigestText(db, project, digestMaxChars());
        return text || `No digest entries for ${project}.`;
    }
    finally {
        db.close();
    }
}
