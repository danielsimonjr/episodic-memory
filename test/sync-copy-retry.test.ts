import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { syncConversations } from '../src/sync.js';
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
    const { projects, archive } = setUp();
    failRenames('EPERM', Number.POSITIVE_INFINITY, isTempCopy);
    const result = await syncConversations(projects, archive, { skipIndex: true, skipSummaries: true });
    expect(result.copied).toBe(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].error).toMatch(/EPERM/);
    expect(tempFiles(archive)).toEqual([]);
  });
});
