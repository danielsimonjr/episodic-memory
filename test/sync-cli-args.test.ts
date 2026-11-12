import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { safeRmSync } from './test-utils.js';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SYNC_CLI = join(REPO_ROOT, 'dist', 'sync-cli.js');

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'em-sync-args-'));
});

afterEach(() => {
  safeRmSync(home);
});

/** Run the sync CLI with an empty home and config folder. Then a run can never read real transcripts. */
function runSync(args: string[]) {
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, USERPROFILE: home, EPISODIC_MEMORY_CONFIG_DIR: join(home, 'cfg') };
  delete env.EPISODIC_MEMORY_SUMMARIZER_GUARD;
  return spawnSync(process.execPath, [SYNC_CLI, ...args], { env, timeout: 20000, encoding: 'utf-8' });
}

describe('sync-cli arguments', () => {
  it('refuses an unknown option with exit 2 and names it, before any sync work', () => {
    const result = runSync(['--no-summaries']);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('episodic-memory sync: unknown option --no-summaries');
    expect(result.stdout).not.toMatch(/Syncing|No conversation source/);
  });

  it('refuses an unknown option next to --background, before the worker starts', () => {
    const result = runSync(['--background', '--bogus']);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('unknown option --bogus');
    expect(result.stdout).not.toMatch(/Sync started in background/);
  });

  it('still prints the help text for --help', () => {
    const result = runSync(['--help']);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Usage: episodic-memory sync [--background]');
  });
});
