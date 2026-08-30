import Database from 'better-sqlite3';
import { initDatabase, getSharedReaderDatabase } from './db.js';
import { initEmbeddings, generateQueryEmbedding } from './embeddings.js';
import { SearchResult, ConversationExchange, MultiConceptResult } from './types.js';
import { maybeRedactSecrets } from './redact.js';
import { safeArchiveSummaryPath } from './archive-path.js';
import fs from 'fs';

export interface SearchOptions {
  limit?: number;
  mode?: 'vector' | 'text' | 'both';
  after?: string;  // ISO date string
  before?: string; // ISO date string
  project?: string;     // exact match against e.project
  session_id?: string;  // exact match against e.session_id
  git_branch?: string;  // exact match against e.git_branch
  /**
   * Reuse an open DB handle (MCP hot path). When omitted, opens and closes
   * a one-shot connection (CLI behavior).
   */
  db?: Database.Database;
  /** When true with no `db`, use the process-wide shared reader. */
  useSharedReader?: boolean;
}

/**
 * Build the AND-clause and bound-parameter list that constrains a search
 * by the optional time and metadata filters. Bound parameters keep us
 * safe from SQL injection without regex-based input scrubbing.
 */
function buildSearchFilters(options: SearchOptions): { sql: string; params: unknown[] } {
  const parts: string[] = [];
  const params: unknown[] = [];
  if (options.after) {
    parts.push('e.timestamp >= ?');
    params.push(options.after);
  }
  if (options.before) {
    parts.push('e.timestamp <= ?');
    params.push(options.before);
  }
  if (options.project) {
    parts.push('e.project = ?');
    params.push(options.project);
  }
  if (options.session_id) {
    parts.push('e.session_id = ?');
    params.push(options.session_id);
  }
  if (options.git_branch) {
    parts.push('e.git_branch = ?');
    params.push(options.git_branch);
  }
  return {
    sql: parts.length ? `AND ${parts.join(' AND ')}` : '',
    params,
  };
}

function hasMetadataFilters(options: SearchOptions): boolean {
  return Boolean(options.project || options.session_id || options.git_branch);
}

const EXCHANGE_SELECT_COLUMNS = `
        e.id,
        e.project,
        e.timestamp,
        e.user_message,
        e.assistant_message,
        e.archive_path,
        e.line_start,
        e.line_end,
        e.parent_uuid,
        e.is_sidechain,
        e.harness,
        e.session_id,
        e.cwd,
        e.git_branch,
        e.claude_version,
        e.agent_version,
        e.model,
        e.model_provider,
        e.thinking_level,
        e.thinking_disabled,
        e.thinking_triggers`;

function exchangeFromRow(row: any): ConversationExchange {
  return {
    id: row.id,
    project: row.project,
    timestamp: row.timestamp,
    userMessage: maybeRedactSecrets(row.user_message),
    assistantMessage: maybeRedactSecrets(row.assistant_message),
    archivePath: row.archive_path,
    lineStart: row.line_start,
    lineEnd: row.line_end,
    parentUuid: row.parent_uuid || undefined,
    isSidechain: Boolean(row.is_sidechain),
    harness: row.harness,
    sessionId: row.session_id || undefined,
    cwd: row.cwd || undefined,
    gitBranch: row.git_branch || undefined,
    claudeVersion: row.claude_version || undefined,
    agentVersion: row.agent_version || undefined,
    model: row.model || undefined,
    modelProvider: row.model_provider || undefined,
    thinkingLevel: row.thinking_level || undefined,
    thinkingDisabled: row.thinking_disabled === null ? undefined : Boolean(row.thinking_disabled),
    thinkingTriggers: row.thinking_triggers || undefined,
  };
}

/**
 * Convert an L2 (Euclidean) distance between two unit-normalized vectors
 * into a cosine similarity in [-1, 1].
 *
 * For unit vectors u, v:  ||u - v||^2 = 2 - 2 * cos(u, v)
 * Therefore:               cos(u, v) = 1 - d^2 / 2
 *
 * Embeddings written by src/embeddings.ts are normalized at write time, so
 * the L2 distance returned by sqlite-vec satisfies the unit-vector identity.
 */
