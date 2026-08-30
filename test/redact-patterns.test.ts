import { describe, it, expect } from 'vitest';
import { redactSecrets } from '../src/redact.js';

describe('redactSecrets pattern coverage', () => {
  it('redacts github, openai, aws, slack, google, stripe, jwt, and bearer shapes', () => {
    const input = [
      'ghp_abcdefghijklmnopqrstuvwx',
      'github_pat_abcdefghijklmnopqrstuv',
      'sk-abcdefghijklmnopqrstuvwxyz012345',
      'sk-ant-abcdefghijklmnopqrstuvwxyz',
      'AKIAIOSFODNN7EXAMPLE',
      'xoxb-1234567890-abcdefghij',
      'AIzaSyA-abcdefghijklmnopqrst',
      'sk_live_abcdefghijklmnopqrstuv',
      'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.signaturepart',
      'Authorization: Bearer abcdefghijklmnopqrstuvwxyz012345',
    ].join(' ');
    const out = redactSecrets(input);
    expect(out).not.toMatch(/ghp_/);
    expect(out).not.toMatch(/github_pat_/);
    expect(out).not.toMatch(/sk-abc/);
    expect(out).not.toMatch(/AKIA/);
    expect(out).not.toMatch(/xoxb-/);
    expect(out).not.toMatch(/AIza/);
    expect(out).not.toMatch(/sk_live_/);
    expect(out).not.toMatch(/eyJhbGci/);
    expect(out).not.toMatch(/Bearer abc/);
    expect(out).toContain('[redacted]');
  });

  it('is a no-op on empty text', () => {
    expect(redactSecrets('')).toBe('');
  });
});
