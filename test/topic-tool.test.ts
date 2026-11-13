import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Database } from '../src/sqlite.js';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { handleToolCall } from '../src/mcp-tools.js';
import { TopicsInputSchema } from '../src/mcp-schemas.js';
import { initDatabase } from '../src/db.js';
import { ensureTopicSchema, installTopicEdit } from '../src/topic-db.js';
import { projectKeyFromCwd } from '../src/digest-inject.js';
import { safeRmSync, suppressConsole } from './test-utils.js';

suppressConsole();

const WORK_V1 =
  '# Work history\n\n## Employment\n\nJoined A in May.[^1]\n^4a8b10cd\n\n' +
  'Moved to B in August to work on [Orion](project.md#^7c91e2ab).[^2]\n^5e6f7a8b\n\n' +
  '[^1]: Time: 2026-05; Sources: #ex-111\n[^2]: Time: 2026-08; Sources: #ex-222\n';

const PROJECT_V1 =
  '# Project\n\n## Orion\n\nOrion is the work on B.[^1]\n^7c91e2ab\n\n' +
  '[^1]: Time: 2026-08-14; Sources: #ex-222\n';

/** Open the index at the test path, create the topic tables and install the documents of `project`. */
function seed(project: string, files: { slug: string; text: string }[]): void {
  const db = initDatabase();
  try {
    ensureTopicSchema(db);
    expect(installTopicEdit(db, project, { files, deletes: [] }, new Map())).toBe('installed');
  } finally {
    db.close();
  }
}

function seedWorkAndProject(): void {
  seed('proj-a', [
    { slug: 'work', text: WORK_V1 },
    { slug: 'project', text: PROJECT_V1 },
  ]);
}

function textOf(result: { content: Array<{ text: string }> }): string {
  return result.content[0].text;
}

/** Run one `topics` call through the server dispatch. */
async function topics(args: Record<string, unknown>): Promise<{ text: string; isError: boolean }> {
  const result = await handleToolCall('topics', args);
  return { text: textOf(result), isError: result.isError === true };
}

