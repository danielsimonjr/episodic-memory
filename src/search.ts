import { Database } from './sqlite.js';
import { initDatabase, getSharedReaderDatabase } from './db.js';
import { initEmbeddings, generateQueryEmbedding, EmbeddingsUnavailableError } from './embeddings.js';
import { SearchResult, ConversationExchange, MultiConceptResult } from './types.js';
import { maybeRedactSecrets } from './redact.js';
import { safeArchiveSummaryPath } from './archive-path.js';
import { toFtsQuery } from './fts-query.js';
import fs from 'fs';

const FALSY = new Set(['0', 'false', 'no', 'off']);

/** Default on. Set EPISODIC_MEMORY_INCLUDE_SUMMARY=0 to hide summaries. */
export function includeSearchSummaries(): boolean {
  const raw = process.env.EPISODIC_MEMORY_INCLUDE_SUMMARY;
  if (raw === undefined) return true;
  const normalized = raw.trim().toLowerCase();
  if (FALSY.has(normalized)) return false;
  return true;
}

/** The env default, unless a caller set the option explicitly. */
function summariesVisible(options: SearchOptions): boolean {
  return options.includeSummaries ?? includeSearchSummaries();
}

/**
 * Returns the longest summary, in characters, that the results display.
 *
 * The function reads `EPISODIC_MEMORY_MAX_SUMMARY_DISPLAY_CHARS`. The function returns 2000 when the variable is unset or does not start with a positive integer.
 */
export function maxSummaryDisplayChars(): number {
  const raw = process.env.EPISODIC_MEMORY_MAX_SUMMARY_DISPLAY_CHARS;
  if (raw === undefined) return 2000;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 2000;
}

/**
 * Cuts a summary to the display limit from `maxSummaryDisplayChars`.
 *
 * A summary within the limit comes back unchanged. The function cuts a longer summary at the limit. An ellipsis character follows the cut text.
 */
export function formatSummaryForDisplay(summary: string): string {
  const cap = maxSummaryDisplayChars();
  if (summary.length <= cap) return summary;
  return summary.slice(0, cap) + '…';
}

/**
 * The options for `searchConversations`. Every field is optional.
 */
export interface SearchOptions {
  limit?: number;
  mode?: 'vector' | 'text' | 'both';
  after?: string;  // ISO date string
  before?: string; // ISO date string
  project?: string;     // exact match against e.project
  session_id?: string;  // exact match against e.session_id
  git_branch?: string;  // exact match against e.git_branch
  /**
   * Exchange ids to leave out of the result set entirely.
   *
   * The learn solver passes a task's source exchange ids here so neither the
   * vector nor the text path can hand back the answer it is looking for
   * (spec §4.4 leak rule).
   */
  excludeIds?: string[];
  /**
   * Show per-file summaries on the results.
   *
   * Overrides `EPISODIC_MEMORY_INCLUDE_SUMMARY` when set: the solver's search
   * turns summaries off even on an install that has them on by default.
   */
  includeSummaries?: boolean;
  /**
   * Reuse an open DB handle (MCP hot path). When omitted, opens and closes
   * a one-shot connection (CLI behavior).
   */
  db?: Database;
  /**
   * Receive a notice about a search step that did not run.
   *
   * A `both` search calls this function when the embedding backend cannot load. The results then come from the text step only.
   * Without this function, the search writes the notice to stderr.
   */
  onNotice?: (message: string) => void;
  /** When true with no `db`, use the process-wide shared reader. */
  useSharedReader?: boolean;
}

/**
 * Build the AND-clause and bound-parameter list that constrains a search by the optional time and metadata filters.
 * Bound parameters keep us
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
  // Bound placeholders, one per id, so an id can never be read as SQL.
  const excluded = (options.excludeIds ?? []).filter(id => typeof id === 'string' && id.length > 0);
  if (excluded.length > 0) {
    parts.push(`e.id NOT IN (${excluded.map(() => '?').join(',')})`);
    params.push(...excluded);
  }
  return {
    sql: parts.length ? `AND ${parts.join(' AND ')}` : '',
    params,
  };
}

/**
 * Find the nearest exchanges with an exact scan of the rows that pass the filters.
 *
 * The scan computes `vec_distance_l2` for each row that passes the filters, then sorts the rows by distance.
 * The scan reads `exchange_vectors`. Every vector search uses this scan.
 */
