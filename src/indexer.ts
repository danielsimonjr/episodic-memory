import fs from 'fs';
import path from 'path';
import os from 'os';
import { initDatabase, insertExchange, getMaxIndexedLine } from './db.js';
import { parseConversation } from './parser.js';
import { initEmbeddings, generateExchangeEmbedding, generateExchangeEmbeddings } from './embeddings.js';
import { summarizeConversation } from './summarizer.js';
import { ConversationExchange } from './types.js';
import { getArchiveDir, getExcludedProjects, getConversationSourceDirs, findJsonlFiles, statIfExists } from './paths.js';

// Set max output tokens for Claude SDK (used by summarizer)
process.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS = '20000';

// Increase max listeners for concurrent API calls
import { EventEmitter } from 'events';
EventEmitter.defaultMaxListeners = 20;

// Process items in batches with limited concurrency
async function processBatch<T, R>(
  items: T[],
  processor: (item: T) => Promise<R>,
  concurrency: number
): Promise<R[]> {
  const results: R[] = [];

  for (let i = 0; i < items.length; i += concurrency) {
    const batch = items.slice(i, i + concurrency);
    const batchResults = await Promise.all(batch.map(processor));
    results.push(...batchResults);
  }

  return results;
}

function sessionIdForSummary(exchanges: ConversationExchange[]): string | undefined {
  return exchanges.find(exchange => exchange.sessionId)?.sessionId;
}

/**
 * Run the copy and the parse of one listed transcript. Return `null` when the transcript is gone.
 *
 * Claude Code can delete a transcript after the walk lists the transcript. The copy or the parse then fails with ENOENT.
 * The function logs the file name. The function returns `null`. As a result, the caller skips the file.
 * Any other error propagates.
 */
async function skipIfVanished<T>(file: string, work: () => Promise<T>): Promise<T | null> {
  try {
    return await work();
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') throw error;
    console.log(`  Skipped ${file} (the file disappeared: ${(error as Error).message})`);
    return null;
  }
}

/**
 * Index the conversations in every source folder.
 *
 * The function opens the index and loads the embedding model before it scans. Each file is copied to the archive when no copy exists, and then parsed. Files without exchanges are skipped. Unless `noSummaries` is set, the function writes a summary for each conversation that has none.
 *
 * `limitToProject` restricts the run to one project. `maxConversations` stops the run after a project when the processed count reaches that number. `concurrency` sets how many summaries run at once.
 */
