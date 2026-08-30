import { describe, it, expect } from 'vitest';
import { detectCodexHookTrustState, trustStateFromHooksList } from '../src/codex-hook-trust.js';

describe('trustStateFromHooksList', () => {
  it('returns unknown for malformed payloads', () => {
    expect(trustStateFromHooksList(null)).toBe('unknown');
    expect(trustStateFromHooksList('x')).toBe('unknown');
    expect(trustStateFromHooksList({ data: 'nope' })).toBe('unknown');
  });

  it('returns not_found when no episodic-memory hook is present', () => {
    expect(trustStateFromHooksList({ data: [] })).toBe('not_found');
    expect(trustStateFromHooksList({
      data: [{ hooks: [{ pluginId: 'other@x', trustStatus: 'trusted' }] }],
    })).toBe('not_found');
  });

  it('treats managed as trusted and reads alternate trust fields', () => {
    expect(trustStateFromHooksList({
      data: [{ hooks: [{ key: 'episodic-memory@dev:hooks', trust: 'managed' }] }],
    })).toBe('trusted');

    expect(trustStateFromHooksList({
      data: [{ hooks: [{ pluginId: 'episodic-memory@dev', trust_status: 'untrusted' }] }],
    })).toBe('untrusted');
  });
});

describe('detectCodexHookTrustState', () => {
  it('returns unknown when the Codex app-server cannot be reached', async () => {
    const state = await detectCodexHookTrustState('/tmp/no-such-codex-home', process.cwd(), 200);
    expect(state).toBe('unknown');
  });
});
