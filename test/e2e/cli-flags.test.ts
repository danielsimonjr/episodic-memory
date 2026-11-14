/**
 * Flags of the CLI, command by command: `--help` exits 0; each flag's happy path; a bad value; a
 * missing value; an unknown flag. Exit codes come from the EXIT_* table of harness.ts.
 *
 * A case marked `D<n> pending` is a defect of PLAN.md. Its title names the defect and the
 * measured input and output (file:line in the reason). It is skipped, never a passing case.
 */
import { readdirSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  EXIT_FAIL, EXIT_USAGE, assertRepoPreconditions, cliBin, listTree, makeSandbox, oneLine, removeSandbox, runCli, seedTranscript,
  syncWorkerPids, waitForBackgroundSync,
  type Sandbox,
} from './harness.js';
import { useIsolation } from './isolation.js';
// `readdirSync` lists the archive; `path` joins it. Both are used by archiveFile().

const UMBRELLA = cliBin('episodic-memory.js');
const PROJECT = 'e2e-flags';
const WORD = 'baseline';
/** The text of a search with no hit, as the product prints it (measured 2026-11-13). */
const NO_MATCH = 'No results found';

useIsolation();

let sb: Sandbox;

/** The usage contract of every command: exit 2 and exactly one stderr line that names the bad input. */
async function expectUsage(args: string[], names: string, env: Record<string, string> = {}): Promise<void> {
  const r = await runCli(sb, UMBRELLA, args, { env });
  expect(r.code).toBe(EXIT_USAGE);
  expect(oneLine(r.stderr)).toContain(names);
}

/** The archive file that `sync` copied for PROJECT. `show` reads one archive file. */
function archiveFile(): string {
  const dir = path.join(sb.archive, PROJECT);
  const files = readdirSync(dir).filter((name) => name.endsWith('.jsonl'));
  if (files.length === 0) throw new Error(`no archived transcript in ${dir}`);
  return path.join(dir, files[0]);
}

beforeAll(async () => {
  assertRepoPreconditions();
  sb = makeSandbox();
  seedTranscript(sb, PROJECT, 'short-conversation.jsonl');
  const sync = await runCli(sb, UMBRELLA, ['sync'], { env: { EPISODIC_MEMORY_SKIP_SUMMARIES: '1' } });
  expect(sync.code).toBe(0);
  const index = await runCli(sb, UMBRELLA, ['index', '--no-summaries']);
  expect(index.code).toBe(0);
}, 300_000);

afterAll(() => {
  if (sb) removeSandbox(sb);
});

describe('search flags', () => {
  it('--help exits 0 and names every search flag', async () => {
    const r = await runCli(sb, UMBRELLA, ['search', '--help']);
    expect(r.code).toBe(0);
    for (const flag of ['--vector', '--text', '--after', '--before', '--project', '--session-id', '--git-branch', '--limit']) {
      expect(r.stdout).toContain(flag);
    }
  });

  it('--text finds the seeded word', async () => {
    const r = await runCli(sb, UMBRELLA, ['search', '--text', WORD]);
    expect(r.code).toBe(0);
    expect(r.stdout.toLowerCase()).toContain(WORD);
  });

  it('--vector finds the seeded word by meaning and exits 0', async () => {
    const r = await runCli(sb, UMBRELLA, ['search', '--vector', WORD]);
    expect(r.code).toBe(0);
    expect(r.stdout).not.toContain(NO_MATCH);
  });

  it('--project, --after and --before filter the seeded session in', async () => {
    const r = await runCli(sb, UMBRELLA, ['search', '--text', WORD, '--project', PROJECT, '--after', '2000-01-01', '--before', '2100-01-01']);
    expect(r.code).toBe(0);
    expect(r.stdout.toLowerCase()).toContain(WORD);
  });

  it('--before a date before the transcript filters it out', async () => {
    const r = await runCli(sb, UMBRELLA, ['search', '--text', WORD, '--before', '1990-01-01']);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain(NO_MATCH);
  });

  it('--session-id and --git-branch with no match find nothing', async () => {
    const a = await runCli(sb, UMBRELLA, ['search', '--text', WORD, '--session-id', 'no-such-session']);
    const b = await runCli(sb, UMBRELLA, ['search', '--text', WORD, '--git-branch', 'no-such-branch']);
    expect(a.code).toBe(0);
    expect(b.code).toBe(0);
    expect(a.stdout).toContain(NO_MATCH);
    expect(b.stdout).toContain(NO_MATCH);
  });

  // D3: before the fix, `search baseline --zzz-e2e` read the flag as a second concept and exited 0.
  it('search unknown flag exits 2 with one stderr line (D3)', async () => {
    await expectUsage(['search', WORD, '--zzz-e2e'], '--zzz-e2e');
  });

  // D3: `search baseline --limit` (missing value) and `--limit abc` exit 1 with
  // "Error searching: Error: datatype mismatch" (measured; src/search-cli.ts:75-76 gives NaN).
  it('search --limit with no value or a non-number exits 2 (D3)', async () => {
    await expectUsage(['search', WORD, '--limit'], '--limit');
    await expectUsage(['search', WORD, '--limit', 'abc'], '--limit');
    await expectUsage(['search', WORD, '--project'], '--project needs a value');
  });

  it('-- ends the options: a later argument that starts with - is a query, not a refused flag', async () => {
    const r = await runCli(sb, UMBRELLA, ['search', '--text', '--', '--zzz-e2e']);
    expect(r.code, r.stderr).toBe(0);
    expect(r.stderr).not.toContain('unknown option');
  });
});

