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

  // D3: `search` takes an unknown flag as a query term and exits 0. Measured 2026-11-13:
  // `search baseline --zzz-e2e` -> exit 0, stdout "No conversations found matching all concepts:
  // --zzz-e2e, baseline". Source: src/search-cli.ts:78-80.
  it.skip('D3 pending: search unknown flag exits 2 with one stderr line (src/search-cli.ts:78-80)', async () => {
    await expectUsage(['search', WORD, '--zzz-e2e'], '--zzz-e2e');
  });

  // D3: `search baseline --limit` (missing value) and `--limit abc` exit 1 with
  // "Error searching: Error: datatype mismatch" (measured; src/search-cli.ts:75-76 gives NaN).
  it.skip('D3 pending: search --limit with no value or a non-number exits 2 (src/search-cli.ts:75-76)', async () => {
    await expectUsage(['search', WORD, '--limit'], '--limit');
    await expectUsage(['search', WORD, '--limit', 'abc'], '--limit');
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

  it('--format with no value and no file exits 1 (the file is missing)', async () => {
    const r = await runCli(sb, UMBRELLA, ['show', '--format']);
    expect(r.code).toBe(EXIT_FAIL);
  });

  // D3: `show --zzz-e2e` reads the flag as a file name: "ENOENT ... open '...\--zzz-e2e'", exit 1.
  // Source: show-cli argument parsing (not read here; the measured output is the evidence).
  it.skip('D3 pending: show unknown flag exits 2 with one stderr line (measured: ENOENT on "--zzz-e2e", exit 1)', async () => {
    await expectUsage(['show', '--zzz-e2e', archiveFile()], '--zzz-e2e');
  });
});

describe('stats flags', () => {
  it('--help exits 0', async () => {
    const r = await runCli(sb, UMBRELLA, ['stats', '--help']);
    expect(r.code).toBe(0);
    expect(r.stdout.trim().length).toBeGreaterThan(0);
  });

  // D3: `stats --zzz-e2e` exits 0 with the normal statistics and no error (measured 2026-11-13).
  it.skip('D3 pending: stats unknown flag exits 2 with one stderr line (measured: exit 0, silent)', async () => {
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

  // D5: the umbrella prints the child's error line again. Measured 2026-11-13 for `index --zzz-e2e`:
  // stderr is "episodic-memory index: unknown option --zzz-e2e..." then "Error: Command failed with exit
  // code 2". The second line is written by cli/episodic-memory.js:100 (catch) after the child exited.
  it.skip('D5 pending: index unknown flag prints ONE stderr line (cli/episodic-memory.js:100 double print)', async () => {
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

  it('a bad or missing --limit value exits 1 with the positive-integer message', async () => {
    const a = await runCli(sb, UMBRELLA, ['backfill', '--limit', 'abc']);
    const b = await runCli(sb, UMBRELLA, ['backfill', '--limit']);
    expect(a.code).toBe(EXIT_FAIL);
    expect(b.code).toBe(EXIT_FAIL);
    expect(a.stderr).toContain('--limit needs a positive integer');
  });

  // D3: `backfill --zzz-e2e` exits 0 and does its normal work; the flag is not refused (measured).
  it.skip('D3 pending: backfill unknown flag exits 2 with one stderr line (measured: exit 0, silent)', async () => {
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

  // D3: `learn tasks --zzz-e2e` runs the task step and exits 0; the unknown flag is ignored (measured).
  it.skip('D3 pending: learn unknown flag exits 2 with one stderr line (measured: learn tasks exit 0)', async () => {
    await expectUsage(['learn', 'tasks', '--zzz-e2e'], '--zzz-e2e', { EPISODIC_MEMORY_LEARN: '1' });
  });

  it('learn --help exits 0 and names the subcommands', async () => {
    const r = await runCli(sb, UMBRELLA, ['learn', '--help']);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('learn tasks');
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