export async function indexConversations(
  limitToProject?: string,
  maxConversations?: number,
  concurrency: number = 1,
  noSummaries: boolean = false
): Promise<void> {
  console.log('Initializing database...');
  const db = initDatabase();
  try {
    console.log('Loading embedding model...');
    await initEmbeddings();

    if (noSummaries) {
      console.log('⚠️  Running in no-summaries mode (skipping AI summaries)');
    }

    console.log('Scanning for conversation files...');
    const sourceDirs = getConversationSourceDirs();
    const ARCHIVE_DIR = getArchiveDir();

    let totalExchanges = 0;
    let conversationsProcessed = 0;

    const excludedProjects = getExcludedProjects();
    const excludedDirSet = new Set(excludedProjects);

    for (const sourceDir of sourceDirs) {
    const projects = fs.readdirSync(sourceDir);

    for (const project of projects) {
      // Skip excluded projects
      if (excludedProjects.includes(project)) {
        console.log(`\nSkipping excluded project: ${project}`);
        continue;
      }

      // Skip if limiting to specific project
      if (limitToProject && project !== limitToProject) continue;
      const projectPath = path.join(sourceDir, project);
      if (!statIfExists(projectPath)?.isDirectory()) continue;

      const files = findJsonlFiles(projectPath, excludedDirSet);

      if (files.length === 0) continue;

      console.log(`\nProcessing project: ${project} (${files.length} conversations)`);
      if (concurrency > 1) console.log(`  Concurrency: ${concurrency}`);

      // Create archive directory for this project
      const projectArchive = path.join(ARCHIVE_DIR, project);
      fs.mkdirSync(projectArchive, { recursive: true });

      // Prepare all conversations first
      type ConvToProcess = {
        file: string;
        sourcePath: string;
        archivePath: string;
        summaryPath: string;
        exchanges: ConversationExchange[];
      };

      const toProcess: ConvToProcess[] = [];

      for (const file of files) {
        const sourcePath = path.join(projectPath, file);
        const archivePath = path.join(projectArchive, file);

        // Copy to archive (ensure parent dirs exist for subagent files), then parse the conversation.
        const exchanges = await skipIfVanished(file, async () => {
          if (!fs.existsSync(archivePath)) {
            fs.mkdirSync(path.dirname(archivePath), { recursive: true });
            fs.copyFileSync(sourcePath, archivePath);
            console.log(`  Archived: ${file}`);
          }
          return parseConversation(sourcePath, project, archivePath);
        });
        if (exchanges === null) continue;

        if (exchanges.length === 0) {
          console.log(`  Skipped ${file} (no exchanges)`);
          continue;
        }

        toProcess.push({
          file,
          sourcePath,
          archivePath,
          summaryPath: archivePath.replace('.jsonl', '-summary.txt'),
          exchanges
        });
      }

      // Batch summarize conversations in parallel (unless --no-summaries)
      if (!noSummaries) {
        const needsSummary = toProcess.filter(c => !fs.existsSync(c.summaryPath));

        if (needsSummary.length > 0) {
          console.log(`  Generating ${needsSummary.length} summaries (concurrency: ${concurrency})...`);

          await processBatch(needsSummary, async (conv) => {
            try {
              const summary = await summarizeConversation(conv.exchanges, sessionIdForSummary(conv.exchanges));
              fs.writeFileSync(conv.summaryPath, summary, 'utf-8');
              const wordCount = summary.split(/\s+/).length;
              console.log(`  ✓ ${conv.file}: ${wordCount} words`);
              return summary;
            } catch (error) {
              console.log(`  ✗ ${conv.file}: ${error}`);
              return null;
            }
          }, concurrency);
        }
      } else {
        console.log(`  Skipping ${toProcess.length} summaries (--no-summaries mode)`);
      }

      // Now process embeddings and DB inserts (batched per conversation)
      for (const conv of toProcess) {
        if (conv.exchanges.length === 0) continue;

        const embeddings = await generateExchangeEmbeddings(
          conv.exchanges.map((exchange) => ({
            userMessage: exchange.userMessage,
            assistantMessage: exchange.assistantMessage,
            toolNames: exchange.toolCalls?.map((tc) => tc.toolName),
          }))
        );

        const insertTx = db.transaction(() => {
          for (let i = 0; i < conv.exchanges.length; i++) {
            const exchange = conv.exchanges[i];
            const toolNames = exchange.toolCalls?.map((tc) => tc.toolName);
            insertExchange(db, exchange, embeddings[i], toolNames);
          }
        });
        insertTx();

        totalExchanges += conv.exchanges.length;
        conversationsProcessed++;

        // Check if we hit the limit
        if (maxConversations && conversationsProcessed >= maxConversations) {
          console.log(`\nReached limit of ${maxConversations} conversations`);
          console.log(`✅ Indexing complete! Conversations: ${conversationsProcessed}, Exchanges: ${totalExchanges}`);
          return;
        }
      }
    }
    } // end sourceDir loop

    console.log(`\n✅ Indexing complete! Conversations: ${conversationsProcessed}, Exchanges: ${totalExchanges}`);
  } finally {
    db.close();
  }
}

/**
 * Archive and index the first conversation file whose path contains the session id.
 *
 * The function searches every source folder. The function writes a summary for the file when the file has exchanges and no summary. The function writes no summary when `noSummaries` is set. When no file matches, the function logs a message and returns without an error.
 *
 * @param sessionId Text that the file path must contain.
 * @param concurrency Has no effect. The function handles one file.
 * @param noSummaries Set to skip summary generation.
 */