describe('show flags', () => {
  it('--help exits 0 and names --format', async () => {
    const r = await runCli(sb, UMBRELLA, ['show', '--help']);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('--format');
  });

  it('--format html renders an HTML document', async () => {
    const r = await runCli(sb, UMBRELLA, ['show', '--format', 'html', archiveFile()]);
    expect(r.code).toBe(0);
    expect(r.stdout.toLowerCase()).toContain('<html');
  });

  it('-f markdown is the short form and renders markdown', async () => {
    const r = await runCli(sb, UMBRELLA, ['show', '-f', 'markdown', archiveFile()]);
    expect(r.code).toBe(0);
    expect(r.stdout.toLowerCase()).not.toContain('<html');
    expect(r.stdout.toLowerCase()).toContain(WORD);
  });

  it('--format with no value or a value other than markdown and html is a usage error', async () => {
    await expectUsage(['show', '--format'], '--format');
    await expectUsage(['show', '--format', 'pdf', archiveFile()], '--format');
  });

  // D3: before the fix, `show --zzz-e2e` read the flag as a file name and failed with ENOENT, exit 1.
  it('show unknown flag exits 2 with one stderr line (D3)', async () => {
    await expectUsage(['show', '--zzz-e2e', archiveFile()], '--zzz-e2e');
  });
});

describe('stats flags', () => {
  it('--help exits 0', async () => {
    const r = await runCli(sb, UMBRELLA, ['stats', '--help']);
    expect(r.code).toBe(0);
    expect(r.stdout.trim().length).toBeGreaterThan(0);
  });

  // D3: before the fix, `stats --zzz-e2e` printed the normal statistics and exited 0.
  it('stats unknown flag exits 2 with one stderr line (D3)', async () => {
    await expectUsage(['stats', '--zzz-e2e'], '--zzz-e2e');
  });
});

