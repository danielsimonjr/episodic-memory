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

describe('runChild', () => {
  /** Run `runChild` in a child node, and print `ok` or the exit code and message of the rejection. */
  const runChildIn = (script: string, args: string[] = [], command?: string) => {
    const call = command === undefined
      ? `m.runChild(${JSON.stringify(script)}, ${JSON.stringify(args)})`
      : `m.runChild(${JSON.stringify(script)}, ${JSON.stringify(args)}, ${JSON.stringify(command)})`;
    const code = `import(${JSON.stringify(FORWARD_URL)}).then(m => ${call})` +
      `.then(() => console.log('ok'), e => console.log(JSON.stringify({ exitCode: e.exitCode, message: e.message })))`;
    return spawnSync(process.execPath, ['--input-type=module', '-e', code], { encoding: 'utf-8', timeout: 30000 });
  };

  it('resolves when the child exits 0, and passes the arguments', () => {
    const out = join(home, 'args.txt');
    const script = fixture('args.mjs', `import { writeFileSync } from 'fs';\nwriteFileSync(${JSON.stringify(out)}, process.argv.slice(2).join(' '));\n`);
    expect(runChildIn(script, ['a', 'b c']).stdout.trim()).toBe('ok');
    expect(readFileSync(out, 'utf-8')).toBe('a b c');
  });

  it('rejects with the exit code of a child that fails', () => {
    const script = fixture('exit3.mjs', 'process.exit(3);\n');
    expect(JSON.parse(runChildIn(script).stdout)).toEqual({ exitCode: 3, message: 'Command failed with exit code 3' });
  });

  it('rejects with exit code 1 when a signal stops the child', () => {
    const script = fixture('killself.mjs', "process.kill(process.pid, 'SIGKILL');\nsetTimeout(() => {}, 60000);\n");
    const result = JSON.parse(runChildIn(script).stdout);
    expect(result.exitCode).toBe(1);
    // Windows ends a process that SIGKILL stops with exit code 1 and reports no signal. POSIX reports the signal.
    if (process.platform === 'win32') {
      expect(result.message).toBe('Command failed with exit code 1');
    } else {
      expect(result.message).toBe('Command ended by signal SIGKILL');
    }
  });

  it('rejects when the child cannot start', () => {
    const script = fixture('never.mjs', 'process.exit(0);\n');
    const result = JSON.parse(runChildIn(script, [], join(home, 'no-such-node.exe')).stdout);
    expect(result.message).toMatch(/^Failed to run command: /);
  });

  it('is the only runner of episodic-memory.js and index-conversations.js', () => {
    for (const entry of ['episodic-memory.js', 'index-conversations.js']) {
      const source = readFileSync(join(CLI, entry), 'utf-8');
      expect(source, entry).toMatch(/import \{[^}]*\brunChild\b[^}]*\} from '\.\/forward-child\.js'/);
      expect(source, entry).not.toContain('function runScript');
      expect(source, entry).not.toContain("from 'child_process'");
    }
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
