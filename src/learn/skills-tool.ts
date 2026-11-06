/**
 * The `skills` MCP tool: read active learned skills out of the knowledge store.
 *
 * This module holds the store-backed half of the tool on purpose.
 * `mcp-tools.ts` imports it *inside* the `skills` branch, so a server with the
 * flag off never opens the knowledge store — a session that never asks for a
 * skill pays nothing for the feature.
 *
 * It opens a store per call and closes it in `finally`, so a long-running
 * server never holds a handle on `knowledge.db` between calls and a `learn`
 * run in another process is never blocked by a server that
 * started and a `learn` run later in the session would be invisible.
 */

import fs from 'fs';
import path from 'path';
import { redactSecrets } from '../redact.js';
import { getSuperpowersDir } from '../paths.js';
import { projectKeyFromCwd } from '../digest-inject.js';
import { LEARN_OFF_MESSAGE, learnEnabled } from './learn-config.js';

export { LEARN_OFF_MESSAGE };
import { screenLearnedText } from './learned-text-screen.js';
import { redactKeepingMarks, type RedactFn } from './learn-inject.js';
import { openKnowledgeStore, type KnowledgeStore } from './knowledge-store.js';
import type { KnowledgeEntry } from './types.js';

export const NO_SKILLS_MESSAGE =
  'No learned skills yet. Set EPISODIC_MEMORY_LEARN=1 and run the episodic-memory learn CLI to collect some.';

export interface SkillsToolParams {
  get?: string;
  query?: string;
  project?: string;
  limit?: number;
}

function listLine(entry: KnowledgeEntry, redact: RedactFn): string | null {
  const line = redactKeepingMarks(
    `${entry.slug}: ${entry.description} (${entry.confidence}, v${entry.version})`,
    redact
  );
  if (screenLearnedText(line, { kind: 'skill', field: 'description' }).ok) return line;
  return null;
}

function sourcesText(entry: KnowledgeEntry): string {
  if (entry.sources.length === 0) return 'none';
  return entry.sources
    .map(source => `${source.path}:${source.lineStart}-${source.lineEnd}`)
    .join('; ');
}

/**
 * One skill as frontmatter plus body. Every field is redacted and screened;
 * a field the screen rejects withholds the whole entry rather than printing a
 * skill whose metadata or body cannot be trusted.
 */
function renderSkill(entry: KnowledgeEntry, redact: RedactFn): string | null {
  const fields: Array<[string, string]> = [
    ['description', entry.description],
    ['scope', entry.scope],
    ['sources', sourcesText(entry)],
  ];

  const rendered: string[] = [`name: ${entry.slug}`];
  for (const [name, value] of fields) {
    const line = redactKeepingMarks(`${name}: ${value}`, redact);
    if (!screenLearnedText(line, { kind: 'skill', field: name }).ok) return null;
    rendered.push(line);
  }
  rendered.push(`confidence: ${entry.confidence}`);
  rendered.push(`version: ${entry.version}`);

  const body: string[] = [];
  for (const raw of entry.body.split('\n')) {
    const trimmed = raw.trim();
    if (!trimmed) continue;
    const line = redactKeepingMarks(trimmed, redact);
    if (!screenLearnedText(line, { kind: 'skill', field: 'body' }).ok) continue;
    body.push(line);
  }
  if (body.length === 0 && entry.body.trim()) return null;

  return `---\n${rendered.join('\n')}\n---\n\n${body.join('\n')}\n`;
}

/** Every active skill of a project (and the `*` ones), newest first by slug. */
async function activeSkills(store: KnowledgeStore, project: string): Promise<KnowledgeEntry[]> {
  const entries = await store.listByStatus(['active']);
  return entries
    .filter(entry => entry.kind === 'skill' && entry.supersededBy === null)
    .filter(entry => entry.project === project || entry.project === '*')
    .sort((a, b) => {
      const aGlobal = a.project === '*' ? 1 : 0;
      const bGlobal = b.project === '*' ? 1 : 0;
      if (aGlobal !== bGlobal) return aGlobal - bGlobal;
      return a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0;
    });
}

/**
 * The tool's text. Opens nothing with the flag off.
 *
 * The store file check comes before construction: an `openKnowledgeStore()`
 * would create `knowledge.db` (the store creates its tables on open), and a read-only tool
 * call must never be what creates the learned directory.
 */
export async function skillsToolText(params: SkillsToolParams): Promise<string> {
  if (!learnEnabled()) return LEARN_OFF_MESSAGE;

  // A plain join, not `getKnowledgeDbPath()`: that helper creates `learned/`,
  // and a read-only tool call must not be what brings the directory into being.
  const dbPath = path.join(getSuperpowersDir(), 'learned', 'knowledge.db');
  if (!fs.existsSync(dbPath)) return NO_SKILLS_MESSAGE;

  const project = params.project ?? projectKeyFromCwd(process.cwd());
  const limit = params.limit ?? 10;

  const store = openKnowledgeStore({ dbPath });
  try {
    const redact: RedactFn = text => store.redactPii(redactSecrets(text));

    if (params.get) {
      const all = await store.listByStatus(['active']);
      const match = all.find(
        entry =>
          entry.kind === 'skill' &&
          entry.supersededBy === null &&
          entry.slug === params.get &&
          (entry.project === project || entry.project === '*')
      );
      if (!match) return `No learned skill "${params.get}".`;
      const rendered = renderSkill(match, redact);
      return rendered ?? `The learned skill "${params.get}" is withheld: it failed the safety screen.`;
    }

    if (params.query) {
      const hits = await store.search(params.query, { kinds: ['skill'], project, limit });
      if (hits.length === 0) return `No learned skills match "${params.query}".`;
      const lines = hits
        .map(entry => listLine(entry, redact))
        .filter((line): line is string => line !== null);
      if (lines.length === 0) return `No learned skills match "${params.query}".`;
      return `${lines.join('\n')}\n\nLoad one with the skills tool by passing get: <slug>.`;
    }

    const skills = await activeSkills(store, project);
    if (skills.length === 0) return `No learned skills for ${project}.`;
    const lines = skills
      .map(entry => listLine(entry, redact))
      .filter((line): line is string => line !== null)
      .slice(0, limit);
    if (lines.length === 0) return `No learned skills for ${project}.`;
    return `${lines.join('\n')}\n\nLoad one with the skills tool by passing get: <slug>.`;
  } finally {
    store.close();
  }
}
