import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { spawnSync } from 'child_process';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  CLAUDE_BIN_ENV,
  ClaudeBinError,
  claudeExecutableOption,
  probeClaudeBin,
  sdkFloor,
  bundledBinaryPresent,
} from '../src/claude-bin.js';

const SDK = '@anthropic-ai/claude-agent-sdk';
const FLOOR = '2.1.299';
const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'em-claude-bin-'));
  roots.push(d);
  return d;
}

/** A fake node_modules with the SDK manifest and, optionally, one platform package. */
function fakeSdk(opts: { floor?: string; platformPackage?: string; exe?: string } = {}): string {
  const nm = join(tempDir(), 'node_modules');
  const sdk = join(nm, ...SDK.split('/'));
  mkdirSync(sdk, { recursive: true });
  writeFileSync(join(sdk, 'package.json'), JSON.stringify({ name: SDK, version: '0.3.299' }));
  writeFileSync(join(sdk, 'manifest.json'), JSON.stringify({ version: opts.floor ?? FLOOR }));
  if (opts.platformPackage) {
    const pp = join(nm, '@anthropic-ai', opts.platformPackage);
    mkdirSync(pp, { recursive: true });
    writeFileSync(join(pp, 'package.json'), JSON.stringify({ name: `@anthropic-ai/${opts.platformPackage}` }));
    writeFileSync(join(pp, opts.exe ?? 'claude'), 'binary');
  }
  return sdk;
}

/** A fake Claude Code executable: a .mjs file that prints `out` and exits with `code`. */
function fakeBin(out: string, opts: { code?: number; sleepMs?: number; ext?: string } = {}): string {
  const p = join(tempDir(), `claude${opts.ext ?? '.mjs'}`);
  const body = opts.sleepMs
    ? `setTimeout(() => {}, ${opts.sleepMs});`
    : `process.stdout.write(${JSON.stringify(out)}); process.exitCode = ${opts.code ?? 0};`;
  writeFileSync(p, body);
  return p;
}

const quiet = () => vi.spyOn(console, 'error').mockImplementation(() => {});

describe('sdkFloor', () => {
  it('reads the version of the SDK manifest', () => {
    expect(sdkFloor(fakeSdk({ floor: '2.1.299' }))).toBe('2.1.299');
  });

  it('refuses a manifest without a three-part version', () => {
    quiet();
    expect(() => sdkFloor(fakeSdk({ floor: 'next' }))).toThrow(ClaudeBinError);
  });
});

describe('bundledBinaryPresent', () => {
  it('finds the platform package of the running platform', () => {
    const exe = process.platform === 'win32' ? 'claude.exe' : 'claude';
    const sdk = fakeSdk({ platformPackage: `claude-agent-sdk-${process.platform}-${process.arch}`, exe });
    expect(bundledBinaryPresent(sdk, process.platform, process.arch)).toBe(true);
  });

  it('accepts the musl package on linux, as the SDK does', () => {
    const sdk = fakeSdk({ platformPackage: 'claude-agent-sdk-linux-x64-musl' });
    expect(bundledBinaryPresent(sdk, 'linux', 'x64')).toBe(true);
  });

  it('reports false when no platform package is installed', () => {
    expect(bundledBinaryPresent(fakeSdk(), 'linux', 'x64')).toBe(false);
  });

  it('looks for claude.exe on win32', () => {
    const sdk = fakeSdk({ platformPackage: 'claude-agent-sdk-win32-x64', exe: 'claude' });
    expect(bundledBinaryPresent(sdk, 'win32', 'x64')).toBe(false);
  });
});

describe('probeClaudeBin', () => {
  it('passes a binary at the floor version', () => {
    expect(probeClaudeBin(fakeBin('2.1.299 (Claude Code)\n'), FLOOR)).toBe('2.1.299');
  });

  it('passes a binary above the floor, comparing each part as a number', () => {
    expect(probeClaudeBin(fakeBin('2.1.1000 (Claude Code)\n'), FLOOR)).toBe('2.1.1000');
  });

  it('fails a binary one step below the floor, and the error names the path, the version and the floor', () => {
    quiet();
    const bin = fakeBin('2.1.298 (Claude Code)\n');
    const run = () => probeClaudeBin(bin, FLOOR);
    expect(run).toThrow(ClaudeBinError);
    expect(run).toThrow(/2\.1\.298.*2\.1\.299/);
    try { run(); } catch (e) { expect((e as ClaudeBinError).detail).toContain(bin); }
  });

  it('fails a binary that sleeps past the timeout', () => {
    quiet();
    expect(() => probeClaudeBin(fakeBin('', { sleepMs: 30000 }), FLOOR, { timeoutMs: 500 })).toThrow(/timed out after 500 ms/);
  });

  it('fails a path that does not exist', () => {
    quiet();
    expect(() => probeClaudeBin(join(tempDir(), 'missing.exe'), FLOOR)).toThrow(/does not exist/);
  });

  it('rejects a .cmd shim, a .ps1 shim and a .ts script without running them', () => {
    quiet();
    const spawn = vi.fn();
    for (const ext of ['.cmd', '.ps1', '.ts']) {
      const bin = fakeBin('2.1.299', { ext });
      expect(() => probeClaudeBin(bin, FLOOR, { spawn: spawn as unknown as typeof spawnSync })).toThrow(ClaudeBinError);
    }
    expect(spawn).not.toHaveBeenCalled();
  });

  it('rejects a relative path, because the variable has no PATH lookup', () => {
    quiet();
    expect(() => probeClaudeBin('claude', FLOOR)).toThrow(/absolute path/);
  });

  it('fails a binary that exits non-zero, and one that prints no version', () => {
    quiet();
    expect(() => probeClaudeBin(fakeBin('2.1.299', { code: 3 }), FLOOR)).toThrow(/exit code 3/);
    expect(() => probeClaudeBin(fakeBin('Claude Code'), FLOOR)).toThrow(/no version/);
  });

  it('runs a .mjs path under the running node, with stdout piped', () => {
    const calls: unknown[][] = [];
    const spawn = ((...args: unknown[]) => {
      calls.push(args);
      return (spawnSync as (...a: unknown[]) => unknown)(...args);
    }) as unknown as typeof spawnSync;
    const bin = fakeBin('2.1.299\n');
    probeClaudeBin(bin, FLOOR, { spawn });
    expect(calls[0][0]).toBe(process.execPath);
    expect(calls[0][1]).toEqual([bin, '--version']);
    expect((calls[0][2] as { stdio: unknown }).stdio).toEqual(['ignore', 'pipe', 'pipe']);
  });
});

