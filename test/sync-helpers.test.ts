import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { shouldSkipConversation, extractSessionIdFromPath } from '../src/sync.js';
import { SUMMARIZER_CONTEXT_MARKER } from '../src/constants.js';
import { safeRmSync } from './test-utils.js';

describe('sync helpers', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'em-sync-helpers-'));
  });

  afterEach(() => {
    safeRmSync(testDir);
  });

  it('extracts the last UUID from Claude or Codex filenames', () => {
    expect(
      extractSessionIdFromPath('/tmp/019e4c75-d5bf-7c71-9df7-77f5fb86b711.jsonl')
    ).toBe('019e4c75-d5bf-7c71-9df7-77f5fb86b711');
    expect(
      extractSessionIdFromPath('/tmp/rollout-aaaaaaa1-aaaa-4aaa-8aaa-aaaaaaaaaaa1-bbbbbbb2-bbbb-4bbb-8bbb-bbbbbbbbbbb2.jsonl')
    ).toBe('bbbbbbb2-bbbb-4bbb-8bbb-bbbbbbbbbbb2');
    expect(extractSessionIdFromPath('/tmp/human-named.jsonl')).toBeNull();
  });

  it('skips conversations that contain exclusion markers', () => {
    const skip = path.join(testDir, 'skip.jsonl');
    fs.writeFileSync(skip, `hello ${SUMMARIZER_CONTEXT_MARKER} world`, 'utf-8');
    expect(shouldSkipConversation(skip)).toBe(true);

    const keep = path.join(testDir, 'keep.jsonl');
    fs.writeFileSync(keep, '{"type":"user"}\n', 'utf-8');
    expect(shouldSkipConversation(keep)).toBe(false);
    expect(shouldSkipConversation(path.join(testDir, 'missing.jsonl'))).toBe(false);
  });
});