function exactVectorSearch(
  db: Database,
  embedding: Buffer,
  filterClause: string,
  filterParams: unknown[],
  limit: number
): any[] {
  return db
    .prepare(
      `
      SELECT
        ${EXCHANGE_SELECT_COLUMNS},
        vec_distance_l2(vec.embedding, ?) AS distance
      FROM exchanges AS e
      JOIN exchange_vectors AS vec ON vec.id = e.id
      WHERE e.is_sidechain = 0
        ${filterClause}
      ORDER BY distance ASC
      LIMIT ?
    `
    )
    .all(embedding, ...filterParams, limit);
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
 * Convert an L2 (Euclidean) distance between two unit-normalized vectors into a cosine similarity in [-1, 1].
 *
 * For unit vectors u, v:  ||u - v||^2 = 2 - 2 * cos(u, v).
 * Therefore:               cos(u, v) = 1 - d^2 / 2.
 *
 * `src/embeddings.ts` passes `normalize: true` to its one pipeline call, so every vector that the module returns has unit length.
 * `vec_distance_l2` returns the L2 distance that the identity applies to.
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
 * Prepare an FTS5 MATCH query from user input. Each word in the query must match in any order.
 *
 * `toFtsQuery` quotes each word. As a result, `AND`, `OR`, `NEAR` and punctuation in the query do not become
 * FTS5 operators. When the query holds no word, the function quotes the whole query as one phrase.
 * The caller falls back to LIKE when FTS5 is unavailable.
 */
export function buildFtsMatchQuery(query: string): string {
  return toFtsQuery(query) ?? `"${query.replace(/"/g, '""')}"`;
}

/**
 * Build the LIKE condition of the text search.
 *
 * Each word of the query must appear in the user or the assistant message.
 *
 * The words are the parts of the query between spaces. `%`, `_` and `\` in a word match as text, not as wildcards.
 * A query with no word matches every message, as `%%` does.
 */
function buildLikeClause(query: string): { sql: string; params: string[] } {
  const words = query.split(/\s+/).filter(w => w.length > 0);
  const terms = words.length > 0 ? words : [''];
  const params: string[] = [];
  for (const term of terms) {
    const pattern = `%${term.replace(/[\\%_]/g, c => `\\${c}`)}%`;
    params.push(pattern, pattern);
  }
  const one = `(e.user_message LIKE ? ESCAPE '\\' OR e.assistant_message LIKE ? ESCAPE '\\')`;
  return { sql: terms.map(() => one).join(' AND '), params };
}

function resolveSearchDb(options: SearchOptions): {
  db: Database;
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

/** Sends the notice that a `both` search uses the text results only. */
function sendVectorNotice(options: SearchOptions, reason: string): void {
  const notice = `Vector search is unavailable (${reason}). The results come from the text search only.`;
  (options.onNotice ?? ((message: string) => console.error(`episodic-memory: ${message}`)))(notice);
}

/**
 * Searches the indexed conversations for a query, and returns the matching exchanges.
 *
 * The `mode` option picks the search path. `vector` uses embeddings. `text` uses full-text search, with a `LIKE` search when full-text search fails. `both` merges the two result lists and removes duplicates.
 * Sidechain exchanges never match. The function throws when `after` or `before` is not in `YYYY-MM-DD` format.
 * When the embedding backend cannot load, a `vector` search throws `EmbeddingsUnavailableError`.
 * A `both` search then returns the text results. The search then sends a notice to `options.onNotice`.
 * A `both` search on a file without the `exchange_vectors` table does the same.
 * The function closes a connection that the function opens. The function leaves a connection from `options.db` or the shared reader open.
 *
 * @param query The text to search for.
 * @param options The filters, the limit, and the connection settings. See `SearchOptions`.
 */
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
  // The value is false when the vector step does not run.
  let vectorRan = mode !== 'text';

  try {
    const { sql: filterClause, params: filterParams } = buildSearchFilters(options);

    if (vectorRan) {
      // The text step needs no embedder. A backend that cannot load therefore removes only the vector step of `both`.
      try {
        await initEmbeddings();
      } catch (error) {
        if (mode !== 'both' || !(error instanceof EmbeddingsUnavailableError)) throw error;
        vectorRan = false;
        sendVectorNotice(options, error.message);
      }
    }

    if (vectorRan) {
      // Vector similarity search. The exact scan applies the filters before it ranks the rows.
      const queryEmbedding = await generateQueryEmbedding(query);
      const embedding = Buffer.from(new Float32Array(queryEmbedding).buffer);
      try {
        results = exactVectorSearch(db, embedding, filterClause, filterParams, limit);
      } catch (error) {
        // A read-only connection to a file that no write open has migrated yet has no vector table.
        if (mode !== 'both' || !(error instanceof Error) || !error.message.includes('no such table: exchange_vectors')) {
          throw error;
        }
        vectorRan = false;
        sendVectorNotice(options, error.message);
      }
    }

    if (mode === 'text' || mode === 'both') {
      let textResults: any[] = [];
      try {
        // Prefer FTS5 for text mode (scales past LIKE '%…%' full scans).
        const ftsStmt = db.prepare(`
          SELECT
            ${EXCHANGE_SELECT_COLUMNS},
            NULL as distance
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
        // FTS missing or MATCH syntax edge-case: fall back to LIKE, with one condition for each word.
        const like = buildLikeClause(query);
        const textStmt = db.prepare(`
          SELECT
            ${EXCHANGE_SELECT_COLUMNS},
            NULL as distance
          FROM exchanges AS e
          WHERE ${like.sql}
            AND e.is_sidechain = 0
            ${filterClause}
          ORDER BY e.timestamp DESC
          LIMIT ?
        `);
        textResults = textStmt.all(...like.params, ...filterParams, limit);
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
    if (summariesVisible(options)) {
      const summaryPath = safeArchiveSummaryPath(row.archive_path);
      if (summaryPath) {
        summary = maybeRedactSecrets(fs.readFileSync(summaryPath, 'utf-8').trim());
      }
    }

    // Create snippet (first 200 chars, collapse newlines)
    const snippetText = exchange.userMessage.substring(0, 200).replace(/\s+/g, ' ').trim();
    const snippet = snippetText + (exchange.userMessage.length > 200 ? '...' : '');

    return {
      exchange,
      // A text row has no distance, so the row has no similarity.
      similarity: row.distance == null ? undefined : l2DistanceToCosineSimilarity(row.distance),
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

/**
 * Formats search results as plain text.
 *
 * Returns `No results found.` when the list is empty.
 * Each result shows its project, its date, its snippet, and the lines that the result covers in the archive file.
 * The match percentage and the tool usage appear only when they exist. The summary appears only when summaries are on.
 */
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

    if (includeSearchSummaries() && result.summary) {
      output += `   ${formatSummaryForDisplay(result.summary)}\n`;
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

/**
 * Finds the conversations that match every concept, using vector search.
 *
 * Each concept runs its own vector search with five times the limit. A conversation counts only when every concept finds the conversation.
 * The results sort by average similarity, highest first. The list holds at most `limit` entries.
 * Returns an empty list when `concepts` is empty.
 *
 * @param concepts The concepts to match. Every concept must match.
 * @param options The search options, without `mode`. `limit` sets the result count.
 */
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
        averageSimilarity,
        summary: firstResult.summary
      });
    }
  }

  // Sort by average similarity (highest first)
  multiConceptResults.sort((a, b) => b.averageSimilarity - a.averageSimilarity);

  // Apply limit
  return multiConceptResults.slice(0, limit);
}

/**
 * Formats multi-concept search results as plain text.
 *
 * Returns a message that names every concept when the list is empty.
 *
 * @param results The results from `searchMultipleConcepts`.
 * @param concepts The concepts that the search used, in the same order.
 */
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

    if (includeSearchSummaries() && result.summary) {
      output += `   ${formatSummaryForDisplay(result.summary)}\n`;
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

    const fileSizeKB = getFileSizeInKB(result.exchange.archivePath);
    const lineRange = `${result.exchange.lineStart}-${result.exchange.lineEnd}`;
    const minLines = result.exchange.lineEnd;

    output += `   Lines ${lineRange} in ${result.exchange.archivePath} (${fileSizeKB}KB, ≥${minLines} lines)\n\n`;
  }

  return output;
}