describe('claudeExecutableOption', () => {
  const platformPackage = `claude-agent-sdk-${process.platform}-${process.arch}`;
  const exe = process.platform === 'win32' ? 'claude.exe' : 'claude';

  it('returns no executable option and runs no probe when the variable is unset and the package is present', () => {
    const spawn = vi.fn();
    const option = claudeExecutableOption({ env: {}, sdkDir: fakeSdk({ platformPackage, exe }), spawn: spawn as unknown as typeof spawnSync });
    expect(option).toEqual({});
    expect('pathToClaudeCodeExecutable' in option).toBe(false);
    expect(spawn).not.toHaveBeenCalled();
  });

  it('treats a blank variable as unset', () => {
    expect(claudeExecutableOption({ env: { [CLAUDE_BIN_ENV]: '  ' }, sdkDir: fakeSdk({ platformPackage, exe }) })).toEqual({});
  });

  it('throws one line that names the variable when the variable is unset and the package is absent', () => {
    const err = quiet();
    const sdkDir = fakeSdk();
    const run = () => claudeExecutableOption({ env: {}, sdkDir, hint: 'or set EPISODIC_MEMORY_SUMMARIZER_BACKEND=ollama' });
    expect(run).toThrow(ClaudeBinError);
    expect(run).toThrow(new RegExp(`${CLAUDE_BIN_ENV}.*EPISODIC_MEMORY_SUMMARIZER_BACKEND=ollama`));
    // The same failure writes its stderr line once per process, not once per call.
    const lines = err.mock.calls.filter(c => String(c[0]).includes('is not installed'));
    expect(lines).toHaveLength(1);
  });

  it('passes the path when the variable names a binary at or above the floor', () => {
    const bin = fakeBin('2.1.318 (Claude Code)\n');
    expect(claudeExecutableOption({ env: { [CLAUDE_BIN_ENV]: bin }, sdkDir: fakeSdk() })).toEqual({ pathToClaudeCodeExecutable: bin });
  });

  it('probes one path once per process, and probes a second path separately', () => {
    const counted = vi.fn((...args: unknown[]) => (spawnSync as (...a: unknown[]) => unknown)(...args));
    const spawn = counted as unknown as typeof spawnSync;
    const sdkDir = fakeSdk({ platformPackage, exe });
    const a = fakeBin('2.1.300\n');
    const b = fakeBin('2.1.301\n');
    claudeExecutableOption({ env: { [CLAUDE_BIN_ENV]: a }, sdkDir, spawn });
    claudeExecutableOption({ env: { [CLAUDE_BIN_ENV]: a }, sdkDir, spawn });
    expect(counted).toHaveBeenCalledTimes(1);
    claudeExecutableOption({ env: { [CLAUDE_BIN_ENV]: b }, sdkDir, spawn });
    expect(counted).toHaveBeenCalledTimes(2);
    // The unset case in the same process is not poisoned by the cache of a set path.
    expect(claudeExecutableOption({ env: {}, sdkDir, spawn })).toEqual({});
  });

  it('keeps a failed probe: a second call throws again without a second line or a second run', () => {
    const err = quiet();
    const counted = vi.fn((...args: unknown[]) => (spawnSync as (...a: unknown[]) => unknown)(...args));
    const env = { [CLAUDE_BIN_ENV]: fakeBin('2.1.1\n') };
    const sdkDir = fakeSdk();
    const run = () => claudeExecutableOption({ env, sdkDir, spawn: counted as unknown as typeof spawnSync });
    expect(run).toThrow(ClaudeBinError);
    expect(run).toThrow(ClaudeBinError);
    expect(counted).toHaveBeenCalledTimes(1);
    expect(err.mock.calls.filter(c => String(c[0]).includes('below'))).toHaveLength(1);
  });
});
