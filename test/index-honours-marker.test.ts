import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { Database } from '../src/sqlite.js';
import { safeRmSync, seedDigest, suppressConsole } from './test-utils.js';

// The tests index with a fixed vector, so no test loads the embedding model.
vi.mock('../src/embeddings.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/embeddings.js')>();
  return {
    ...actual,
    initEmbeddings: async () => {},
    generateExchangeEmbedding: async () => new Array(384).fill(0.05),
    generateExchangeEmbeddings: async (items: unknown[]) => items.map(() => new Array(384).fill(0.05)),
  };
});

// A summary call of an excluded conversation sends the conversation to a model. The fake records each call.
vi.mock('../src/summarizer.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/summarizer.js')>()),
  summarizeConversation: vi.fn(async () => 'Fake summary'),
}));

const { indexConversations, indexSession, indexUnprocessed } = await import('../src/indexer.js');
const { verifyIndex, repairIndex } = await import('../src/verify.js');
const { summarizeConversation } = await import('../src/summarizer.js');
const { initDatabase, insertExchange } = await import('../src/db.js');
const { parseConversation } = await import('../src/parser.js');

const MARKER = '<INSTRUCTIONS-TO-EPISODIC-MEMORY>DO NOT INDEX THIS CHAT</INSTRUCTIONS-TO-EPISODIC-MEMORY>';
const PROJECT = '-Users-marker-project';
const CLEAN = 'aaaaaaaa-1111-4222-8333-000000000001';
const MARKED = 'bbbbbbbb-1111-4222-8333-000000000002';

function transcript(sessionId: string, question: string): string {
  const ts = '2026-01-03T00:00:00.000Z';
  const user = {
    parentUuid: null, isSidechain: false, userType: 'external', cwd: '/test/project', sessionId,
    version: '2.0.9', gitBranch: 'main', type: 'user',
    message: { role: 'user', content: question },
    uuid: `user-1-${sessionId}`, timestamp: ts,
  };
  const assistant = {
    parentUuid: `user-1-${sessionId}`, isSidechain: false, userType: 'external', cwd: '/test/project', sessionId,
    version: '2.0.9', gitBranch: 'main', type: 'assistant',
    message: { model: 'claude-sonnet-4-5', role: 'assistant', content: [{ type: 'text', text: `An answer in ${sessionId}` }] },
    uuid: `asst-1-${sessionId}`, timestamp: ts,
  };
  return JSON.stringify(user) + '\n' + JSON.stringify(assistant) + '\n';
}

