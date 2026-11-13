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

// A marker counts only in the text of a user or assistant message. A session that reads a file with the marker, for
// example the source of this repo, has the marker in a tool input or a tool result. That session stays in the index.
describe('scanExclusionMarkers counts only the text of a user or assistant message', () => {
  let testDir: string;
  let scanExclusionMarkers: (filePath: string) => 'marker' | 'clean' | 'unreadable';

  beforeEach(async () => {
    testDir = mkdtempSync(join(tmpdir(), 'em-marker-kind-'));
    ({ scanExclusionMarkers } = await import('../src/exclusion-marker.js'));
  });

  afterEach(() => {
    safeRmSync(testDir);
  });

  function scan(records: unknown[]): string {
    const filePath = join(testDir, 'session.jsonl');
    writeFileSync(filePath, records.map(r => JSON.stringify(r)).join('\n') + '\n');
    return scanExclusionMarkers(filePath);
  }

  const M = DO_NOT_INDEX_MARKER;
  const user = (content: unknown) => ({ type: 'user', message: { role: 'user', content } });
  const assistant = (content: unknown) => ({ type: 'assistant', message: { role: 'assistant', content } });
  const codex = (payload: unknown) => ({ type: 'response_item', timestamp: '2025-10-01T12:00:00Z', payload });

  it('counts the marker in a user string, a user text block and an assistant text block', () => {
    expect(scan([user(`Please forget this. ${M}`)])).toBe('marker');
    expect(scan([user([{ type: 'text', text: `Forget this. ${M}` }])])).toBe('marker');
    expect(scan([assistant([{ type: 'text', text: `I add the marker: ${M}` }])])).toBe('marker');
  });

  it('counts the marker in the text of a Codex user or assistant message', () => {
    expect(scan([codex({ type: 'message', role: 'user', content: [{ type: 'input_text', text: M }] })])).toBe('marker');
    expect(scan([codex({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: M }] })])).toBe('marker');
  });

  it('does not count the marker in a tool result, a tool input, a thinking block or a tool output record', () => {
    expect(scan([user([{ type: 'tool_result', tool_use_id: 't1', content: `const MARKER = '${M}';` }])])).toBe('clean');
    expect(scan([user([{ type: 'tool_result', tool_use_id: 't1', content: [{ type: 'text', text: M }] }])])).toBe('clean');
    expect(scan([assistant([{ type: 'tool_use', id: 't1', name: 'Write', input: { content: M } }])])).toBe('clean');
    expect(scan([assistant([{ type: 'thinking', thinking: `The source holds ${M}` }])])).toBe('clean');
    // Only a block of type `text` is message text, as in the parser. A block of another type can carry a `text` field.
    expect(scan([user([{ type: 'document', title: 'source', text: M }])])).toBe('clean');
    expect(scan([{ ...user([{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }]), toolUseResult: { stdout: M } }])).toBe('clean');
  });

  it('does not count the marker in a Codex tool call or tool output', () => {
    expect(scan([codex({ type: 'function_call', name: 'shell', arguments: JSON.stringify({ cmd: `grep '${M}'` }) })])).toBe('clean');
    expect(scan([codex({ type: 'function_call_output', call_id: 'c1', output: M })])).toBe('clean');
    expect(scan([codex({ type: 'message', role: 'developer', content: [{ type: 'input_text', text: M }] })])).toBe('clean');
  });

  it('counts the marker in a line that does not parse, and finds a message marker after tool lines', () => {
    const filePath = join(testDir, 'broken.jsonl');
    writeFileSync(filePath, JSON.stringify(user('A question.')) + '\n{"type":"user","message":' + M + '\n');
    expect(scanExclusionMarkers(filePath)).toBe('marker');
    const tool = user([{ type: 'tool_result', tool_use_id: 't1', content: M }]);
    expect(scan([tool, tool, assistant([{ type: 'text', text: 'Fine.' }]), user(`Now forget it. ${M}`)])).toBe('marker');
  });

  it('reads a message line that crosses a read chunk', () => {
    const filePath = join(testDir, 'long-line.jsonl');
    const text = 'x'.repeat(CHUNK - 40) + M + 'y'.repeat(CHUNK);
    writeFileSync(filePath, JSON.stringify(user([{ type: 'tool_result', tool_use_id: 't1', content: text }])) + '\n' +
      JSON.stringify(user(text)) + '\n');
    expect(scanExclusionMarkers(filePath)).toBe('marker');
    writeFileSync(filePath, JSON.stringify(user([{ type: 'tool_result', tool_use_id: 't1', content: text }])) + '\n');
    expect(scanExclusionMarkers(filePath)).toBe('clean');
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

  // A transcript can gain the marker after a sync indexed its first exchanges. The next sync copies the file again,
  // because the source is newer. The sync then removes the earlier rows from every table.
  const OTHER = '9f8e7d6c-1111-4222-8333-444455556666';

  function addMarker(sessionId: string): void {
    const source = join(sourceDir, 'project-a', `${sessionId}.jsonl`);
    const line = { type: 'user', uuid: 'u2', parentUuid: 'a1', timestamp: '2025-10-01T12:00:02Z', isSidechain: false, message: { role: 'user', content: `Keep this private. ${DO_NOT_INDEX_MARKER}` } };
    fs.appendFileSync(source, JSON.stringify(line) + '\n');
    // The copy compares times. A later time on the source makes the next sync copy the file again.
    const later = new Date(Date.now() + 60_000);
    fs.utimesSync(source, later, later);
  }

  async function tableCounts(): Promise<{ exchanges: number; vectors: number; text: number }> {
    const { initDatabase } = await import('../src/db.js');
    const db = initDatabase();
    try {
      const count = (table: string) => (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
      return { exchanges: count('exchanges'), vectors: count('vec_exchanges'), text: count('exchanges_fts') };
    } finally {
      db.close();
    }
  }

  it('removes the earlier rows of a transcript that gains the marker, and keeps the rows of the other transcript', async () => {
    writeFileSync(join(sourceDir, 'project-a', `${SESSION}.jsonl`), transcript('A question.'));
    writeFileSync(join(sourceDir, 'project-a', `${OTHER}.jsonl`), transcript('A plain question.'));
    await syncConversations(sourceDir, destDir, { skipSummaries: true });
    expect(indexedRows()).toBe(2);

    addMarker(SESSION);
    const second = await syncConversations(sourceDir, destDir, { skipSummaries: true });
    expect(second.copied).toBe(1);
    expect(second.errors).toEqual([]);
    expect(await tableCounts()).toEqual({ exchanges: 1, vectors: 1, text: 1 });
    const db = new Database(dbPath, { readonly: true });
    try {
      const paths = (db.prepare('SELECT archive_path FROM exchanges').all() as Array<{ archive_path: string }>).map(r => r.archive_path);
      expect(paths).toEqual([join(destDir, 'project-a', `${OTHER}.jsonl`)]);
    } finally {
      db.close();
    }
  });

  it('keeps the rows of a transcript that gains the marker only in a tool result', async () => {
    writeFileSync(join(sourceDir, 'project-a', `${SESSION}.jsonl`), transcript('A question.'));
    await syncConversations(sourceDir, destDir, { skipSummaries: true });
    expect(indexedRows()).toBe(1);

    const source = join(sourceDir, 'project-a', `${SESSION}.jsonl`);
    const line = { type: 'user', uuid: 'u2', parentUuid: 'a1', timestamp: '2025-10-01T12:00:02Z', isSidechain: false,
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: `const MARKER = '${DO_NOT_INDEX_MARKER}';` }] } };
    fs.appendFileSync(source, JSON.stringify(line) + '\n');
    const later = new Date(Date.now() + 60_000);
    fs.utimesSync(source, later, later);
    const second = await syncConversations(sourceDir, destDir, { skipSummaries: true });
    expect(second.copied).toBe(1);
    expect(second.errors).toEqual([]);
    expect(indexedRows()).toBe(1);
  });

  it('keeps the earlier rows of a transcript whose archive copy the scan cannot read (the control)', async () => {
    writeFileSync(join(sourceDir, 'project-a', `${SESSION}.jsonl`), transcript('A question.'));
    await syncConversations(sourceDir, destDir, { skipSummaries: true });
    expect(indexedRows()).toBe(1);

    addMarker(SESSION);
    const archiveCopy = join(destDir, 'project-a', `${SESSION}.jsonl`);
    const realOpen = fs.openSync;
    vi.spyOn(fs, 'openSync').mockImplementation(((file: fs.PathLike, ...rest: unknown[]) => {
      if (String(file) === archiveCopy) {
        throw Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' });
      }
      return (realOpen as (...args: unknown[]) => number)(file, ...rest);
    }) as typeof fs.openSync);
    const second = await syncConversations(sourceDir, destDir, { skipSummaries: true });
    expect(second.errors.map(e => e.file)).toEqual([archiveCopy]);
    expect(indexedRows()).toBe(1);
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