describe('index flags', () => {
  it('--help exits 0 and names the index options', async () => {
    const r = await runCli(sb, UMBRELLA, ['index', '--help']);
    expect(r.code).toBe(0);
    for (const flag of ['--concurrency', '--no-summaries', '--yes', '--cleanup', '--verify', '--rebuild']) {
      expect(r.stdout).toContain(flag);
    }
  });

  it('--verify reports the sessions this index has no summary for (exit 1, measured)', async () => {
    // The beforeAll index ran with --no-summaries, so verify reports one missing summary. A healthy
    // index with summaries is checked in lifecycle.test.ts.
    const r = await runCli(sb, UMBRELLA, ['index', '--verify']);
    expect(r.code).toBe(EXIT_FAIL);
    expect(r.stdout).toContain('Missing summaries: 1');
  });

  it('--cleanup and -c N each exit 0', async () => {
    expect((await runCli(sb, UMBRELLA, ['index', '--cleanup', '--no-summaries'])).code).toBe(0);
    expect((await runCli(sb, UMBRELLA, ['index', '-c', '1', '--no-summaries'])).code).toBe(0);
  });

  it('a missing value for --concurrency or --project exits 2 and does no work', async () => {
    const a = await runCli(sb, UMBRELLA, ['index', '--concurrency']);
    const b = await runCli(sb, UMBRELLA, ['index', '--project']);
    expect(a.code).toBe(EXIT_USAGE);
    expect(b.code).toBe(EXIT_USAGE);
    expect(a.stderr).toContain('--concurrency needs a value');
  });

  it('an unknown index flag exits 2', async () => {
    const r = await runCli(sb, UMBRELLA, ['index', '--zzz-e2e']);
    expect(r.code).toBe(EXIT_USAGE);
    expect(r.stderr).toContain('unknown option --zzz-e2e');
  });

  // D5: before the fix, the umbrella printed "Error: Command failed with exit code 2" after the child's own line.
  it('index unknown flag prints one stderr line through the umbrella (D5)', async () => {
    await expectUsage(['index', '--zzz-e2e'], '--zzz-e2e');
  });
});

describe('sync flags', () => {
  it('--help exits 0 and names --background', async () => {
    const r = await runCli(sb, UMBRELLA, ['sync', '--help']);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('--background');
  });

  it('an unknown sync flag exits 2 and does no work', async () => {
    const r = await runCli(sb, UMBRELLA, ['sync', '--zzz-e2e']);
    expect(r.code).toBe(EXIT_USAGE);
    expect(r.stderr).toContain('unknown option --zzz-e2e');
  });

  // A private sandbox: the detached worker must not hold the lock of the shared one. The case
  // waits for the worker with the three-signal wait, which also removes the sandbox.
  it('--background returns at once with exit 0, and its worker archives the transcript', async () => {
    const own = makeSandbox();
    seedTranscript(own, PROJECT, 'short-conversation.jsonl');
    const before = syncWorkerPids();
    const r = await runCli(own, UMBRELLA, ['sync', '--background'], { env: { EPISODIC_MEMORY_SKIP_SUMMARIES: '1' } });
    expect(r.code).toBe(0);
    await waitForBackgroundSync(own, before, 240_000, () => {
      expect(readdirSync(path.join(own.archive, PROJECT)).filter((name) => name.endsWith('.jsonl'))).toHaveLength(1);
    });
  }, 300_000);
});

describe('backfill flags', () => {
  it('--help exits 0 and names --dry-run, --limit and --batch', async () => {
    const r = await runCli(sb, UMBRELLA, ['backfill', '--help']);
    expect(r.code).toBe(0);
    for (const flag of ['--dry-run', '--limit', '--batch']) expect(r.stdout).toContain(flag);
  });

  it('--dry-run, --limit 1 and --batch 5 each exit 0 and write nothing', async () => {
    // The index database changes on every open (WAL), so the check reads the archive folder.
    const before = listTree([sb.archive]);
    expect((await runCli(sb, UMBRELLA, ['backfill', '--dry-run'], { env: { EPISODIC_MEMORY_SKIP_SUMMARIES: '1' } })).code).toBe(0);
    expect((await runCli(sb, UMBRELLA, ['backfill', '--dry-run', '--limit', '1'], { env: { EPISODIC_MEMORY_SKIP_SUMMARIES: '1' } })).code).toBe(0);
    expect((await runCli(sb, UMBRELLA, ['backfill', '--dry-run', '--batch', '5'], { env: { EPISODIC_MEMORY_SKIP_SUMMARIES: '1' } })).code).toBe(0);
    expect(listTree([sb.archive])).toEqual(before);
  });

  it('a bad or missing --limit or --batch value is a usage error', async () => {
    await expectUsage(['backfill', '--limit', 'abc'], '--limit needs a positive integer');
    await expectUsage(['backfill', '--limit'], '--limit needs a value');
    await expectUsage(['backfill', '--batch', '0'], '--batch needs a positive integer');
  });

  // D3: before the fix, `backfill --zzz-e2e` exited 0 and did its normal work.
  it('backfill unknown flag exits 2 with one stderr line (D3)', async () => {
    await expectUsage(['backfill', '--zzz-e2e'], '--zzz-e2e');
  });
});

