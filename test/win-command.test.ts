import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { commandInvocation, findWindowsCommand } from '../src/win-command.js';
import { safeRmSync } from './test-utils.js';

describe('commandInvocation', () => {
  let bin: string;

  beforeEach(() => {
    bin = mkdtempSync(join(tmpdir(), 'em-wincmd-'));
  });
  afterEach(() => safeRmSync(bin));

  it('changes nothing outside Windows', () => {
    writeFileSync(join(bin, 'codex.cmd'), '');
    expect(commandInvocation('codex', ['--version'], { PATH: bin }, 'linux')).toEqual({
      file: 'codex', args: ['--version'], windowsVerbatimArguments: false,
    });
  });

  it('runs a .cmd shim found by PATH and PATHEXT through cmd.exe, with the path quoted', () => {
    writeFileSync(join(bin, 'codex.cmd'), '');
    const run = commandInvocation('codex', ['mcp', 'list'], { Path: bin, PATHEXT: '.EXE;.CMD', ComSpec: 'C:\\cmd.exe' }, 'win32');
    expect(run.file).toBe('C:\\cmd.exe');
    // Windows matches a file name without regard to case, so the found name carries the PATHEXT spelling.
    expect(run.args.slice(0, 3)).toEqual(['/d', '/s', '/c']);
    expect(run.args[3].toLowerCase()).toBe(`""${join(bin, 'codex.cmd')}" mcp list"`.toLowerCase());
    expect(run.windowsVerbatimArguments).toBe(true);
  });

  it('prefers the PATHEXT order and spawns an .exe directly', () => {
    writeFileSync(join(bin, 'codex.cmd'), '');
    writeFileSync(join(bin, 'codex.exe'), '');
    const run = commandInvocation('codex', ['--version'], { PATH: bin, PATHEXT: '.EXE;.CMD' }, 'win32');
    expect(run.file.toLowerCase()).toBe(join(bin, 'codex.exe').toLowerCase());
    expect(run.args).toEqual(['--version']);
    expect(run.windowsVerbatimArguments).toBe(false);
  });

  it('returns a command it cannot find unchanged, so the spawn fails with ENOENT as before', () => {
    expect(commandInvocation('codex', ['--version'], { PATH: bin }, 'win32').file).toBe('codex');
    expect(findWindowsCommand('codex', { PATH: bin })).toBeUndefined();
  });

  it('refuses an argument that cmd.exe would read as syntax, instead of quoting it', () => {
    writeFileSync(join(bin, 'codex.cmd'), '');
    for (const arg of ['a b', 'x&calc', '%PATH%', '"q"', '']) {
      expect(() => commandInvocation('codex', [arg], { PATH: bin }, 'win32'), arg).toThrow(/refusing to pass/);
    }
  });

  it('checks a path with a directory part as given', () => {
    const shim = join(bin, 'codex.cmd');
    writeFileSync(shim, '');
    expect(findWindowsCommand(shim, { PATH: '' })).toBe(shim);
    expect(findWindowsCommand(join(bin, 'codex'), { PATH: '', PATHEXT: '.CMD' })?.toLowerCase()).toBe(shim.toLowerCase());
  });
});
