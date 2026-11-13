import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawn, spawnSync } from 'child_process';
import { fileURLToPath, pathToFileURL } from 'url';
import { dirname, join } from 'path';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'fs';
import { tmpdir } from 'os';
import { safeRmSync } from './test-utils.js';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CLI = join(REPO_ROOT, 'cli');
const FORWARD_URL = pathToFileURL(join(CLI, 'forward-child.js')).href;

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'em-forward-'));
});

afterEach(() => {
  safeRmSync(home);
});

/** An environment whose every path variable points into the temporary folder. */
function isolatedEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    EPISODIC_MEMORY_CONFIG_DIR: join(home, 'cfg'),
    CLAUDE_CONFIG_DIR: join(home, 'claude'),
    CODEX_HOME: join(home, 'codex'),
    XDG_CONFIG_HOME: join(home, 'xdg'),
  };
  for (const key of ['EPISODIC_MEMORY_SUMMARIZER_GUARD', 'EPISODIC_MEMORY_DB_PATH', 'PERSONAL_SUPERPOWERS_DIR',
    'TEST_DB_PATH', 'TEST_ARCHIVE_DIR', 'TEST_PROJECTS_DIR', 'CONVERSATION_SEARCH_EXCLUDE_PROJECTS']) {
    delete env[key];
  }
  return env;
}

/** A node command line that loads forward-child.js and forwards to `script` with `command`. */
function forwardArgs(script: string, command?: string): string[] {
  const call = command === undefined
    ? `m.forward(${JSON.stringify(script)}, [])`
    : `m.forward(${JSON.stringify(script)}, [], ${JSON.stringify(command)})`;
  return ['--input-type=module', '-e', `import(${JSON.stringify(FORWARD_URL)}).then(m => ${call})`];
}

function fixture(name: string, body: string): string {
  const path = join(home, name);
  writeFileSync(path, body);
  return path;
}

describe('exitCodeFor', () => {
  it('passes a child exit code through and maps a stop by a signal to 1', async () => {
    const { exitCodeFor } = await import(FORWARD_URL);
    expect(exitCodeFor(0)).toBe(0);
    expect(exitCodeFor(2)).toBe(2);
    expect(exitCodeFor(null)).toBe(1);
  });
});

describe('forward', () => {
  it('exits with the exit code of the child', () => {
    const script = fixture('exit3.mjs', 'process.exit(3);\n');
    const result = spawnSync(process.execPath, forwardArgs(script), { encoding: 'utf-8', timeout: 30000 });
    expect(result.status).toBe(3);
  });

  // Linux reports an external kill as a signal and a null code; Windows reports code 1. Both must exit non-zero.
  it('exits non-zero when the child is killed', async () => {
    const pidFile = join(home, 'child.pid');
    const script = fixture(
      'wait.mjs',
      `import { writeFileSync } from 'fs';\nwriteFileSync(${JSON.stringify(pidFile)}, String(process.pid));\nsetTimeout(() => {}, 60000);\n`
    );
    const parent = spawn(process.execPath, forwardArgs(script), { stdio: 'ignore' });
    const status = new Promise<number | null>(resolve => parent.on('exit', code => resolve(code)));
    const deadline = Date.now() + 20000;
    while (!existsSync(pidFile) || readFileSync(pidFile, 'utf-8') === '') {
      if (Date.now() > deadline) throw new Error('the child never wrote its pid');
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    process.kill(Number(readFileSync(pidFile, 'utf-8')), 'SIGTERM');
    const code = await status;
    expect(code).not.toBe(0);
    expect(code).not.toBeNull();
  }, 30000);

  it('prints one line and exits 1 when the child cannot start', () => {
    const script = fixture('never.mjs', 'process.exit(0);\n');
    const missing = join(home, 'no-such-node');
    const result = spawnSync(process.execPath, forwardArgs(script, missing), { encoding: 'utf-8', timeout: 30000 });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`episodic-memory: cannot start ${script}`);
    expect(result.stderr).not.toMatch(/\n\s+at /);
  });
});

describe('the cli entry points', () => {
  const run = (entry: string, args: string[]) =>
    spawnSync(process.execPath, [join(CLI, entry), ...args], { env: isolatedEnv(), encoding: 'utf-8', timeout: 30000 });

  it('pass the child exit code through', () => {
    expect(run('episodic-memory', ['sync', '--bogus']).status).toBe(2);
    expect(run('index-conversations', ['--bogus']).status).toBe(2);
    const search = run('search-conversations', []);
    expect(search.status).toBe(1);
    expect(search.stderr).toContain('Usage: episodic-memory search');
    expect(run('search-conversations.js', []).status).toBe(1);
  });

  // cli/mcp-server starts the server, so this test reads the file instead of running it.
  it('route every forwarding entry point through forward-child.js', () => {
    for (const entry of ['episodic-memory', 'index-conversations', 'mcp-server', 'search-conversations', 'search-conversations.js']) {
      expect(readFileSync(join(CLI, entry), 'utf-8')).toContain("from './forward-child.js'");
    }
    for (const entry of readdirSync(CLI)) {
      expect(readFileSync(join(CLI, entry), 'utf-8'), entry).not.toContain('code ?? 0');
    }
  });
});