describe('doctor and learn flags', () => {
  it('doctor --help exits 0 and names --json', async () => {
    const r = await runCli(sb, UMBRELLA, ['doctor', '--help']);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('--json');
  });

  it('doctor --json prints one JSON document on stdout', async () => {
    const r = await runCli(sb, UMBRELLA, ['doctor', '--json']);
    // doctor exits 1 when a check fails (no codex on the empty PATH), 0 otherwise; never a crash.
    expect([0, EXIT_FAIL]).toContain(r.code);
    expect(typeof JSON.parse(r.stdout)).toBe('object');
  });

  // D3: before the fix, `learn tasks --zzz-e2e` ignored the flag, ran the task step and exited 0.
  it('learn unknown flag exits 2 with one stderr line (D3)', async () => {
    await expectUsage(['learn', 'tasks', '--zzz-e2e'], '--zzz-e2e', { EPISODIC_MEMORY_LEARN: '1' });
  });

  it('learn --help exits 0 and names the subcommands', async () => {
    const r = await runCli(sb, UMBRELLA, ['learn', '--help']);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('learn tasks');
  });
});

describe('model flags', () => {
  it('model --help exits 0 and names fetch and status', async () => {
    const r = await runCli(sb, UMBRELLA, ['model', '--help']);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('fetch');
    expect(r.stdout).toContain('status');
  });

  it('model status reports the shared model folder as ready and exits 0', async () => {
    const r = await runCli(sb, UMBRELLA, ['model', 'status']);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('State: ready');
  });

  it('model status exits 1 and names the missing files of an empty model folder', async () => {
    const empty = path.join(sb.root, 'empty-model');
    const r = await runCli(sb, UMBRELLA, ['model', 'status'], { env: { EPISODIC_MEMORY_MODEL_DIR: empty } });
    expect(r.code).toBe(EXIT_FAIL);
    expect(r.stdout).toContain('State: missing');
    expect(r.stdout).toContain('tokenizer.json');
  });

  it('model fetch with EPISODIC_MEMORY_MODEL_OFFLINE=1 does not download and exits 1 for an empty folder', async () => {
    const empty = path.join(sb.root, 'offline-model');
    const r = await runCli(sb, UMBRELLA, ['model', 'fetch'], {
      env: { EPISODIC_MEMORY_MODEL_DIR: empty, EPISODIC_MEMORY_MODEL_OFFLINE: '1' },
    });
    expect(r.code).toBe(EXIT_FAIL);
    expect(r.stderr).not.toContain('downloading');
    expect(r.stderr).toContain('not ready');
  });

  it('model fetch reads HF_ENDPOINT, fails on a closed loopback port and exits 1', async () => {
    const empty = path.join(sb.root, 'endpoint-model');
    const r = await runCli(sb, UMBRELLA, ['model', 'fetch'], {
      env: {
        EPISODIC_MEMORY_MODEL_DIR: empty,
        EPISODIC_MEMORY_MODEL_OFFLINE: '0',
        HF_ENDPOINT: 'http://127.0.0.1:9',
      },
    });
    expect(r.code).toBe(EXIT_FAIL);
    expect(r.stderr).toContain('127.0.0.1:9');
  });
});

describe('short help flag -h', () => {
  it('-h prints the help text and exits 0 for each command that registers it', async () => {
    const problems: string[] = [];
    for (const cmd of ['search', 'show', 'stats', 'index', 'sync', 'backfill', 'doctor']) {
      const r = await runCli(sb, UMBRELLA, [cmd, '-h']);
      if (r.code !== 0 || r.stdout.trim() === '') problems.push(`${cmd} -h: exit ${r.code}, stdout ${r.stdout.trim() === '' ? 'empty' : 'printed'}`);
    }
    expect(problems).toEqual([]);
  });
});