describe('topics tool', () => {
  let dir: string;
  const prevToken = process.env.EPISODIC_MEMORY_MCP_TOKEN;
  const prevFlag = process.env.EPISODIC_MEMORY_TOPICS;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'topic-tool-'));
    process.env.TEST_DB_PATH = path.join(dir, 'index.db');
    delete process.env.EPISODIC_MEMORY_MCP_TOKEN;
    // The server never sees the topic flag. The tool must answer the same with the flag unset.
    delete process.env.EPISODIC_MEMORY_TOPICS;
  });

  afterEach(() => {
    delete process.env.TEST_DB_PATH;
    if (prevToken === undefined) delete process.env.EPISODIC_MEMORY_MCP_TOKEN;
    else process.env.EPISODIC_MEMORY_MCP_TOKEN = prevToken;
    if (prevFlag === undefined) delete process.env.EPISODIC_MEMORY_TOPICS;
    else process.env.EPISODIC_MEMORY_TOPICS = prevFlag;
    safeRmSync(dir);
  });

  describe('list', () => {
    it('lists the slug, title and unit count of each document of the project', async () => {
      seedWorkAndProject();
      const r = await topics({ action: 'list', project: 'proj-a' });
      expect(r.isError).toBe(false);
      expect(r.text).toContain('- project: Project (1 units)');
      expect(r.text).toContain('- work: Work history (2 units)');
    });

    it('says so when the project has no documents', async () => {
      seedWorkAndProject();
      const r = await topics({ action: 'list', project: 'nobody' });
      expect(r.text).toContain('No topic documents for nobody.');
    });
  });

  describe('read', () => {
    it('returns the text of the document', async () => {
      seedWorkAndProject();
      const r = await topics({ action: 'read', project: 'proj-a', slug: 'work' });
      expect(r.isError).toBe(false);
      expect(r.text).toBe(WORK_V1);
    });

    it('says so when the document does not exist', async () => {
      seedWorkAndProject();
      const r = await topics({ action: 'read', project: 'proj-a', slug: 'missing' });
      expect(r.text).toContain('No topic document "missing" in proj-a.');
    });

    it('redacts a secret in the document text on the way out', async () => {
      const db = initDatabase();
      ensureTopicSchema(db);
      db.prepare('INSERT INTO topic_doc (project, slug, text, updated_at) VALUES (?, ?, ?, ?)').run(
        'proj-a',
        'leak',
        '# Leak\n\n## S\n\nToken ghp_abcdefghijklmnopqrstuvwxyz0123456789 is here.\n',
        '2026-11-12T00:00:00.000Z'
      );
      db.close();

      const r = await topics({ action: 'read', project: 'proj-a', slug: 'leak' });
      expect(r.text).not.toContain('ghp_abcdefghijklmnopqrstuvwxyz0123456789');
    });
  });

  describe('search', () => {
    it('lists each matching unit with slug, heading, unit id, text and event times', async () => {
      seedWorkAndProject();
      const r = await topics({ action: 'search', project: 'proj-a', query: 'Orion' });
      expect(r.isError).toBe(false);
      const lines = r.text.split('\n').filter(line => line.startsWith('- '));
      expect(lines).toHaveLength(2);
      expect(lines.some(line => line.startsWith('- work | Work history > Employment | unit 5e6f7a8b |') && line.includes('times: 2026-08'))).toBe(true);
      expect(lines.some(line => line.startsWith('- project | Project > Orion | unit 7c91e2ab |') && line.includes('times: 2026-08-14'))).toBe(true);
    });

    it('keeps only units with an event in the range, and lists the times in range', async () => {
      seedWorkAndProject();
      const r = await topics({ action: 'search', project: 'proj-a', query: 'Orion', from: '2026-08-15' });
      expect(r.text).toContain('unit 5e6f7a8b');
      expect(r.text).not.toContain('unit 7c91e2ab');
    });

    it('says so when nothing matches', async () => {
      seedWorkAndProject();
      const r = await topics({ action: 'search', project: 'proj-a', query: 'Japan' });
      expect(r.text).toContain('No topic units match "Japan".');
    });

    it('caps the number of hits at limit', async () => {
      seedWorkAndProject();
      const r = await topics({ action: 'search', project: 'proj-a', query: 'Orion', limit: 1 });
      expect(r.text.split('\n').filter(line => line.startsWith('- '))).toHaveLength(1);
    });
  });

  describe('links', () => {
    it('lists the outgoing links and the backlinks of a unit', async () => {
      seedWorkAndProject();
      const out = await topics({ action: 'links', project: 'proj-a', unit: '5e6f7a8b' });
      expect(out.isError).toBe(false);
      expect(out.text).toMatch(/Outgoing links of 5e6f7a8b:\n- project \| Project > Orion \| unit 7c91e2ab \| /);
      expect(out.text).toMatch(/Backlinks of 5e6f7a8b:\n- none/);

      const back = await topics({ action: 'links', project: 'proj-a', unit: '7c91e2ab' });
      expect(back.text).toMatch(/Backlinks of 7c91e2ab:\n- work \| Work history > Employment \| unit 5e6f7a8b \| /);
    });
  });

  describe('timeline', () => {
    it('lists the events in time order with statement, unit and source ids', async () => {
      seedWorkAndProject();
      const r = await topics({ action: 'timeline', project: 'proj-a' });
      expect(r.isError).toBe(false);
      const lines = r.text.split('\n').filter(line => line.startsWith('- '));
      expect(lines).toHaveLength(3);
      expect(lines[0].startsWith('- 2026-05 | Joined A in May. | unit 4a8b10cd | sources: #ex-111')).toBe(true);
      expect(lines[1]).toMatch(/^- 2026-08 \| Moved to B .* \| unit 5e6f7a8b \| sources: #ex-222$/);
      expect(lines[2].startsWith('- 2026-08-14 | Orion is the work on B. | unit 7c91e2ab | sources: #ex-222')).toBe(true);
    });

    it('keeps the events that overlap the range', async () => {
      seedWorkAndProject();
      const r = await topics({ action: 'timeline', project: 'proj-a', from: '2026-08-10' });
      const lines = r.text.split('\n').filter(line => line.startsWith('- '));
      expect(lines).toHaveLength(2);
      expect(r.text).not.toContain('Joined A in May.');
    });

    it('says so when no event is in the range', async () => {
      seedWorkAndProject();
      const r = await topics({ action: 'timeline', project: 'proj-a', from: '2026-06', to: '2026-07' });
      expect(r.text).toContain('No timeline events for proj-a.');
    });
  });

  describe('fixer findings', () => {
    const SECRET = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789';
    const LEAKY =
      `# Leak ${SECRET}\n\n## Heading ${SECRET}\n\nToken ${SECRET} sits with [Orion](project.md#^7c91e2ab).[^1]\n^1a2b3c4d\n\n` +
      `[^1]: Time: 2026-09; Sources: #ex-333; Statement ${SECRET}\n`;

    it('redacts a secret in the output of every action', async () => {
      seed('proj-a', [
        { slug: 'project', text: PROJECT_V1 },
        { slug: 'leak', text: LEAKY },
      ]);
      const calls: Record<string, unknown>[] = [
        { action: 'list' },
        { action: 'read', slug: 'leak' },
        { action: 'search', query: 'Token' },
        { action: 'links', unit: '7c91e2ab' },
        { action: 'links', unit: '1a2b3c4d' },
        { action: 'timeline' },
      ];
      for (const args of calls) {
        const r = await topics({ ...args, project: 'proj-a' });
        expect(r.isError, JSON.stringify(args)).toBe(false);
        expect(r.text, JSON.stringify(args)).not.toContain(SECRET);
      }
      // The secret really reached each action: the redaction mark shows where it was.
      const search = await topics({ action: 'search', query: 'Token', project: 'proj-a' });
      expect(search.text).toContain('1a2b3c4d');
    });

    it('leaves the index file byte-identical after every action', async () => {
      seedWorkAndProject();
      const file = process.env.TEST_DB_PATH!;
      // A rollback journal makes any writer open visible: initDatabase switches the file to WAL.
      const raw = new Database(file);
      raw.pragma('journal_mode = DELETE');
      raw.close();
      const before = fs.readFileSync(file);
      const mtime = fs.statSync(file).mtimeMs;
      for (const args of [
        { action: 'list' },
        { action: 'read', slug: 'work' },
        { action: 'search', query: 'Orion' },
        { action: 'links', unit: '5e6f7a8b' },
        { action: 'timeline' },
      ]) {
        await topics({ ...args, project: 'proj-a' });
      }
      expect(fs.readFileSync(file).equals(before)).toBe(true);
      expect(fs.statSync(file).mtimeMs).toBe(mtime);
    });

    it('caps the timeline at limit and says how many events it left out', async () => {
      seedWorkAndProject();
      const r = await topics({ action: 'timeline', project: 'proj-a', limit: 2 });
      const lines = r.text.split('\n').filter(line => line.startsWith('- '));
      expect(lines).toHaveLength(2);
      expect(r.text).toContain('1 more event');
    });

    it('caps the timeline at 50 events by default', async () => {
      const units = Array.from({ length: 60 }, (_, i) => {
        const id = (0x10000000 + i).toString(16);
        return `Event ${i}.[^${i + 1}]\n^${id}\n`;
      });
      const notes = Array.from({ length: 60 }, (_, i) => `[^${i + 1}]: Time: 2026-01-${String((i % 28) + 1).padStart(2, '0')}; Sources: #ex-${i}`);
      seed('proj-a', [{ slug: 'many', text: `# Many\n\n## S\n\n${units.join('\n')}\n${notes.join('\n')}\n` }]);
      const r = await topics({ action: 'timeline', project: 'proj-a' });
      expect(r.text.split('\n').filter(line => line.startsWith('- '))).toHaveLength(50);
      expect(r.text).toContain('10 more events');
    });

    it('says so when the unit of a links call does not exist', async () => {
      seedWorkAndProject();
      const r = await topics({ action: 'links', project: 'proj-a', unit: 'deadbeef' });
      expect(r.isError).toBe(false);
      expect(r.text).toBe('No topic unit "deadbeef" in proj-a.');
    });
  });

  describe('project default', () => {
    it('reads the project of the working directory when project is omitted', async () => {
      const cwdKey = projectKeyFromCwd(process.cwd());
      seed(cwdKey, [{ slug: 'cwd-doc', text: '# Cwd\n\n## S\n\nHere.[^1]\n^1a2b3c4d\n\n[^1]: Time: 2026; Sources: #ex-9\n' }]);
      seed('proj-a', [{ slug: 'work', text: WORK_V1 }]);

      const r = await topics({ action: 'list' });
      expect(r.text).toContain('- cwd-doc: Cwd (1 units)');
      expect(r.text).not.toContain('- work:');
    });
  });

  describe('no topic tables', () => {
    it('answers that topic memory has no documents yet, for every action, and creates no topic table', async () => {
      // An index with no topic tables: open it the way the server does, then close it.
      initDatabase().close();

      const calls: Record<string, unknown>[] = [
        { action: 'list', project: 'proj-a' },
        { action: 'read', project: 'proj-a', slug: 'work' },
        { action: 'search', project: 'proj-a', query: 'Orion' },
        { action: 'links', project: 'proj-a', unit: '5e6f7a8b' },
        { action: 'timeline', project: 'proj-a' },
      ];
      for (const args of calls) {
        const r = await topics(args);
        expect(r.isError).toBe(false);
        expect(r.text).toBe('Topic memory has no documents yet.');
      }

      const db = new Database(process.env.TEST_DB_PATH!, { readonly: true, fileMustExist: true });
      try {
        const names = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'topic%'").all() as {
          name: string;
        }[]).map(row => row.name);
        expect(names).toEqual([]);
      } finally {
        db.close();
      }
    });

    it('creates no index file on a fresh install', async () => {
      expect(fs.existsSync(process.env.TEST_DB_PATH!)).toBe(false);
      const r = await topics({ action: 'list', project: 'proj-a' });
      expect(r.isError).toBe(false);
      expect(r.text).toBe('Topic memory has no documents yet.');
      expect(fs.existsSync(process.env.TEST_DB_PATH!)).toBe(false);
      expect(fs.existsSync(process.env.TEST_DB_PATH! + '-wal')).toBe(false);
    });

    it('never reads a topic table that is missing, even when only some topic tables exist', async () => {
      const db = initDatabase();
      ensureTopicSchema(db);
      db.exec('DROP TABLE topic_link');
      db.close();

      const r = await topics({ action: 'links', project: 'proj-a', unit: '5e6f7a8b' });
      expect(r.isError).toBe(false);
      expect(r.text).toBe('Topic memory has no documents yet.');
    });
  });

  describe('schema', () => {
    it('refuses a range whose from is after its to, and accepts equal bounds and mixed precision', () => {
      for (const action of ['timeline', 'search'] as const) {
        const base = action === 'search' ? { action, query: 'x' } : { action };
        const bad = TopicsInputSchema.safeParse({ ...base, from: '2026-08', to: '2026-05' });
        expect(bad.success).toBe(false);
        if (!bad.success) expect(bad.error.issues[0].path).toEqual(['to']);
        expect(TopicsInputSchema.safeParse({ ...base, from: '2026-08', to: '2026-08' }).success).toBe(true);
        expect(TopicsInputSchema.safeParse({ ...base, from: '2026', to: '2026-03-04' }).success).toBe(true);
        expect(TopicsInputSchema.safeParse({ ...base, from: '2026-08-31', to: '2026-08' }).success).toBe(true);
      }
    });

    it('refuses an unknown argument', async () => {
      seedWorkAndProject();
      const r = await topics({ action: 'list', project: 'proj-a', nope: 1 });
      expect(r.isError).toBe(true);
      expect(r.text).toMatch(/^Error:/);
    });

    it('refuses an unknown action', async () => {
      const r = await topics({ action: 'write' });
      expect(r.isError).toBe(true);
    });

    it('refuses a call with no action', async () => {
      const r = await topics({ project: 'proj-a' });
      expect(r.isError).toBe(true);
    });

    it('refuses a read with no slug, as a schema error that names the field', async () => {
      const r = await topics({ action: 'read', project: 'proj-a' });
      expect(r.isError).toBe(true);
      expect(r.text).toMatch(/^Error:/);
      expect(r.text).toContain('"slug"');
    });

    it('refuses a search with no query, as a schema error that names the field', async () => {
      const r = await topics({ action: 'search', project: 'proj-a' });
      expect(r.isError).toBe(true);
      expect(r.text).toContain('"query"');
    });

    it('refuses a links call with no unit, as a schema error that names the field', async () => {
      const r = await topics({ action: 'links', project: 'proj-a' });
      expect(r.isError).toBe(true);
      expect(r.text).toContain('"unit"');
    });

    it('refuses a unit that is not 8 lowercase hex characters', async () => {
      for (const unit of ['5E6F7A8B', '5e6f7a8', '5e6f7a8g', '5e6f7a8b9']) {
        const r = await topics({ action: 'links', project: 'proj-a', unit });
        expect(r.isError).toBe(true);
      }
    });

    it('refuses a from bound that is not a valid time', async () => {
      const bad = ['2026-13', '2026-02-30', '2026-8', 'August'];
      for (const from of bad) {
        const r = await topics({ action: 'timeline', project: 'proj-a', from });
        expect(r.isError).toBe(true);
        expect(r.text).toContain('"from"');
      }
    });

    it('refuses a to bound that is not a valid time', async () => {
      const r = await topics({ action: 'search', project: 'proj-a', query: 'Orion', to: '2026-13' });
      expect(r.isError).toBe(true);
      expect(r.text).toContain('"to"');
    });

    it('accepts a from bound of YYYY, YYYY-MM or YYYY-MM-DD', () => {
      for (const from of ['2026', '2026-08', '2026-08-14']) {
        expect(TopicsInputSchema.safeParse({ action: 'timeline', from }).success).toBe(true);
      }
    });

    it('refuses a limit outside 1 to 50', async () => {
      for (const limit of [0, 51]) {
        const r = await topics({ action: 'search', project: 'proj-a', query: 'Orion', limit });
        expect(r.isError).toBe(true);
      }
    });

    it('answers from the tables with the topic flag unset', async () => {
      seedWorkAndProject();
      const r = await topics({ action: 'read', project: 'proj-a', slug: 'work' });
      expect(r.text).toBe(WORK_V1);
    });
  });
});