export async function indexSession(sessionId: string, concurrency: number = 1, noSummaries: boolean = false): Promise<void> {
  console.log(`Indexing session: ${sessionId}`);

  // Find the conversation file for this session
  const sourceDirs = getConversationSourceDirs();
  const ARCHIVE_DIR = getArchiveDir();
  const excludedProjects = getExcludedProjects();
  const excludedDirSet = new Set(excludedProjects);
  let found = false;

  for (const sourceDir of sourceDirs) {
  const projects = fs.readdirSync(sourceDir);

  for (const project of projects) {
    if (excludedProjects.includes(project)) continue;

    const projectPath = path.join(sourceDir, project);
    if (!statIfExists(projectPath)?.isDirectory()) continue;

    const files = findJsonlFiles(projectPath, excludedDirSet).filter(f => f.includes(sessionId));

    if (files.length > 0) {
      found = true;
      const file = files[0];
      const sourcePath = path.join(projectPath, file);

      const db = initDatabase();
      try {
        await initEmbeddings();

        const projectArchive = path.join(ARCHIVE_DIR, project);
        fs.mkdirSync(projectArchive, { recursive: true });

        const archivePath = path.join(projectArchive, file);

        // Archive (ensure parent dirs exist for subagent files), then parse and summarize.
        const exchanges = await skipIfVanished(file, async () => {
          if (!fs.existsSync(archivePath)) {
            fs.mkdirSync(path.dirname(archivePath), { recursive: true });
            fs.copyFileSync(sourcePath, archivePath);
          }
          return parseConversation(sourcePath, project, archivePath);
        });

        if (exchanges && exchanges.length > 0) {
          // Generate summary (unless --no-summaries)
          const summaryPath = archivePath.replace('.jsonl', '-summary.txt');
          if (!noSummaries && !fs.existsSync(summaryPath)) {
            fs.mkdirSync(path.dirname(summaryPath), { recursive: true });
            const summary = await summarizeConversation(exchanges, sessionIdForSummary(exchanges));
            fs.writeFileSync(summaryPath, summary, 'utf-8');
            console.log(`Summary: ${summary.split(/\s+/).length} words`);
          }

          // Index
          for (const exchange of exchanges) {
            const toolNames = exchange.toolCalls?.map(tc => tc.toolName);
            const embedding = await generateExchangeEmbedding(
              exchange.userMessage,
              exchange.assistantMessage,
              toolNames
            );
            insertExchange(db, exchange, embedding, toolNames);
          }

          console.log(`✅ Indexed session ${sessionId}: ${exchanges.length} exchanges`);
        }
      } finally {
        db.close();
      }
      break;
    }
  }
  if (found) break;
  } // end sourceDir loop

  if (!found) {
    console.log(`Session ${sessionId} not found`);
  }
}

/**
 * Index the new exchanges of every conversation.
 *
 * The transcripts are append-only. For each file, the function reads the last line that the index holds. The function then indexes only the exchanges that start after that line. The function refreshes the archive copy of each file that has indexed lines.
 *
 * Unless `noSummaries` is set, the function writes missing summaries and runs `concurrency` of them at a time. When no file has new exchanges, the function prints a message and returns.
 */
