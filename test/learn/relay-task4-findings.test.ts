import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { generateTasks } from '../../src/learn/tasks.js';
import { openLearningDb } from '../../src/learn/learning-store.js';
import { createRun, listTasks } from '../../src/learn/learning-db.js';
import { parseSolverAnswer, samePath } from '../../src/learn/grade.js';
import { safeRmSync, suppressConsole } from '../test-utils.js';

suppressConsole();

interface Row {
  id: string;
  project: string;
  timestamp: string;
  userMessage: string;
  assistantMessage: string;
  archivePath: string;
  lineStart: number;
  lineEnd: number;
  session_id: string | null;
}

const USER = 'How do I make the release build stop rewriting the bundled native module? '.repeat(2);
const ASSISTANT =
  'The wrapper now verifies a sentinel file in node_modules before it declares the dependency tree healthy. '.repeat(
    3
  );

function indexDbWith(rows: Row[]): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE exchanges (
      id TEXT PRIMARY KEY,
      project TEXT NOT NULL,
      timestamp TEXT NOT NULL,
      user_message TEXT NOT NULL,
      assistant_message TEXT NOT NULL,
      archive_path TEXT NOT NULL,
      line_start INTEGER NOT NULL,
      line_end INTEGER NOT NULL,
      is_sidechain BOOLEAN DEFAULT 0,
      harness TEXT NOT NULL DEFAULT 'claude',
      session_id TEXT
    )
  `);
  const stmt = db.prepare(`
    INSERT INTO exchanges
      (id, project, timestamp, user_message, assistant_message, archive_path,
       line_start, line_end, is_sidechain, harness, session_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 'claude', ?)
  `);
  for (const row of rows) {
    stmt.run(
      row.id,
      row.project,
      row.timestamp,
      row.userMessage,
      row.assistantMessage,
      row.archivePath,
      row.lineStart,
      row.lineEnd,
      row.session_id
    );
  }
  return db;
}

function bigProject(count: number): Row[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `e${i}`,
    project: 'proj-a',
    timestamp: `2026-03-${String(1 + (i % 20)).padStart(2, '0')}T10:00:00.000Z`,
    userMessage: USER,
    assistantMessage: ASSISTANT,
    archivePath: `/archive/proj-a/session-${i}.jsonl`,
    lineStart: 1 + i * 10,
    lineEnd: 9 + i * 10,
    session_id: `session-${i}`,
  }));
}

describe('relay challenger (Task 4): address leakage into stored prompts', () => {
  let index: Database.Database;
  let learning: Database.Database;
  let dir: string;
  let runId: string;

  beforeEach(() => {
    dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'em-relay4-')));
    index = indexDbWith(bigProject(25));
    learning = openLearningDb({ path: path.join(dir, 'l.sqlite') });
    runId = createRun(learning, { phase: 'improve', project: 'proj-a', seed: 5, budget: {} });
  });

  afterEach(() => {
    learning.close();
    index.close();
    safeRmSync(dir);
  });

  it('a stored prompt never carries the source address (spec §4.4: the solver never sees it)', async () => {
    // The paraphrase prompt tells the model never to quote a file path, a
    // session id or a message id — but nothing enforces it. A paraphrase model
    // that echoes the address (the way models echo context all the time)
    // stores the answer key inside the learner prompt, and the injection
    // screen has no rule against an archive path or a session id.
    const model = async (prompt: string): Promise<string> => [
      '<tier1>',
      'locate: In /archive/proj-a/session-0.jsonl lines 1-9, where was the release build addressed?',
      'recall: In /archive/proj-a/session-0.jsonl, where was the release build addressed, and what was the outcome?',
      'when: When did we work on the release build in session-0?',
      'multi: What did we change in the wrapper and what caused the native module failure in session-0?',
      '</tier1>',
      '<tier2>',
      'locate: Which session covered the packaging step that rewrites the binary?',
      'recall: Which session covered the packaging step that rewrites the binary? State the outcome.',
      'when: What month held the packaging work on the binary?',
      'multi: What did the packaging change do and why did the binary break?',
      '</tier2>',
      '<tier3>',
      'locate: Which session covered the packaging step that rewrites the binary, the one that shipped in February?',
      'recall: Which session covered the packaging step that rewrites the binary, shipped in February? State the outcome.',
      'when: What month held the packaging work on the binary, February?',
      'multi: What did the packaging change do to the vendored library and why did the binary break?',
      '</tier3>',
    ].join('\n');

    await generateTasks(learning, index, {
      runId,
      seed: 5,
      perProject: 25,
      maxTasks: 500,
      model,
    });

    const all = listTasks(learning, { split: 'train', includeStale: true }).concat(
      listTasks(learning, { split: 'test', includeStale: true })
    );
    expect(all.length).toBeGreaterThan(0);
    for (const task of all) {
      expect(task.prompt).not.toContain('/archive/');
      expect(task.prompt).not.toMatch(/session-\d+/);
    }
  });
});

describe('relay challenger (Task 4): answer parsing tolerance', () => {
  it('parseSolverAnswer reads a numbered markdown list of locations', () => {
    // The parser claims to be tolerant of markdown, but the leading-number
    // decoration of an ordered list is not stripped, so a solver that answers
    // with the most common list form scores 0.
    const parsed = parseSolverAnswer('1. path: /archive/p/s.jsonl\n2. lines: 3-4');
    expect(parsed.locations).toHaveLength(1);
    expect(parsed.locations[0].path).toBe('/archive/p/s.jsonl');
    expect(parsed.locations[0].lineStart).toBe(3);
    expect(parsed.locations[0].lineEnd).toBe(4);
  });

  it('samePath folds dot segments in a Windows-shaped path, as path.resolve would', () => {
    // archive-path.ts normalises with path.resolve before case folding; a
    // solver that answers with a `..` segment names the same file and the
    // plan's samePath contract ("path.resolve both") agrees.
    expect(samePath('C:\\x\\s\\..\\y.jsonl', 'C:/x/y.jsonl')).toBe(true);
  });
});
