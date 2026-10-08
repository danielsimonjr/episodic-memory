import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'child_process';
import { readFileSync } from 'fs';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { initDatabase } from '../src/db.js';
import { insertDigestEntry } from '../src/digest-db.js';
import { projectKeyFromCwd } from '../src/digest-inject.js';
import { safeRmSync, suppressConsole } from './test-utils.js';

suppressConsole();

const hookPath = new URL('../cli/digest-hook.js', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const CWD = process.platform === 'win32' ? 'C:\\work\\proj' : '/work/proj';

function runHook(env: Record<string, string | undefined>, input: unknown = { cwd: CWD }) {
  const merged: NodeJS.ProcessEnv = { ...process.env, ...env };
  for (const k of Object.keys(merged)) if (merged[k] === undefined) delete merged[k];
  return spawnSync(process.execPath, [hookPath], { input: JSON.stringify(input), env: merged, encoding: 'utf-8', timeout: 20000 });
}

describe('hooks.json', () => {
  it('keeps the sync hook first and adds the digest hook under the same matcher', () => {
    const hooks = JSON.parse(readFileSync(new URL('../hooks/hooks.json', import.meta.url), 'utf-8'));
    const list = hooks.hooks.SessionStart[0].hooks.map((h: { command: string }) => h.command);
    expect(list[0]).toBe('node "${PLUGIN_ROOT:-${CLAUDE_PLUGIN_ROOT}}/cli/sync-hook.js"');
    expect(list[1]).toBe('node "${PLUGIN_ROOT:-${CLAUDE_PLUGIN_ROOT}}/cli/digest-hook.js"');
  });
});

describe('digest-hook', () => {
  const dir = path.join(os.tmpdir(), 'digest-hook-' + Date.now());
  const dbPath = path.join(dir, 't.db');

  beforeEach(() => {
    fs.mkdirSync(dir, { recursive: true });
    process.env.TEST_DB_PATH = dbPath;
    const db = initDatabase();
    insertDigestEntry(db, {
      tier: 'session',
      project: projectKeyFromCwd(CWD),
      periodStart: '2026-10-07T09:00:00.000Z',
      periodEnd: '2026-10-07T09:30:00.000Z',
      text: 'Chose sqlite for the cache [#e1]',
      sources: ['e1'],
      model: 'haiku',
      handoff: false,
    });
    db.close();
    delete process.env.TEST_DB_PATH;
  });
  afterEach(() => safeRmSync(dir));

  it('prints the digest as SessionStart additional context when the flag is on', () => {
    const r = runHook({ EPISODIC_MEMORY_DIGEST: '1', TEST_DB_PATH: dbPath });
    expect(r.status).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(out.hookSpecificOutput.hookEventName).toBe('SessionStart');
    expect(out.hookSpecificOutput.additionalContext).toContain('Chose sqlite for the cache [#e1]');
  });

  it('prints nothing with the flag off', () => {
    const r = runHook({ EPISODIC_MEMORY_DIGEST: undefined, TEST_DB_PATH: dbPath });
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('');
  });

  it('prints nothing when the summarizer guard is set', () => {
    const r = runHook({ EPISODIC_MEMORY_DIGEST: '1', EPISODIC_MEMORY_SUMMARIZER_GUARD: '1', TEST_DB_PATH: dbPath });
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('');
  });

  it('prints nothing for a project with no digest', () => {
    const r = runHook({ EPISODIC_MEMORY_DIGEST: '1', TEST_DB_PATH: dbPath }, { cwd: CWD + '-other' });
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('');
  });

  it('prints nothing and exits 0 when the database does not exist', () => {
    const r = runHook({ EPISODIC_MEMORY_DIGEST: '1', TEST_DB_PATH: path.join(dir, 'missing.db') });
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('');
  });

  it('exits 0 on garbage stdin', () => {
    const r = spawnSync(process.execPath, [hookPath], {
      input: '{not json',
      env: { ...process.env, EPISODIC_MEMORY_DIGEST: '1', TEST_DB_PATH: dbPath },
      encoding: 'utf-8',
      timeout: 20000,
    });
    expect(r.status).toBe(0);
  });
});
