import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import {
  maxReadBytes,
  DEFAULT_MAX_READ_BYTES,
  resolveArchiveJsonlPath,
  safeArchiveSummaryPath,
  readJsonlLines,
} from '../src/archive-path.js';
import { safeRmSync } from './test-utils.js';

describe('archive-path edge cases', () => {
  let testDir: string;
  let archiveDir: string;

  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'em-archive-edges-'));
    archiveDir = path.join(testDir, 'archive');
    fs.mkdirSync(archiveDir, { recursive: true });
    process.env.TEST_ARCHIVE_DIR = archiveDir;
    process.env.EPISODIC_MEMORY_CONFIG_DIR = path.join(testDir, 'config');
    delete process.env.EPISODIC_MEMORY_MAX_READ_BYTES;
  });

  afterEach(() => {
    delete process.env.TEST_ARCHIVE_DIR;
    delete process.env.EPISODIC_MEMORY_CONFIG_DIR;
    delete process.env.EPISODIC_MEMORY_MAX_READ_BYTES;
    safeRmSync(testDir);
  });

  it('parses MAX_READ_BYTES and falls back on garbage', () => {
    expect(maxReadBytes()).toBe(DEFAULT_MAX_READ_BYTES);
    process.env.EPISODIC_MEMORY_MAX_READ_BYTES = '128';
    expect(maxReadBytes()).toBe(128);
    process.env.EPISODIC_MEMORY_MAX_READ_BYTES = 'nope';
    expect(maxReadBytes()).toBe(DEFAULT_MAX_READ_BYTES);
  });

  it('rejects empty, missing, and directory paths', () => {
    expect(() => resolveArchiveJsonlPath('')).toThrow(/required/);
    const missing = path.join(archiveDir, 'gone.jsonl');
    expect(() => resolveArchiveJsonlPath(missing)).toThrow(/File not found/);
    const dir = path.join(archiveDir, 'subdir.jsonl');
    fs.mkdirSync(dir);
    expect(() => resolveArchiveJsonlPath(dir)).toThrow(/not a file/);
  });

  it('safeArchiveSummaryPath returns null for empty, non-jsonl, and missing sidecars', () => {
    expect(safeArchiveSummaryPath('')).toBeNull();
    const file = path.join(archiveDir, 'session.jsonl');
    fs.writeFileSync(file, '{}\n', 'utf-8');
    expect(safeArchiveSummaryPath(file)).toBeNull();
    expect(safeArchiveSummaryPath(path.join(archiveDir, 'notes.txt'))).toBeNull();
  });

  it('rejects inverted line ranges and caps ranged reads', async () => {
    const file = path.join(archiveDir, 'lines.jsonl');
    fs.writeFileSync(file, 'a\nb\nc\n', 'utf-8');
    await expect(readJsonlLines(file, 5, 2)).rejects.toThrow(/endLine/);

    process.env.EPISODIC_MEMORY_MAX_READ_BYTES = '4';
    await expect(readJsonlLines(file, 1, 20)).rejects.toThrow(/MCP read cap/);
  });
});
