import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import {
  resolveArchiveJsonlPath,
  readJsonlLines,
  DEFAULT_MAX_READ_BYTES,
} from '../src/archive-path.js';
import { safeRmSync } from './test-utils.js';

describe('archive-path confinement', () => {
  let testDir: string;
  let archiveDir: string;
  let outsideDir: string;

  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'em-archive-path-'));
    archiveDir = path.join(testDir, 'archive');
    outsideDir = path.join(testDir, 'outside');
    fs.mkdirSync(archiveDir, { recursive: true });
    fs.mkdirSync(outsideDir, { recursive: true });
    process.env.TEST_ARCHIVE_DIR = archiveDir;
    process.env.EPISODIC_MEMORY_CONFIG_DIR = path.join(testDir, 'config');
  });

  afterEach(() => {
    delete process.env.TEST_ARCHIVE_DIR;
    delete process.env.EPISODIC_MEMORY_CONFIG_DIR;
    delete process.env.EPISODIC_MEMORY_MAX_READ_BYTES;
    safeRmSync(testDir);
  });

  it('accepts a real .jsonl file inside the archive', () => {
    const file = path.join(archiveDir, 'proj', 'session.jsonl');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '{"type":"user"}\n', 'utf-8');

    const resolved = resolveArchiveJsonlPath(file);
    expect(path.normalize(resolved)).toBe(path.normalize(fs.realpathSync(file)));
  });

  it('rejects paths outside the archive', () => {
    const outside = path.join(outsideDir, 'secret.jsonl');
    fs.writeFileSync(outside, 'secret\n', 'utf-8');
    expect(() => resolveArchiveJsonlPath(outside)).toThrow(/outside the conversation archive/);
  });

  it('rejects non-jsonl files inside the archive', () => {
    const file = path.join(archiveDir, 'notes.txt');
    fs.writeFileSync(file, 'hi\n', 'utf-8');
    expect(() => resolveArchiveJsonlPath(file)).toThrow(/\.jsonl/);
  });

  it('rejects symlink escapes that point outside the archive', () => {
    const secret = path.join(outsideDir, 'id_rsa');
    fs.writeFileSync(secret, 'PRIVATE KEY\n', 'utf-8');
    const link = path.join(archiveDir, 'escape.jsonl');
    try {
      fs.symlinkSync(secret, link);
    } catch (err: any) {
      // Some CI images disallow symlinks; skip rather than fail the suite.
      if (err?.code === 'EPERM' || err?.code === 'EACCES') return;
      throw err;
    }
    expect(() => resolveArchiveJsonlPath(link)).toThrow(/symlink escape|outside the conversation archive/);
  });

  it('streams a line range without loading the whole file', async () => {
    const file = path.join(archiveDir, 'big.jsonl');
    const lines = Array.from({ length: 20 }, (_, i) => JSON.stringify({ n: i + 1 }));
    fs.writeFileSync(file, lines.join('\n') + '\n', 'utf-8');

    const slice = await readJsonlLines(file, 3, 5);
    const parsed = slice.split('\n').map((l) => JSON.parse(l));
    expect(parsed).toEqual([{ n: 3 }, { n: 4 }, { n: 5 }]);
  });

  it('rejects oversized full reads past the byte cap', async () => {
    process.env.EPISODIC_MEMORY_MAX_READ_BYTES = '64';
    const file = path.join(archiveDir, 'huge.jsonl');
    fs.writeFileSync(file, 'x'.repeat(200) + '\n', 'utf-8');
    await expect(readJsonlLines(file)).rejects.toThrow(/MCP read cap/);
    expect(DEFAULT_MAX_READ_BYTES).toBeGreaterThan(0);
  });
});
