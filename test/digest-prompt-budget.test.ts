import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { Database } from '../src/sqlite.js';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { initDatabase } from '../src/db.js';
import { runDigest } from '../src/digest-job.js';
import { buildSessionPrompt } from '../src/digest-prompts.js';
import type { ConversationExchange } from '../src/types.js';
import { SUMMARIZER_GUARD_ENV } from '../src/reentrancy.js';
import { safeRmSync, suppressConsole } from './test-utils.js';

suppressConsole();

const NOW = new Date('2026-10-08T18:00:00.000Z');
const KEYS = [
  'TEST_DB_PATH',
  'EPISODIC_MEMORY_DIGEST',
  'EPISODIC_MEMORY_SUMMARIZER_BACKEND',
  'EPISODIC_MEMORY_OLLAMA_MAX_PROMPT_CHARS',
  SUMMARIZER_GUARD_ENV,
];
const saved: Record<string, string | undefined> = {};

/** Forty exchanges of one session. Each message is short, so the blank line between blocks matters to the cap. */
function exchangesOf(n: number): ConversationExchange[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `x${i}`,
    project: 'proj-a',
    timestamp: new Date(Date.UTC(2026, 9, 8, 9, 0, 0) + i * 60_000).toISOString(),
    userMessage: `Question ${i} about the cache layer and its store`,
    assistantMessage: `Answer ${i}: keep sqlite for the cache layer`,
    archivePath: '/a.jsonl',
    lineStart: 1,
    lineEnd: 2,
  }));
}

describe('runDigest keeps the session prompt within promptBudgetChars()', () => {
  const dir = path.join(os.tmpdir(), 'digest-budget-' + Date.now());
  let db: Database;

  beforeEach(() => {
    for (const k of KEYS) saved[k] = process.env[k];
    fs.mkdirSync(dir, { recursive: true });
    process.env.TEST_DB_PATH = path.join(dir, 't.db');
    process.env.EPISODIC_MEMORY_DIGEST = '1';
    delete process.env[SUMMARIZER_GUARD_ENV];
    db = initDatabase();
    for (const e of exchangesOf(40)) {
      db.prepare(
        `INSERT INTO exchanges (id, project, timestamp, user_message, assistant_message, archive_path, line_start, line_end, session_id)
         VALUES (?, ?, ?, ?, ?, '/a.jsonl', 1, 2, 's1')`
      ).run(e.id, e.project, e.timestamp, e.userMessage, e.assistantMessage);
    }
  });
  afterEach(() => {
    db.close();
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    safeRmSync(dir);
  });

  it('builds no prompt over the Ollama cap, including the blank lines between blocks', async () => {
    const budget = 3000;
    process.env.EPISODIC_MEMORY_SUMMARIZER_BACKEND = 'ollama';
    process.env.EPISODIC_MEMORY_OLLAMA_MAX_PROMPT_CHARS = String(budget);

    // numberExchanges counts the blank lines between blocks, so the cap "budget minus the rules" is exact.
    const overhead = buildSessionPrompt([], 0).prompt.length;
    const exact = buildSessionPrompt(exchangesOf(40), budget - overhead).prompt;
    expect(exact.length).toBeLessThanOrEqual(budget);
    expect(exact.length).toBeGreaterThan(budget - 200);

    const prompts: string[] = [];
    await runDigest(db, {
      now: NOW,
      model: async (p: string) => {
        prompts.push(p);
        return 'Chose sqlite for the cache layer [1]';
      },
    });

    expect(prompts).toHaveLength(1);
    expect(prompts[0].length).toBeLessThanOrEqual(budget);
  });

  it('keeps the transcript numbered and cited inside the budget', async () => {
    process.env.EPISODIC_MEMORY_SUMMARIZER_BACKEND = 'ollama';
    process.env.EPISODIC_MEMORY_OLLAMA_MAX_PROMPT_CHARS = '3000';
    let seen = '';
    const r = await runDigest(db, {
      now: NOW,
      model: async (p: string) => {
        seen = p;
        return 'Chose sqlite for the cache layer [1]';
      },
    });
    expect(seen).toContain('[1] User: Question 0');
    expect(seen.length).toBeLessThanOrEqual(3000);
    expect(r.written).toBe(1);
  });
});
