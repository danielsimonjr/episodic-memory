/**
 * The `skills` MCP tool: read active learned skills out of the knowledge store.
 *
 * The module holds the store-backed half of the tool on purpose.
 * `mcp-tools.ts` imports this module *inside* the `skills` branch. A server with the
 * flag off therefore never opens the knowledge store. A session that never asks for
 * a skill pays nothing for the feature.
 *
 * The tool opens a store for each call and closes it in `finally`. A long-running
 * server therefore holds no handle on `knowledge.db` between calls. The server does not block a `learn` run in
 * another process, and the next call sees a later `learn` run.
 */
import fs from 'fs';
import path from 'path';
import { redactSecrets } from '../redact.js';
import { getSuperpowersDir } from '../paths.js';
import { projectKeyFromCwd } from '../digest-inject.js';
import { LEARN_OFF_MESSAGE, learnEnabled } from './learn-config.js';
/**
 * The message that the skills tool returns when learning is off. learn-config.ts declares the constant, and this module re-exports it.
 */
export { LEARN_OFF_MESSAGE };
import { screenLearnedText } from './learned-text-screen.js';
import { redactKeepingMarks } from './learn-inject.js';
import { openKnowledgeStore } from './knowledge-store.js';
/** The text that the skills tool returns when the knowledge store file does not exist. */
export const NO_SKILLS_MESSAGE = 'No learned skills yet. Set EPISODIC_MEMORY_LEARN=1 and run the episodic-memory learn CLI to collect some.';
function listLine(entry, redact) {
    const line = redactKeepingMarks(`${entry.slug}: ${entry.description} (${entry.confidence}, v${entry.version})`, redact);
    if (screenLearnedText(line, { kind: 'skill', field: 'description' }).ok)
        return line;
    return null;
}
function sourcesText(entry) {
    if (entry.sources.length === 0)
        return 'none';
    return entry.sources
        .map(source => `${source.path}:${source.lineStart}-${source.lineEnd}`)
        .join('; ');
}
/**
 * One skill as frontmatter plus body.
 * The function redacts and screens every field. A field that the screen rejects withholds the whole
 * entry, rather than printing a skill with untrusted metadata or body.
 */
function renderSkill(entry, redact) {
    const fields = [
        ['description', entry.description],
        ['scope', entry.scope],
        ['sources', sourcesText(entry)],
    ];
    const rendered = [`name: ${entry.slug}`];
    for (const [name, value] of fields) {
        const line = redactKeepingMarks(`${name}: ${value}`, redact);
        if (!screenLearnedText(line, { kind: 'skill', field: name }).ok)
            return null;
        rendered.push(line);
    }
    rendered.push(`confidence: ${entry.confidence}`);
    rendered.push(`version: ${entry.version}`);
    const body = [];
    for (const raw of entry.body.split('\n')) {
        const trimmed = raw.trim();
        if (!trimmed)
            continue;
        const line = redactKeepingMarks(trimmed, redact);
        if (!screenLearnedText(line, { kind: 'skill', field: 'body' }).ok)
            continue;
        body.push(line);
    }
    if (body.length === 0 && entry.body.trim())
        return null;
    return `---\n${rendered.join('\n')}\n---\n\n${body.join('\n')}\n`;
}
/** Every active skill of a project (and the `*` ones), newest first by slug. */
async function activeSkills(store, project) {
    const entries = await store.listByStatus(['active']);
    return entries
        .filter(entry => entry.kind === 'skill' && entry.supersededBy === null)
        .filter(entry => entry.project === project || entry.project === '*')
        .sort((a, b) => {
        const aGlobal = a.project === '*' ? 1 : 0;
        const bGlobal = b.project === '*' ? 1 : 0;
        if (aGlobal !== bGlobal)
            return aGlobal - bGlobal;
        return a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0;
    });
}
/**
 * The tool's text. Opens nothing with the flag off.
 *
 * The store file check runs before construction. An `openKnowledgeStore()` call
 * would create `knowledge.db`, because a writable open creates its tables. A
 * read-only tool call must never create the learned directory.
 */
export async function skillsToolText(params) {
    if (!learnEnabled())
        return LEARN_OFF_MESSAGE;
    // A plain join, not `getKnowledgeDbPath()`: that helper creates `learned/`,
    // and a read-only tool call must not be what brings the directory into being.
    const dbPath = path.join(getSuperpowersDir(), 'learned', 'knowledge.db');
    if (!fs.existsSync(dbPath))
        return NO_SKILLS_MESSAGE;
    const project = params.project ?? projectKeyFromCwd(process.cwd());
    const limit = params.limit ?? 10;
    // Read-only: the tool never creates tables, migrates columns or writes a row.
    const store = openKnowledgeStore({ dbPath, readonly: true });
    try {
        const redact = text => store.redactPii(redactSecrets(text));
        if (params.get) {
            const all = await store.listByStatus(['active']);
            const match = all.find(entry => entry.kind === 'skill' &&
                entry.supersededBy === null &&
                entry.slug === params.get &&
                (entry.project === project || entry.project === '*'));
            if (!match)
                return `No learned skill "${params.get}".`;
            const rendered = renderSkill(match, redact);
            return rendered ?? `The learned skill "${params.get}" is withheld: it failed the safety screen.`;
        }
        if (params.query) {
            const hits = await store.search(params.query, { kinds: ['skill'], project, limit });
            if (hits.length === 0)
                return `No learned skills match "${params.query}".`;
            const lines = hits
                .map(entry => listLine(entry, redact))
                .filter((line) => line !== null);
            if (lines.length === 0)
                return `No learned skills match "${params.query}".`;
            return `${lines.join('\n')}\n\nLoad one with the skills tool by passing get: <slug>.`;
        }
        const skills = await activeSkills(store, project);
        if (skills.length === 0)
            return `No learned skills for ${project}.`;
        const lines = skills
            .map(entry => listLine(entry, redact))
            .filter((line) => line !== null)
            .slice(0, limit);
        if (lines.length === 0)
            return `No learned skills for ${project}.`;
        return `${lines.join('\n')}\n\nLoad one with the skills tool by passing get: <slug>.`;
    }
    finally {
        store.close();
    }
}
