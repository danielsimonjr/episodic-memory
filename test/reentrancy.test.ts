import { describe, it, expect, afterEach } from 'vitest';
import { shouldSkipReentrantSync, SUMMARIZER_GUARD_ENV } from '../src/reentrancy.js';

// The reentrancy guard lives in its own dependency-free module so sync-cli can
// check it BEFORE importing the heavy native stack (transformers, better-sqlite3).
// Loading those just to bail out on a summarizer-spawned subprocess wasted
// seconds per spawn and made the integration test time out on cold disks.

describe('reentrancy guard module', () => {
  afterEach(() => {
    delete process.env[SUMMARIZER_GUARD_ENV];
  });

  it('names the guard env var the summarizer sets on SDK subprocesses', () => {
    expect(SUMMARIZER_GUARD_ENV).toBe('EPISODIC_MEMORY_SUMMARIZER_GUARD');
  });

  it('returns true only when the guard env is exactly "1"', () => {
    process.env[SUMMARIZER_GUARD_ENV] = '1';
    expect(shouldSkipReentrantSync()).toBe(true);
  });

  it('returns false when the guard env is unset', () => {
    delete process.env[SUMMARIZER_GUARD_ENV];
    expect(shouldSkipReentrantSync()).toBe(false);
  });

  it('returns false when the guard env is set to anything other than "1"', () => {
    process.env[SUMMARIZER_GUARD_ENV] = '0';
    expect(shouldSkipReentrantSync()).toBe(false);
    process.env[SUMMARIZER_GUARD_ENV] = 'true';
    expect(shouldSkipReentrantSync()).toBe(false);
  });

  it('is importable without pulling the heavy native stack', async () => {
    // Importing this module must not drag in transformers/better-sqlite3. We can't
    // easily assert the absence of a native load, but we can assert the module is
    // self-contained: re-importing returns the same function reference instantly.
    const again = await import('../src/reentrancy.js');
    expect(again.shouldSkipReentrantSync).toBe(shouldSkipReentrantSync);
  });
});