describe('the index and verify commands honour the DO NOT INDEX marker', () => {
  const KEYS = ['TEST_PROJECTS_DIR', 'TEST_ARCHIVE_DIR', 'TEST_DB_PATH'] as const;
  const saved: Record<string, string | undefined> = {};
  let testDir: string;
  let sourceProject: string;
  let archiveProject: string;
  let dbPath: string;
  let restoreConsole: () => void;

  beforeEach(() => {
    for (const key of KEYS) saved[key] = process.env[key];
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'em-index-marker-'));
    const projectsDir = path.join(testDir, 'projects');
    const archiveDir = path.join(testDir, 'archive');
    sourceProject = path.join(projectsDir, PROJECT);
    archiveProject = path.join(archiveDir, PROJECT);
    dbPath = path.join(testDir, 'index', 'db.sqlite');
    fs.mkdirSync(sourceProject, { recursive: true });
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    process.env.TEST_PROJECTS_DIR = projectsDir;
    process.env.TEST_ARCHIVE_DIR = archiveDir;
    process.env.TEST_DB_PATH = dbPath;
    vi.mocked(summarizeConversation).mockClear();
    restoreConsole = suppressConsole();
  });

  afterEach(() => {
    restoreConsole();
    for (const key of KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
    safeRmSync(testDir);
  });

  function writeSources(): void {
    fs.writeFileSync(path.join(sourceProject, `${CLEAN}.jsonl`), transcript(CLEAN, 'A plain question.'), 'utf-8');
    fs.writeFileSync(path.join(sourceProject, `${MARKED}.jsonl`), transcript(MARKED, `A private question. ${MARKER}`), 'utf-8');
  }

  function indexedSessions(): string[] {
    if (!fs.existsSync(dbPath)) return [];
    const db = new Database(dbPath, { readonly: true });
    try {
      return (db.prepare('SELECT DISTINCT archive_path FROM exchanges').all() as Array<{ archive_path: string }>)
        .map(row => path.basename(row.archive_path, '.jsonl'));
    } finally {
      db.close();
    }
  }

  function summarizedSessions(): string[] {
    return vi.mocked(summarizeConversation).mock.calls.map(call => call[0][0]?.sessionId ?? call[1] ?? '?');
  }

  it('indexConversations indexes and summarizes only the conversation without the marker', async () => {
    writeSources();
    await indexConversations(undefined, undefined, 1, false);
    expect(indexedSessions()).toEqual([CLEAN]);
    expect(vi.mocked(summarizeConversation)).toHaveBeenCalledTimes(1);
    expect(summarizedSessions()).not.toContain(MARKED);
    // The archive keeps a copy of the excluded conversation, as the sync does.
    expect(fs.existsSync(path.join(archiveProject, `${MARKED}.jsonl`))).toBe(true);
  }, 60000);

  it('indexConversations scans the transcript it parses, not an older archive copy', async () => {
    writeSources();
    // The archive copy predates the marker. indexConversations does not refresh an existing copy.
    fs.mkdirSync(archiveProject, { recursive: true });
    fs.writeFileSync(path.join(archiveProject, `${MARKED}.jsonl`), transcript(MARKED, 'A question.'), 'utf-8');
    await indexConversations(undefined, undefined, 1, false);
    expect(indexedSessions()).toEqual([CLEAN]);
    expect(summarizedSessions()).not.toContain(MARKED);
  }, 60000);

  it('indexUnprocessed indexes and summarizes only the conversation without the marker', async () => {
    writeSources();
    await indexUnprocessed(1, false);
    expect(indexedSessions()).toEqual([CLEAN]);
    expect(vi.mocked(summarizeConversation)).toHaveBeenCalledTimes(1);
    expect(summarizedSessions()).not.toContain(MARKED);
  }, 60000);

  it('indexSession indexes nothing and summarizes nothing for a conversation with the marker', async () => {
    writeSources();
    await indexSession(MARKED, 1, false);
    expect(indexedSessions()).toEqual([]);
    expect(vi.mocked(summarizeConversation)).not.toHaveBeenCalled();
  }, 60000);

  // A conversation can gain the marker after an index run wrote its rows. The README says that the marker excludes the
  // entire conversation, so the next index run removes the earlier rows from every table.
  function writeUnmarkedSources(): void {
    fs.writeFileSync(path.join(sourceProject, `${CLEAN}.jsonl`), transcript(CLEAN, 'A plain question.'), 'utf-8');
    fs.writeFileSync(path.join(sourceProject, `${MARKED}.jsonl`), transcript(MARKED, 'A question.'), 'utf-8');
  }

  function addMarker(sessionId: string): string {
    const source = path.join(sourceProject, `${sessionId}.jsonl`);
    const line = { type: 'user', uuid: `user-2-${sessionId}`, message: { role: 'user', content: `Keep this private. ${MARKER}` } };
    fs.appendFileSync(source, JSON.stringify(line) + '\n', 'utf-8');
    return source;
  }

  function tableCounts(): { exchanges: number; vectors: number; text: number } {
    const db = initDatabase();
    try {
      const count = (table: string) => (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
      return { exchanges: count('exchanges'), vectors: count('exchange_vectors'), text: count('exchanges_fts') };
    } finally {
      db.close();
    }
  }

  const ONE_CONVERSATION = { exchanges: 1, vectors: 1, text: 1 };

  it('indexConversations removes the earlier rows of a conversation that gains the marker', async () => {
    writeUnmarkedSources();
    await indexConversations(undefined, undefined, 1, true);
    expect(indexedSessions().sort()).toEqual([CLEAN, MARKED]);

    addMarker(MARKED);
    await indexConversations(undefined, undefined, 1, true);
    expect(indexedSessions()).toEqual([CLEAN]);
    expect(tableCounts()).toEqual(ONE_CONVERSATION);
  }, 60000);

  it('indexUnprocessed removes the earlier rows of a conversation that gains the marker', async () => {
    writeUnmarkedSources();
    await indexUnprocessed(1, true);
    expect(indexedSessions().sort()).toEqual([CLEAN, MARKED]);

    addMarker(MARKED);
    await indexUnprocessed(1, true);
    expect(indexedSessions()).toEqual([CLEAN]);
    expect(tableCounts()).toEqual(ONE_CONVERSATION);
  }, 60000);

  it('indexSession removes the earlier rows of a conversation that gains the marker', async () => {
    writeUnmarkedSources();
    await indexConversations(undefined, undefined, 1, true);
    expect(indexedSessions().sort()).toEqual([CLEAN, MARKED]);

    addMarker(MARKED);
    await indexSession(MARKED, 1, true);
    expect(indexedSessions()).toEqual([CLEAN]);
    expect(tableCounts()).toEqual(ONE_CONVERSATION);
  }, 60000);

  it('indexSession removes the digest lines of a conversation that gains the marker', async () => {
    writeUnmarkedSources();
    await indexConversations(undefined, undefined, 1, true);
    const digestLines = seedDigest(dbPath);
    expect(digestLines()).toHaveLength(2);

    addMarker(MARKED);
    await indexSession(MARKED, 1, true);
    expect(digestLines()).toEqual([expect.stringContaining(`Fact of ${CLEAN} [#`)]);
  }, 60000);

  it('indexSession removes the earlier rows of a marked conversation that has no exchanges', async () => {
    // The source holds only a user line with the marker, so the parse gives no exchanges. Rows of the archive path stay
    // from an earlier run. The marker check must run before the check for an empty conversation.
    const source = path.join(sourceProject, `${MARKED}.jsonl`);
    const line = { type: 'user', uuid: 'user-only', message: { role: 'user', content: `Keep this private. ${MARKER}` } };
    fs.writeFileSync(source, JSON.stringify(line) + '\n', 'utf-8');
    expect(await parseConversation(source, PROJECT, source)).toEqual([]);
    fs.mkdirSync(archiveProject, { recursive: true });
    const archived = path.join(archiveProject, `${MARKED}.jsonl`);
    fs.writeFileSync(archived, transcript(MARKED, 'A question.'), 'utf-8');
    const db = initDatabase();
    try {
      for (const exchange of await parseConversation(archived, PROJECT, archived)) {
        insertExchange(db, exchange, new Array(384).fill(0.05), []);
      }
    } finally {
      db.close();
    }
    expect(indexedSessions()).toEqual([MARKED]);

    await indexSession(MARKED, 1, true);
    expect(indexedSessions()).toEqual([]);
  }, 60000);

  it('an index run keeps the rows of a conversation that the marker scan cannot read (the control)', async () => {
    writeUnmarkedSources();
    await indexConversations(undefined, undefined, 1, true);
    const locked = addMarker(MARKED);
    // The scan cannot show the marker, so the run removes nothing. The parse reads through a stream and still works.
    const realOpen = fs.openSync;
    const spy = vi.spyOn(fs, 'openSync').mockImplementation(((file: fs.PathLike, ...rest: unknown[]) => {
      if (String(file) === locked) {
        throw Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' });
      }
      return (realOpen as (...args: unknown[]) => number)(file, ...rest);
    }) as typeof fs.openSync);
    try {
      await indexConversations(undefined, undefined, 1, true);
      await indexUnprocessed(1, true);
      await indexSession(MARKED, 1, true);
    } finally {
      spy.mockRestore();
    }
    expect(indexedSessions().sort()).toEqual([CLEAN, MARKED]);
  }, 60000);

  it('verifyIndex does not report an excluded archive file as missing', async () => {
    fs.mkdirSync(archiveProject, { recursive: true });
    fs.writeFileSync(path.join(archiveProject, `${MARKED}.jsonl`), transcript(MARKED, `A private question. ${MARKER}`), 'utf-8');
    initDatabase().close();
    const issues = await verifyIndex();
    expect(issues.missing).toEqual([]);
    expect(issues.outdated).toEqual([]);
    expect(issues.corrupted).toEqual([]);
  }, 60000);

  it('verifyIndex reports the rows of an excluded file as orphaned, and the repair deletes them and their digest lines without a summary', async () => {
    fs.mkdirSync(archiveProject, { recursive: true });
    const marked = path.join(archiveProject, `${MARKED}.jsonl`);
    fs.writeFileSync(marked, transcript(MARKED, `A private question. ${MARKER}`), 'utf-8');
    // Rows that an earlier index command wrote before the commands honoured the marker.
    const db = initDatabase();
    try {
      for (const exchange of await parseConversation(marked, PROJECT, marked)) {
        insertExchange(db, exchange, new Array(384).fill(0.05), []);
      }
    } finally {
      db.close();
    }
    expect(indexedSessions()).toEqual([MARKED]);
    const digestLines = seedDigest(dbPath);
    expect(digestLines()).toHaveLength(1);

    const issues = await verifyIndex();
    expect(issues.orphaned.map(o => path.basename(o.path, '.jsonl'))).toEqual([MARKED]);
    expect(issues.missing).toEqual([]);

    await repairIndex(issues);
    expect(indexedSessions()).toEqual([]);
    expect(digestLines()).toEqual([]);
    expect(vi.mocked(summarizeConversation)).not.toHaveBeenCalled();
  }, 60000);

  it('repairIndex skips a listed file that has the marker, so the file gets no summary call and no rows', async () => {
    // The file gains the marker after the verify run that listed it.
    fs.mkdirSync(archiveProject, { recursive: true });
    const marked = path.join(archiveProject, `${MARKED}.jsonl`);
    fs.writeFileSync(marked, transcript(MARKED, `A private question. ${MARKER}`), 'utf-8');
    initDatabase().close();
    await repairIndex({ missing: [{ path: marked, reason: 'No summary file' }], orphaned: [], outdated: [], corrupted: [] });
    expect(indexedSessions()).toEqual([]);
    expect(vi.mocked(summarizeConversation)).not.toHaveBeenCalled();
    expect(fs.existsSync(marked.replace('.jsonl', '-summary.txt'))).toBe(false);
  }, 60000);

  it('verifyIndex keeps the rows of an archive file that the scan cannot read, and reports the file', async () => {
    fs.mkdirSync(archiveProject, { recursive: true });
    const locked = path.join(archiveProject, `${CLEAN}.jsonl`);
    fs.writeFileSync(locked, transcript(CLEAN, 'A plain question.'), 'utf-8');
    fs.writeFileSync(locked.replace('.jsonl', '-summary.txt'), 'A summary.', 'utf-8');
    const db = initDatabase();
    try {
      for (const exchange of await parseConversation(locked, PROJECT, locked)) {
        insertExchange(db, exchange, new Array(384).fill(0.05), []);
      }
    } finally {
      db.close();
    }
    const realOpen = fs.openSync;
    const spy = vi.spyOn(fs, 'openSync').mockImplementation(((file: fs.PathLike, ...rest: unknown[]) => {
      if (String(file) === locked) {
        throw Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' });
      }
      return (realOpen as (...args: unknown[]) => number)(file, ...rest);
    }) as typeof fs.openSync);
    try {
      const issues = await verifyIndex();
      expect(issues.orphaned).toEqual([]);
      expect(issues.corrupted.map(c => c.path)).toEqual([locked]);
      expect(issues.corrupted[0].error).toMatch(/could not read/);
    } finally {
      spy.mockRestore();
    }
    expect(indexedSessions()).toEqual([CLEAN]);
  }, 60000);
});
