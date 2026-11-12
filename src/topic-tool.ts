/**
 * The `topics` MCP tool: read the topic memory documents of a project.
 *
 * The module holds the read-only half of the tool. `mcp-tools.ts` imports this module
 * inside the `topics` branch, so a session that never calls the tool loads nothing of
 * the feature. The module imports no writer, no summarizer and no model client.
 *
 * The tool never writes. It opens the index the way the `digest` tool does, and it
 * answers that topic memory has no documents yet when the topic tables do not exist.
 * It does not check the topic flag: the MCP server never sees that variable.
 */

import { initDatabase } from './db.js';
import {
  listTopicDocs,
  readTopicDoc,
  searchTopicUnits,
  topicLinks,
  topicTimeline,
  type TopicLinkedUnit,
} from './topic-db.js';
import { projectKeyFromCwd } from './digest-inject.js';
import { redactEntryText } from './digest-validate.js';
import type { TopicsInput } from './mcp-schemas.js';

/** The text that the tool returns when the topic tables do not exist. */
export const NO_TOPICS_MESSAGE = 'Topic memory has no documents yet.';

/** The default number of search hits. */
const SEARCH_DEFAULT_LIMIT = 10;

/** The topic tables that the read functions use. The tool answers the no-documents text unless all of them exist. */
const READ_TABLES = ['topic_doc', 'topic_unit', 'topic_link', 'topic_event', 'topic_unit_fts'];

/** The open index handle. */
type IndexDb = ReturnType<typeof initDatabase>;

/** True when every topic table that the read functions use exists. Reads the schema only. */
function topicTablesExist(db: IndexDb): boolean {
  const placeholders = READ_TABLES.map(() => '?').join(', ');
  const rows = db
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name IN (${placeholders})`)
    .all(...READ_TABLES) as { name: string }[];
  return rows.length === READ_TABLES.length;
}

/** One line of text: every run of whitespace becomes one space. */
function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function linkedLine(unit: TopicLinkedUnit): string {
  return `- ${unit.slug} | ${unit.heading} | unit ${unit.unitId} | ${oneLine(unit.text)}`;
}

function listText(db: IndexDb, project: string): string {
  const docs = listTopicDocs(db, project);
  if (docs.length === 0) return `No topic documents for ${project}.`;
  return docs.map(doc => `- ${doc.slug}: ${doc.title} (${doc.unitCount} units)`).join('\n');
}

function readText(db: IndexDb, project: string, slug: string): string {
  const doc = readTopicDoc(db, project, slug);
  return doc ? doc.text : `No topic document "${slug}" in ${project}.`;
}

function searchText(
  db: IndexDb,
  project: string,
  query: string,
  range: { from?: string; to?: string },
  limit: number
): string {
  const hits = searchTopicUnits(db, query, { project, ...range, limit });
  if (hits.length === 0) return `No topic units match "${query}".`;
  return hits
    .map(hit => {
      const times = hit.times.length > 0 ? hit.times.join(', ') : 'none';
      return `- ${hit.slug} | ${hit.heading} | unit ${hit.unitId} | ${oneLine(hit.text)} | times: ${times}`;
    })
    .join('\n');
}

function linksText(db: IndexDb, project: string, unit: string): string {
  const { outgoing, backlinks } = topicLinks(db, project, unit);
  const section = (title: string, units: TopicLinkedUnit[]): string[] => [
    `${title} of ${unit}:`,
    ...(units.length > 0 ? units.map(linkedLine) : ['- none']),
  ];
  return [...section('Outgoing links', outgoing), ...section('Backlinks', backlinks)].join('\n');
}

function timelineText(db: IndexDb, project: string, range: { from?: string; to?: string }): string {
  const events = topicTimeline(db, project, range);
  if (events.length === 0) return `No timeline events for ${project}.`;
  return events
    .map(event => {
      const sources = event.sources.length > 0 ? event.sources.map(id => `#${id}`).join(', ') : 'none';
      return `- ${event.time} | ${oneLine(event.statement)} | unit ${event.unitId} | sources: ${sources}`;
    })
    .join('\n');
}

/**
 * Behavior of the `topics` MCP tool. Runs one action on the project, and returns redacted text.
 *
 * `project` defaults to the key for the working directory. The index opens once for the call
 * and closes in `finally`.
 */
export function topicsToolText(params: TopicsInput): string {
  const db = initDatabase();
  try {
    if (!topicTablesExist(db)) return NO_TOPICS_MESSAGE;

    const project = params.project ?? projectKeyFromCwd(process.cwd());
    const range = { from: params.from, to: params.to };

    let text: string;
    switch (params.action) {
      case 'list':
        text = listText(db, project);
        break;
      case 'read':
        text = readText(db, project, params.slug ?? '');
        break;
      case 'search':
        text = searchText(db, project, params.query ?? '', range, params.limit ?? SEARCH_DEFAULT_LIMIT);
        break;
      case 'links':
        text = linksText(db, project, params.unit ?? '');
        break;
      case 'timeline':
        text = timelineText(db, project, range);
        break;
    }
    return redactEntryText(text);
  } finally {
    db.close();
  }
}
