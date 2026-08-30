import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { maybeRedactSecrets } from '../src/redact.js';
import { formatConversationAsMarkdown } from '../src/show.js';

describe('MCP read output redaction', () => {
  const prev = process.env.EPISODIC_MEMORY_REDACT_SECRETS;

  afterEach(() => {
    if (prev === undefined) delete process.env.EPISODIC_MEMORY_REDACT_SECRETS;
    else process.env.EPISODIC_MEMORY_REDACT_SECRETS = prev;
  });

  it('redacts secrets in formatted read output when opt-in is enabled', () => {
    process.env.EPISODIC_MEMORY_REDACT_SECRETS = '1';
    const jsonl = JSON.stringify({
      uuid: '11111111-1111-1111-1111-111111111111',
      parentUuid: null,
      timestamp: '2026-08-30T00:00:00.000Z',
      type: 'user',
      isSidechain: false,
      message: {
        role: 'user',
        content: 'My key is sk-abcdefghijklmnopqrstuvwxyz012345',
      },
    });
    const markdown = maybeRedactSecrets(formatConversationAsMarkdown(jsonl));
    expect(markdown).not.toMatch(/sk-abc/);
    expect(markdown).toContain('[redacted]');
  });

  it('leaves formatted read output unchanged when redaction is disabled', () => {
    delete process.env.EPISODIC_MEMORY_REDACT_SECRETS;
    const token = 'sk-abcdefghijklmnopqrstuvwxyz012345';
    const jsonl = JSON.stringify({
      uuid: '22222222-2222-2222-2222-222222222222',
      parentUuid: null,
      timestamp: '2026-08-30T00:00:00.000Z',
      type: 'user',
      isSidechain: false,
      message: {
        role: 'user',
        content: `My key is ${token}`,
      },
    });
    const markdown = maybeRedactSecrets(formatConversationAsMarkdown(jsonl));
    expect(markdown).toContain(token);
  });
});
