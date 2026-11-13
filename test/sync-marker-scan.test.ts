import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs, { mkdtempSync, mkdirSync, writeFileSync, statSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import Database from 'better-sqlite3';
import { safeRmSync, suppressConsole } from './test-utils.js';

// The sync tests below index with a fixed vector, so no test loads the embedding model.
vi.mock('../src/embeddings.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/embeddings.js')>();
  return {
    ...actual,
    initEmbeddings: async () => {},
    generateExchangeEmbeddings: async (items: unknown[]) => items.map(() => new Array(384).fill(0.05)),
  };
});

const { shouldSkipConversation, syncConversations } = await import('../src/sync.js');

// Ported from upstream 6dcfed1 (part B). The README says that a conversation with the marker anywhere in it is not
// indexed. The scan read only the first 256 KiB, so a marker later in a long transcript was not seen, and the
// conversation was indexed. The scan now reads the whole file in chunks. A read error skips the conversation.
const DO_NOT_INDEX_MARKER =
  '<INSTRUCTIONS-TO-EPISODIC-MEMORY>DO NOT INDEX THIS CHAT</INSTRUCTIONS-TO-EPISODIC-MEMORY>';
const CHUNK = 1 << 20;

describe('shouldSkipConversation reads the whole file', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'em-marker-scan-'));
  });

  afterEach(() => {
    safeRmSync(testDir);
  });

  it('finds the marker at 600 KB of a 1 MiB file', () => {
    const filePath = join(testDir, 'late-marker.jsonl');
    const head = 'a'.repeat(600 * 1024);
    writeFileSync(filePath, head + DO_NOT_INDEX_MARKER + 'b'.repeat(CHUNK - head.length - DO_NOT_INDEX_MARKER.length));
    expect(statSync(filePath).size).toBe(CHUNK);
    expect(shouldSkipConversation(filePath)).toBe(true);
  });

  it('finds the marker near the end of a file of several chunks', () => {
    const filePath = join(testDir, 'large-marked.jsonl');
    writeFileSync(filePath, 'x'.repeat(3 * CHUNK) + DO_NOT_INDEX_MARKER);
    expect(shouldSkipConversation(filePath)).toBe(true);
  });

  it('returns false for a large file with no marker', () => {
    const filePath = join(testDir, 'large-clean.jsonl');
    writeFileSync(filePath, 'x'.repeat(3 * CHUNK));
    expect(shouldSkipConversation(filePath)).toBe(false);
  });

  it('finds a marker that crosses a chunk boundary', () => {
    const filePath = join(testDir, 'boundary-marked.jsonl');
    const filler = 'y'.repeat(CHUNK - Math.floor(DO_NOT_INDEX_MARKER.length / 2));
    writeFileSync(filePath, filler + DO_NOT_INDEX_MARKER);
    expect(shouldSkipConversation(filePath)).toBe(true);
  });

  it('skips the conversation when the path is a directory', () => {
    expect(shouldSkipConversation(testDir)).toBe(true);
  });

  it('skips the conversation when the file does not exist', () => {
    expect(shouldSkipConversation(join(testDir, 'does-not-exist.jsonl'))).toBe(true);
  });
});

function transcript(text: string): string {
  return [
    JSON.stringify({
      type: 'user', uuid: 'u1', parentUuid: null, timestamp: '2025-10-01T12:00:00Z', isSidechain: false,
      message: { role: 'user', content: text },
    }),
    JSON.stringify({
      type: 'assistant', uuid: 'a1', parentUuid: 'u1', timestamp: '2025-10-01T12:00:01Z', isSidechain: false,
      message: { role: 'assistant', content: [{ type: 'text', text: 'An answer.' }] },
    }),
  ].join('\n') + '\n';
}

describe('sync honours the marker scan', () => {
  let testDir: string;
  let sourceDir: string;
  let destDir: string;
  let dbPath: string;
  let restoreConsole: () => void;
  const saved = { db: process.env.TEST_DB_PATH, config: process.env.EPISODIC_MEMORY_CONFIG_DIR };
  const SESSION = '0a1b2c3d-1111-4222-8333-444455556666';

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'em-marker-sync-'));
    sourceDir = join(testDir, 'source');
    destDir = join(testDir, 'dest');
    dbPath = join(testDir, 'index.sqlite');
    mkdirSync(join(sourceDir, 'project-a'), { recursive: true });
    mkdirSync(join(testDir, 'config'), { recursive: true });
    process.env.TEST_DB_PATH = dbPath;
    process.env.EPISODIC_MEMORY_CONFIG_DIR = join(testDir, 'config');
    restoreConsole = suppressConsole();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    restoreConsole();
    if (saved.db === undefined) delete process.env.TEST_DB_PATH;
    else process.env.TEST_DB_PATH = saved.db;
    if (saved.config === undefined) delete process.env.EPISODIC_MEMORY_CONFIG_DIR;
    else process.env.EPISODIC_MEMORY_CONFIG_DIR = saved.config;
    safeRmSync(testDir);
  });

  function indexedRows(): number {
    if (!fs.existsSync(dbPath)) return 0;
    const db = new Database(dbPath, { readonly: true });
    try {
      return (db.prepare('SELECT COUNT(*) AS n FROM exchanges').get() as { n: number }).n;
    } finally {
      db.close();
    }
  }

  it('keeps a transcript with a late marker out of the index', async () => {
    const padding = 'p'.repeat(300 * 1024);
    writeFileSync(join(sourceDir, 'project-a', `${SESSION}.jsonl`), transcript(padding + DO_NOT_INDEX_MARKER));

    const result = await syncConversations(sourceDir, destDir, { skipSummaries: true });

    expect(result.copied).toBe(1);
    expect(result.errors).toEqual([]);
    expect(indexedRows()).toBe(0);
  });

  it('records an error for an archive copy that the scan cannot read, and indexes the file at the next sync', async () => {
    writeFileSync(join(sourceDir, 'project-a', `${SESSION}.jsonl`), transcript('A plain question.'));
    const archiveCopy = join(destDir, 'project-a', `${SESSION}.jsonl`);
    const realOpen = fs.openSync;
    const spy = vi.spyOn(fs, 'openSync').mockImplementation(((file: fs.PathLike, ...rest: unknown[]) => {
      if (String(file) === archiveCopy) {
        throw Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' });
      }
      return (realOpen as (...args: unknown[]) => number)(file, ...rest);
    }) as typeof fs.openSync);

    const first = await syncConversations(sourceDir, destDir, { skipSummaries: true });
    expect(first.errors.map(e => e.file)).toEqual([archiveCopy]);
    expect(first.errors[0].error).toMatch(/could not read/);
    expect(indexedRows()).toBe(0);

    spy.mockRestore();
    const second = await syncConversations(sourceDir, destDir, { skipSummaries: true });
    expect(second.errors).toEqual([]);
    expect(second.indexed).toBe(1);
    expect(indexedRows()).toBe(1);
  });
});