export function l2DistanceToCosineSimilarity(distance: number): number {
  const similarity = 1 - (distance * distance) / 2;
  return Math.max(-1, Math.min(1, similarity));
}

function validateISODate(dateStr: string, paramName: string): void {
  const isoDateRegex = /^\d{4}-\d{2}-\d{2}$/;
  if (!isoDateRegex.test(dateStr)) {
    throw new Error(`Invalid ${paramName} date: "${dateStr}". Expected YYYY-MM-DD format (e.g., 2025-10-01)`);
  }
  // Verify it's actually a valid date
  const date = new Date(dateStr);
  if (isNaN(date.getTime())) {
    throw new Error(`Invalid ${paramName} date: "${dateStr}". Not a valid calendar date.`);
  }
}

/**
 * Prepare an FTS5 MATCH query from user input.
 * Quote the whole string so punctuation / AND/OR tokens in the user query
 * don't become FTS operators; fall back to LIKE if FTS is unavailable.
 */
export function buildFtsMatchQuery(query: string): string {
  // Escape embedded double-quotes for FTS5 phrase syntax
  const escaped = query.replace(/"/g, '""');
  return `"${escaped}"`;
}

function resolveSearchDb(options: SearchOptions): {
  db: Database.Database;
  ownsConnection: boolean;
} {
  if (options.db) {
    return { db: options.db, ownsConnection: false };
  }
  if (options.useSharedReader) {
    return { db: getSharedReaderDatabase(), ownsConnection: false };
  }
  return { db: initDatabase(), ownsConnection: true };
}

export async function searchConversations(
  query: string,
  options: SearchOptions = {}
): Promise<SearchResult[]> {
  const { limit = 10, mode = 'both', after, before } = options;

  // Validate date parameters
  if (after) validateISODate(after, '--after');
  if (before) validateISODate(before, '--before');

  const { db, ownsConnection } = resolveSearchDb(options);

  let results: any[] = [];

  try {
    const { sql: filterClause, params: filterParams } = buildSearchFilters(options);

    if (mode === 'vector' || mode === 'both') {
      // Vector similarity search.
      // vec0 applies KNN before WHERE, so when extra metadata filters are
      // active we ask for more candidates than `limit` and trim afterwards.
      await initEmbeddings();
      const queryEmbedding = await generateQueryEmbedding(query);
      const k = hasMetadataFilters(options) ? limit * 3 : limit;

      const stmt = db.prepare(`
        SELECT
          ${EXCHANGE_SELECT_COLUMNS},
          vec.distance
        FROM vec_exchanges AS vec
        JOIN exchanges AS e ON vec.id = e.id
        WHERE vec.embedding MATCH ?
          AND k = ?
          AND e.is_sidechain = 0
          ${filterClause}
        ORDER BY vec.distance ASC
      `);

      results = stmt.all(
        Buffer.from(new Float32Array(queryEmbedding).buffer),
        k,
        ...filterParams
      );
      if (results.length > limit) {
        results = results.slice(0, limit);
      }
    }

    if (mode === 'text' || mode === 'both') {
      let textResults: any[] = [];
      try {
        // Prefer FTS5 for text mode (scales past LIKE '%…%' full scans).
        const ftsStmt = db.prepare(`
          SELECT
            ${EXCHANGE_SELECT_COLUMNS},
            0 as distance
          FROM exchanges_fts
          JOIN exchanges AS e ON e.id = exchanges_fts.id
          WHERE exchanges_fts MATCH ?
            AND e.is_sidechain = 0
            ${filterClause}
          ORDER BY e.timestamp DESC
          LIMIT ?
        `);
        textResults = ftsStmt.all(buildFtsMatchQuery(query), ...filterParams, limit);
      } catch {
        // FTS missing or MATCH syntax edge-case: fall back to LIKE.
        const textStmt = db.prepare(`
          SELECT
            ${EXCHANGE_SELECT_COLUMNS},
            0 as distance
          FROM exchanges AS e
          WHERE (e.user_message LIKE ? OR e.assistant_message LIKE ?)
            AND e.is_sidechain = 0
            ${filterClause}
          ORDER BY e.timestamp DESC
          LIMIT ?
        `);
        textResults = textStmt.all(`%${query}%`, `%${query}%`, ...filterParams, limit);
      }

      if (mode === 'both') {
        // Merge and deduplicate by ID
        const seenIds = new Set(results.map(r => r.id));
        for (const textResult of textResults) {
          if (!seenIds.has((textResult as any).id)) {
            results.push(textResult);
          }
        }
      } else {
        results = textResults;
      }
    }
  } finally {
    if (ownsConnection) {
      db.close();
    }
  }

  return results.map((row: any) => {
    const exchange = exchangeFromRow(row);

    // Try to load summary if available (confined to archive like MCP read)
    let summary: string | undefined;
    const summaryPath = safeArchiveSummaryPath(row.archive_path);
    if (summaryPath) {
      summary = maybeRedactSecrets(fs.readFileSync(summaryPath, 'utf-8').trim());
    }

    // Create snippet (first 200 chars, collapse newlines)
    const snippetText = exchange.userMessage.substring(0, 200).replace(/\s+/g, ' ').trim();
    const snippet = snippetText + (exchange.userMessage.length > 200 ? '...' : '');

    return {
      exchange,
      similarity: mode === 'text' ? undefined : l2DistanceToCosineSimilarity(row.distance),
      snippet,
      summary
    } as SearchResult & { summary?: string };
  });
}

// Helper function to get file size in KB
function getFileSizeInKB(filePath: string): number {
  try {
    const stats = fs.statSync(filePath);
    return Math.round(stats.size / 1024 * 10) / 10; // Round to 1 decimal place
  } catch (error) {
    return 0;
  }
}

export async function formatResults(results: Array<SearchResult & { summary?: string }>): Promise<string> {
  if (results.length === 0) {
    return 'No results found.';
  }

  let output = `Found ${results.length} relevant conversation${results.length > 1 ? 's' : ''}:\n\n`;

  for (let index = 0; index < results.length; index++) {
    const result = results[index];
    const date = new Date(result.exchange.timestamp).toISOString().split('T')[0];
    const simPct = result.similarity !== undefined ? Math.round(result.similarity * 100) : null;

    // Header with match percentage
    output += `${index + 1}. [${result.exchange.project}, ${date}]`;
    if (simPct !== null) {
      output += ` - ${simPct}% match`;
    }
    output += '\n';

    // Show summary only if it's concise (< 300 chars)
    if (result.summary && result.summary.length < 300) {
      output += `   ${result.summary}\n`;
    }

    // Show snippet
    output += `   "${result.snippet}"\n`;

    // Show tool usage if available
    if (result.exchange.toolCalls && result.exchange.toolCalls.length > 0) {
      const toolCounts = new Map<string, number>();
      result.exchange.toolCalls.forEach(tc => {
        toolCounts.set(tc.toolName, (toolCounts.get(tc.toolName) || 0) + 1);
      });
      const toolSummary = Array.from(toolCounts.entries())
        .map(([name, count]) => `${name}(${count})`)
        .join(', ');
      output += `   Tools: ${toolSummary}\n`;
    }

    // File metadata: use line_end as a lower bound on length (avoids full-file scans)
    const fileSizeKB = getFileSizeInKB(result.exchange.archivePath);
    const lineRange = `${result.exchange.lineStart}-${result.exchange.lineEnd}`;
    const minLines = result.exchange.lineEnd;

    output += `   Lines ${lineRange} in ${result.exchange.archivePath} (${fileSizeKB}KB, ≥${minLines} lines)\n\n`;
  }

  return output;
}

export async function searchMultipleConcepts(
  concepts: string[],
  options: Omit<SearchOptions, 'mode'> = {}
): Promise<MultiConceptResult[]> {
  const { limit = 10 } = options;

  if (concepts.length === 0) {
    return [];
  }

  // Search for each concept independently (share DB when provided)
  const conceptResults = await Promise.all(
    concepts.map(concept =>
      searchConversations(concept, { ...options, limit: limit * 5, mode: 'vector' })
    )
  );

  // Build map of conversation path -> array of results (one per concept)
  const conversationMap = new Map<string, Array<SearchResult & { conceptIndex: number }>>();

  conceptResults.forEach((results, conceptIndex) => {
    results.forEach(result => {
      const key = result.exchange.archivePath;
      if (!conversationMap.has(key)) {
        conversationMap.set(key, []);
      }
      conversationMap.get(key)!.push({ ...result, conceptIndex });
    });
  });

  // Find conversations that match ALL concepts
  const multiConceptResults: MultiConceptResult[] = [];

  for (const [archivePath, results] of conversationMap.entries()) {
    // Check if all concepts are represented
    const representedConcepts = new Set(results.map(r => r.conceptIndex));
    if (representedConcepts.size === concepts.length) {
      // All concepts found in this conversation
      const conceptSimilarities = concepts.map((_concept, index) => {
        const result = results.find(r => r.conceptIndex === index);
        return result?.similarity || 0;
      });

      const averageSimilarity = conceptSimilarities.reduce((sum, sim) => sum + sim, 0) / conceptSimilarities.length;

      // Use the first result's exchange data (they're all from the same conversation)
      const firstResult = results[0];

      multiConceptResults.push({
        exchange: firstResult.exchange,
        snippet: firstResult.snippet,
        conceptSimilarities,
        averageSimilarity
      });
    }
  }

  // Sort by average similarity (highest first)
  multiConceptResults.sort((a, b) => b.averageSimilarity - a.averageSimilarity);

  // Apply limit
  return multiConceptResults.slice(0, limit);
}

export async function formatMultiConceptResults(
  results: MultiConceptResult[],
  concepts: string[]
): Promise<string> {
  if (results.length === 0) {
    return `No conversations found matching all concepts: ${concepts.join(', ')}`;
  }

  let output = `Found ${results.length} conversation${results.length > 1 ? 's' : ''} matching all concepts [${concepts.join(' + ')}]:\n\n`;

  for (let index = 0; index < results.length; index++) {
    const result = results[index];
    const date = new Date(result.exchange.timestamp).toISOString().split('T')[0];
    const avgPct = Math.round(result.averageSimilarity * 100);

    // Header with average match percentage
    output += `${index + 1}. [${result.exchange.project}, ${date}] - ${avgPct}% avg match\n`;

    // Show individual concept scores
    const scores = result.conceptSimilarities
      .map((sim, i) => `${concepts[i]}: ${Math.round(sim * 100)}%`)
      .join(', ');
    output += `   Concepts: ${scores}\n`;

    // Show snippet
    output += `   "${result.snippet}"\n`;

    // Show tool usage if available
    if (result.exchange.toolCalls && result.exchange.toolCalls.length > 0) {
      const toolCounts = new Map<string, number>();
      result.exchange.toolCalls.forEach(tc => {
        toolCounts.set(tc.toolName, (toolCounts.get(tc.toolName) || 0) + 1);
      });
      const toolSummary = Array.from(toolCounts.entries())
        .map(([name, count]) => `${name}(${count})`)
        .join(', ');
      output += `   Tools: ${toolSummary}\n`;
    }

    const fileSizeKB = getFileSizeInKB(result.exchange.archivePath);
    const lineRange = `${result.exchange.lineStart}-${result.exchange.lineEnd}`;
    const minLines = result.exchange.lineEnd;

    output += `   Lines ${lineRange} in ${result.exchange.archivePath} (${fileSizeKB}KB, ≥${minLines} lines)\n\n`;
  }

  return output;
}