export async function indexUnprocessed(concurrency: number = 1, noSummaries: boolean = false): Promise<void> {
  console.log('Finding unprocessed conversations...');
  if (concurrency > 1) console.log(`Concurrency: ${concurrency}`);
  if (noSummaries) console.log('⚠️  Running in no-summaries mode (skipping AI summaries)');

  const db = initDatabase();
  try {
    await initEmbeddings();

    const sourceDirs = getConversationSourceDirs();
    const ARCHIVE_DIR = getArchiveDir();
    const excludedProjects = getExcludedProjects();
    const excludedDirSet = new Set(excludedProjects);

    type UnprocessedConv = {
      project: string;
      file: string;
      sourcePath: string;
      archivePath: string;
      summaryPath: string;
      exchanges: ConversationExchange[];
    };

    const unprocessed: UnprocessedConv[] = [];

    // Collect all unprocessed conversations from all source dirs
    for (const sourceDir of sourceDirs) {
    const projects = fs.readdirSync(sourceDir);

    for (const project of projects) {
      if (excludedProjects.includes(project)) continue;

      const projectPath = path.join(sourceDir, project);
      if (!statIfExists(projectPath)?.isDirectory()) continue;

      const files = findJsonlFiles(projectPath, excludedDirSet);

      for (const file of files) {
        const sourcePath = path.join(projectPath, file);
        const projectArchive = path.join(ARCHIVE_DIR, project);
        const archivePath = path.join(projectArchive, file);
        const summaryPath = archivePath.replace('.jsonl', '-summary.txt');

        // High-water mark: index exchanges past the last line we've already covered.
        // Transcript JSONLs are append-only, so MAX(line_end) tells us where to resume.
        const maxIndexedLine = getMaxIndexedLine(db, archivePath);

        const exchanges = await skipIfVanished(file, async () => {
          // Ensure parent dirs exist for subagent files
          fs.mkdirSync(path.dirname(archivePath), { recursive: true });

          // Refresh the archive when the source may have grown beyond what we've seen.
          if (!fs.existsSync(archivePath) || maxIndexedLine > 0) {
            fs.copyFileSync(sourcePath, archivePath);
          }

          // Parse; the filter below keeps the exchanges past the high-water mark.
          return parseConversation(sourcePath, project, archivePath);
        });
        if (exchanges === null) continue;
        const newExchanges = maxIndexedLine > 0
          ? exchanges.filter(e => e.lineStart > maxIndexedLine)
          : exchanges;
        if (newExchanges.length === 0) continue;

        unprocessed.push({ project, file, sourcePath, archivePath, summaryPath, exchanges: newExchanges });
      }
    }
    } // end sourceDir loop

    if (unprocessed.length === 0) {
      console.log('✅ All conversations are already processed!');
      return;
    }

    console.log(`Found ${unprocessed.length} unprocessed conversations`);

    // Batch process summaries (unless --no-summaries)
    if (!noSummaries) {
      const needsSummary = unprocessed.filter(c => !fs.existsSync(c.summaryPath));
      if (needsSummary.length > 0) {
        console.log(`Generating ${needsSummary.length} summaries (concurrency: ${concurrency})...\n`);

        await processBatch(needsSummary, async (conv) => {
          try {
            const summary = await summarizeConversation(conv.exchanges, sessionIdForSummary(conv.exchanges));
            fs.writeFileSync(conv.summaryPath, summary, 'utf-8');
            const wordCount = summary.split(/\s+/).length;
            console.log(`  ✓ ${conv.project}/${conv.file}: ${wordCount} words`);
            return summary;
          } catch (error) {
            console.log(`  ✗ ${conv.project}/${conv.file}: ${error}`);
            return null;
          }
        }, concurrency);
      }
    } else {
      console.log(`Skipping summaries for ${unprocessed.length} conversations (--no-summaries mode)\n`);
    }

    // Now index embeddings (batched per conversation)
    console.log(`\nIndexing embeddings...`);
    for (const conv of unprocessed) {
      if (conv.exchanges.length === 0) continue;
      const embeddings = await generateExchangeEmbeddings(
        conv.exchanges.map((exchange) => ({
          userMessage: exchange.userMessage,
          assistantMessage: exchange.assistantMessage,
          toolNames: exchange.toolCalls?.map((tc) => tc.toolName),
        }))
      );
      const insertTx = db.transaction(() => {
        for (let i = 0; i < conv.exchanges.length; i++) {
          const exchange = conv.exchanges[i];
          const toolNames = exchange.toolCalls?.map((tc) => tc.toolName);
          insertExchange(db, exchange, embeddings[i], toolNames);
        }
      });
      insertTx();
    }

    console.log(`\n✅ Processed ${unprocessed.length} conversations`);
  } finally {
    db.close();
  }
}