describe('topic-tool import boundary', () => {
  const readSource = (): string => fs.readFileSync(fileURLToPath(new URL('../src/topic-tool.ts', import.meta.url)), 'utf-8');

  /** Every module the file names: static imports, re-exports and dynamic imports. */
  function specifiers(text: string): string[] {
    const found: string[] = [];
    for (const m of text.matchAll(/(?:^|\n)\s*(?:import|export)\s[^'"]*?\sfrom\s+['"]([^'"]+)['"]/g)) found.push(m[1]);
    for (const m of text.matchAll(/(?:^|\n)\s*import\s+['"]([^'"]+)['"]/g)) found.push(m[1]);
    for (const m of text.matchAll(/import\(\s*['"]([^'"]+)['"]\s*\)/g)) found.push(m[1]);
    return found;
  }

  it('reads only the read modules, the index opener and the pure helpers', () => {
    const allowed = new Set([
      'fs',
      './topic-db.js',
      './digest-inject.js',
      './digest-validate.js',
      './db.js',
      './paths.js',
      './mcp-schemas.js',
    ]);
    const names = specifiers(readSource());
    expect(names.length).toBeGreaterThan(0);
    for (const name of names) expect(allowed.has(name), `unexpected import ${name}`).toBe(true);
  });

  it('keeps the document parser out of the schema module, so the server does not load it at start', () => {
    const schemaSource = fs.readFileSync(
      path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'mcp-schemas.ts'),
      'utf8'
    );
    const names = specifiers(schemaSource);
    expect(names).toContain('./topic-time.js');
    expect(names).not.toContain('./topic-format.js');
  });

  it('never imports the write path, the summarizer, the Claude SDK or the GPU check', () => {
    const forbidden = [
      'topic-job',
      'topic-phase',
      'summarizer',
      'ollama-backend',
      'digest-job',
      'digest-phase',
      'gpu-reservation',
      'claude-agent-sdk',
      'topic-prompts',
    ];
    const names = specifiers(readSource());
    for (const word of forbidden) {
      for (const name of names) expect(name, `forbidden import ${word}`).not.toContain(word);
    }
  });

  it('never calls a write function', () => {
    const source = readSource();
    for (const word of [
      'ensureTopicSchema',
      'installTopicEdit',
      'setTopicMeta',
      'recordTopicFailedCall',
      'setTopicSessionStatus',
    ]) {
      expect(source.includes(word), `write call ${word}`).toBe(false);
    }
  });
});
