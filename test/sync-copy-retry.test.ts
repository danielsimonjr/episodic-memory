import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import { spawn, type ChildProcess } from 'child_process';
import { join } from 'path';
import { tmpdir } from 'os';
import { syncConversations, ARCHIVE_RENAME_ATTEMPTS } from '../src/sync.js';
import { renameWithRetry, RETRY_ATTEMPTS } from '../src/fs-retry.js';
import { suppressConsole, safeRmSync } from './test-utils.js';

/** An error with the `code` of a Node file-system error. */
function fsError(code: string): NodeJS.ErrnoException {
  const error = new Error(`${code}: operation failed, rename`) as NodeJS.ErrnoException;
  error.code = code;
  return error;
}

/**
 * Make `fs.renameSync` throw `code` for the first `failures` calls that `match` selects.
 * Every other call goes to the real function.
 */
function failRenames(code: string, failures: number, match: (from: string) => boolean = () => true) {
  const real = fs.renameSync;
  let calls = 0;
  return vi.spyOn(fs, 'renameSync').mockImplementation(((from: fs.PathLike, to: fs.PathLike) => {
    if (!match(String(from))) return real(from, to);
    calls += 1;
    if (calls <= failures) throw fsError(code);
    return real(from, to);
  }) as typeof fs.renameSync);
}

let testDir: string;
let restoreConsole: () => void;

beforeEach(() => {
  testDir = fs.mkdtempSync(join(tmpdir(), 'em-copy-retry-'));
  restoreConsole = suppressConsole();
});

afterEach(() => {
  vi.restoreAllMocks();
  restoreConsole();
  safeRmSync(testDir);
});

describe('renameWithRetry', () => {
  it('retries EPERM and EBUSY, then renames', () => {
    for (const code of ['EPERM', 'EBUSY']) {
      const from = join(testDir, `from-${code}`);
      const to = join(testDir, `to-${code}`);
      fs.writeFileSync(from, code);
      const spy = failRenames(code, 2);
      renameWithRetry(from, to);
      expect(spy).toHaveBeenCalledTimes(3);
      expect(fs.readFileSync(to, 'utf-8')).toBe(code);
      vi.restoreAllMocks();
    }
  });

  it('rethrows the last sharing violation after every attempt fails', () => {
    const spy = failRenames('EPERM', Number.POSITIVE_INFINITY);
    expect(() => renameWithRetry(join(testDir, 'a'), join(testDir, 'b'))).toThrow(/EPERM/);
    expect(spy).toHaveBeenCalledTimes(RETRY_ATTEMPTS);
  });

  it('rethrows any other error at once', () => {
    const spy = failRenames('ENOENT', 1);
    expect(() => renameWithRetry(join(testDir, 'a'), join(testDir, 'b'))).toThrow(/ENOENT/);
    expect(spy).toHaveBeenCalledTimes(1);
  });
});

describe('syncConversations copy', () => {
  /** True for the rename of the temporary copy that `copyIfNewer` writes. */
  const isTempCopy = (from: string) => from.includes('.tmp.');

  function setUp(): { projects: string; archive: string; source: string } {
    const projects = join(testDir, 'projects');
    const archive = join(testDir, 'archive');
    fs.mkdirSync(join(projects, 'project-a'), { recursive: true });
    fs.mkdirSync(archive, { recursive: true });
    const source = join(projects, 'project-a', 'session-1.jsonl');
    fs.writeFileSync(source, '{"type":"user"}\n');
    return { projects, archive, source };
  }

  /** The temporary copy files that `copyIfNewer` left in the archive. */
  function tempFiles(archive: string): string[] {
    return fs.readdirSync(join(archive, 'project-a')).filter(name => name.includes('.tmp.'));
  }

  it('copies a transcript when the archive file is held open for a moment', async () => {
    const { projects, archive, source } = setUp();
    failRenames('EPERM', 2, isTempCopy);
    const result = await syncConversations(projects, archive, { skipIndex: true, skipSummaries: true });
    expect(result.errors).toEqual([]);
    expect(result.copied).toBe(1);
    expect(fs.readFileSync(join(archive, 'project-a', 'session-1.jsonl'), 'utf-8')).toBe(fs.readFileSync(source, 'utf-8'));
    expect(tempFiles(archive)).toEqual([]);
  });

  it('records one error and leaves no temporary file when the archive file stays locked', async () => {
    const { projects, archive, source } = setUp();
    const spy = failRenames('EPERM', Number.POSITIVE_INFINITY, isTempCopy);
    const result = await syncConversations(projects, archive, { skipIndex: true, skipSummaries: true });
    expect(result.copied).toBe(0);
    expect(spy).toHaveBeenCalledTimes(ARCHIVE_RENAME_ATTEMPTS);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].error).toMatch(/EPERM/);
    expect(result.errors[0].error).toMatch(/the next sync copies the file again/);
    expect(tempFiles(archive)).toEqual([]);

    // The archive copy keeps its older time, so the next sync copies the file again.
    vi.restoreAllMocks();
    const next = await syncConversations(projects, archive, { skipIndex: true, skipSummaries: true });
    expect(next.errors).toEqual([]);
    expect(next.copied).toBe(1);
    expect(fs.readFileSync(join(archive, 'project-a', 'session-1.jsonl'), 'utf-8')).toBe(fs.readFileSync(source, 'utf-8'));
  });

  it('reports any other rename error with its own text', async () => {
    const { projects, archive } = setUp();
    const spy = failRenames('ENOSPC', Number.POSITIVE_INFINITY, isTempCopy);
    const result = await syncConversations(projects, archive, { skipIndex: true, skipSummaries: true });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].error).toMatch(/ENOSPC/);
    expect(result.errors[0].error).not.toMatch(/archive copy open/);
    expect(tempFiles(archive)).toEqual([]);
  });

  it('waits longer than one second for the archive copy while a reader holds it open', async () => {
    // On Windows an open handle on the archive copy makes the replace by renameSync fail with EPERM.
    // A reader in another process holds the copy for 1 s. The 1 s is longer than the 300 ms of the default retries.
    // On Linux and macOS the rename does not wait for a reader, so this test passes there at once.
    const { projects, archive, source } = setUp();
    const first = await syncConversations(projects, archive, { skipIndex: true, skipSummaries: true });
    expect(first.copied).toBe(1);
    fs.appendFileSync(source, '{"type":"assistant"}\n');
    const later = new Date(Date.now() + 60_000);
    fs.utimesSync(source, later, later);

    const copy = join(archive, 'project-a', 'session-1.jsonl');
    const holder: ChildProcess = spawn(process.execPath, [
      '-e',
      "const fs=require('fs');const fd=fs.openSync(process.argv[1],'r');" +
        "process.stdout.write('ready\\n');setTimeout(()=>{fs.closeSync(fd);process.exit(0);},1000);",
      copy,
    ]);
    const exited = new Promise<void>(resolve => holder.on('exit', () => resolve()));
    try {
      await new Promise<void>((resolve, reject) => {
        holder.stdout!.on('data', chunk => { if (String(chunk).includes('ready')) resolve(); });
        holder.on('error', reject);
      });
      const result = await syncConversations(projects, archive, { skipIndex: true, skipSummaries: true });
      expect(result.errors).toEqual([]);
      expect(result.copied).toBe(1);
      expect(fs.readFileSync(copy, 'utf-8')).toBe(fs.readFileSync(source, 'utf-8'));
      expect(tempFiles(archive)).toEqual([]);
    } finally {
      await exited;
    }
  });
});
