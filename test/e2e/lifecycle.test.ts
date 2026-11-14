/**
 * The lifecycle of one sandbox, in order: save (sync, index), recall (search, MCP read, show),
 * organize (verify, repair, prune, vacuum, rebuild) and the index lock. Each case asserts a real
 * hit: a project, a file, a row count, a summary request. An exit code alone is not a pass.
 *
 * A case that fails because the PRODUCT is wrong is `it.skip('Dn pending: ...')`, with the measured
 * input and output in its title. No assertion is weakened to make a case pass.
 */
import { existsSync, readdirSync, readFileSync, rmSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  DIST_DIR, EXIT_FAIL, EXIT_LOCKED, EXIT_USAGE, McpClient, cliBin, fakeOllama, fixturePath, makeSandbox, oneLine, openIndexDb,
  removeSandbox, runCli, seedTranscript, syncLockPath, textOf,
  type CliResult, type FakeOllama, type Sandbox,
} from './harness.js';
import { useIsolation } from './isolation.js';

/** The two projects of the sandbox: alpha holds two transcripts, beta one. */
const ALPHA = 'e2e-alpha';
const BETA = 'e2e-beta';
/** The session id that the short fixture carries in its lines (its file name is this id). */
const SHORT_SESSION = '982581eb-41b9-46da-86c1-ac34168117a8';
/** The session id that the long fixture carries in its lines. */
const LONG_SESSION = '9a9eadc8-c1f1-493e-a0f1-884aa996b05b';
/** A word that only the medium and long transcripts contain, and only beta holds the long one. */
const DOCKER = 'docker';
/** A word that only the short transcript holds (alpha). */
const AUTH = 'authentication';
/** The long transcript allows this much time for a summarising sync or a rebuild. */
const HEAVY_MS = 600_000;
/** The child timeout. It stays under the 120 s case timeout of vitest.e2e.config.ts, so a child dies before its case ends. */
const CHILD_MS = 100_000;

useIsolation();

let sb: Sandbox;
let ollama: FakeOllama;
/** The seeded medium transcript: its archived copy keeps this file name. */
let MEDIUM_FILE = '';
/** The exchange rows after the first sync. A rebuild from the same archive must restore this count. */
let baselineRows = 0;

/** Run the umbrella CLI in the sandbox. Every run gets the fake Ollama: no case here reaches a model. */
function cli(args: readonly string[], opts: { env?: Record<string, string | undefined>; timeoutMs?: number } = {}): Promise<CliResult> {
  return runCli(sb, cliBin('episodic-memory.js'), args, {
    env: { EPISODIC_MEMORY_OLLAMA_URL: ollama.url, ...opts.env },
    timeoutMs: opts.timeoutMs ?? CHILD_MS,
  });
}

/** Every archived transcript (a `.jsonl` file) under the archive, recursively. Summaries are not transcripts. */
function archivedFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.jsonl')) out.push(full);
    }
  };
  if (existsSync(sb.archive)) walk(sb.archive);
  return out;
}

/** The count of one SQL COUNT(*) over the sandbox index, read by the test itself (not through a CLI). */
function rowCount(sql: string, ...params: string[]): number {
  const db = openIndexDb(sb);
  try {
    return (db.prepare(sql).get(...params) as { n: number }).n;
  } finally {
    db.close();
  }
}

/** The exchange rows of one project. */
function rowsOf(project: string): number {
  return rowCount('SELECT COUNT(*) AS n FROM exchanges WHERE project = ?', project);
}

/** The total of exchange rows. */
function totalRows(): number {
  return rowCount('SELECT COUNT(*) AS n FROM exchanges');
}

beforeAll(async () => {
  sb = makeSandbox();
  ollama = await fakeOllama('ok');
  seedTranscript(sb, ALPHA, 'short-conversation.jsonl', { sessionId: SHORT_SESSION });
  MEDIUM_FILE = seedTranscript(sb, ALPHA, 'medium-conversation.jsonl');
  seedTranscript(sb, BETA, 'long-conversation.jsonl', { sessionId: LONG_SESSION });
}, HEAVY_MS);

afterAll(async () => {
  if (ollama) await ollama.close();
  if (sb) removeSandbox(sb);
});

describe('lifecycle: save', () => {
  it('syncs three transcripts in the foreground, archives them, and asks the fake for summaries', async () => {
    const result = await cli(['sync']);
    expect(result.code, result.stderr).toBe(0);
    const files = archivedFiles();
    expect(files.length).toBe(3);
    // Each archived file sits in its project folder: two in alpha, one in beta.
    expect(files.map((file) => path.basename(path.dirname(file))).sort()).toEqual([ALPHA, ALPHA, BETA]);
    expect(ollama.requests.filter((r) => r.kind === 'summary').length).toBeGreaterThanOrEqual(1);
    // The exchange-less medium transcript: sync writes its summary file beside the archived copy.
    const medium = files.find((file) => path.basename(file) === path.basename(MEDIUM_FILE))!;
    expect(existsSync(medium.replace(/\.jsonl$/, '-summary.txt'))).toBe(true);
  });

  it('reports the counts that the index holds: two indexed conversations, and the exchange rows of openIndexDb', async () => {
    const result = await cli(['stats']);
    expect(result.code, result.stderr).toBe(0);
    const exchanges = totalRows();
    expect(exchanges).toBeGreaterThan(0);
    baselineRows = exchanges;
    // The medium fixture holds no user or assistant line, so it has no exchange: the index holds two conversations,
    // while the archive holds three files. Its archived copy must have no row.
    expect(rowCount('SELECT COUNT(*) AS n FROM exchanges WHERE archive_path LIKE ?', `%${path.basename(MEDIUM_FILE)}`)).toBe(0);
    expect(result.stdout).toMatch(/Total Conversations: 2\b/);
    // The stats line formats the count with a thousands separator, so the test reads it without one.
    const shown = /Total Exchanges: ([\d,]+)/.exec(result.stdout);
    expect(shown, result.stdout).not.toBeNull();
    expect(Number(shown![1].replace(/,/g, ''))).toBe(exchanges);
    expect(result.stdout).toMatch(/Unique Projects: 2\b/);
    expect(rowsOf(ALPHA)).toBeGreaterThan(0);
    expect(rowsOf(BETA)).toBeGreaterThan(0);
  });
});

/** One search result of the plain-text output: its project and the archive file that its `Lines` line names. */
interface Hit {
  project: string;
  file: string;
}

/** The hits of a plain-text search output. A block is one result: its header names the project, its `Lines` line the file. */
function hitsOf(stdout: string): Hit[] {
  return stdout.split(/\n\n/).flatMap((block) => {
    const head = /^\d+\. \[([^,\]]+), /m.exec(block);
    const where = / in (\S.*?) \(\d/.exec(block);
    return head && where ? [{ project: head[1], file: where[1] }] : [];
  });
}

/** The project of every result header. The multi-concept output has no `Lines` line, so its headers are the only source. */
function projectsOf(stdout: string): string[] {
  return [...stdout.matchAll(/^\d+\. \[([^,\]]+), /gm)].map((m) => m[1]);
}

/** Run `search` with the given arguments and assert that it exits 0. */
async function search(args: readonly string[]): Promise<{ stdout: string; hits: Hit[] }> {
  const result = await cli(['search', ...args], { timeoutMs: CHILD_MS });
  expect(result.code, `search ${args.join(' ')}: ${result.stderr}`).toBe(0);
  return { stdout: result.stdout, hits: hitsOf(result.stdout) };
}

const NONE = 'No results found.';

describe('lifecycle: recall (search)', () => {
  it('finds a text word in the long transcript: the hit names its project and its archive file', async () => {
    const { stdout, hits } = await search(['--text', DOCKER]);
    expect(stdout).toMatch(/^Found \d+ relevant conversations?:/m);
    expect(hits.length).toBeGreaterThan(0);
    expect(new Set(hits.map((h) => h.project))).toEqual(new Set([BETA]));
    expect(hits.every((h) => h.file.endsWith(`${LONG_SESSION}.jsonl`))).toBe(true);
  });

  it('finds the same transcript by meaning with --vector: every hit is an archived file', async () => {
    const { hits } = await search(['--vector', 'docker container build pipeline']);
    expect(hits.length).toBeGreaterThan(0);
    const archived = new Set(archivedFiles());
    expect(hits.every((h) => archived.has(h.file))).toBe(true);
    expect(hits[0].project).toBe(BETA);
  });

  it('finds a phrase with the default mode (vector and text together) and names the long transcript', async () => {
    const { hits } = await search(['docker build']);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.some((h) => h.project === BETA && h.file.endsWith(`${LONG_SESSION}.jsonl`))).toBe(true);
  });

  it('narrows to one project with --project: alpha holds the authentication word, and no docker', async () => {
    const alpha = await search(['--project', ALPHA, '--text', AUTH]);
    expect(alpha.hits.length).toBeGreaterThan(0);
    expect(new Set(alpha.hits.map((h) => h.project))).toEqual(new Set([ALPHA]));
    expect(alpha.hits.every((h) => h.file.endsWith(`${SHORT_SESSION}.jsonl`))).toBe(true);
    const none = await search(['--project', ALPHA, '--text', DOCKER]);
    expect(none.stdout.trim()).toBe(NONE);
  });

  it('filters by date with --after and --before', async () => {
    // Every fixture is dated 2025-10-08. A window that ends before it finds nothing.
    const after = await search(['--after', '2025-10-01', '--text', DOCKER]);
    expect(after.hits.length).toBeGreaterThan(0);
    expect((await search(['--before', '2025-10-01', '--text', DOCKER])).stdout.trim()).toBe(NONE);
    expect((await search(['--after', '2025-10-09', '--text', DOCKER])).stdout.trim()).toBe(NONE);
  });

  it('filters to one session with --session-id, using the id that the lines carry', async () => {
    const hit = await search(['--session-id', SHORT_SESSION, '--text', AUTH]);
    expect(hit.hits.length).toBeGreaterThan(0);
    expect(hit.hits.every((h) => h.project === ALPHA && h.file.endsWith(`${SHORT_SESSION}.jsonl`))).toBe(true);
    expect((await search(['--session-id', LONG_SESSION, '--text', AUTH])).stdout.trim()).toBe(NONE);
  });

  it('filters by git branch with --git-branch, using the branch that the short transcript carries', async () => {
    const hit = await search(['--git-branch', 'feature-branch', '--text', AUTH]);
    expect(hit.hits.length).toBeGreaterThan(0);
    expect(new Set(hit.hits.map((h) => h.project))).toEqual(new Set([ALPHA]));
    expect((await search(['--git-branch', 'feature-branch', '--text', DOCKER])).stdout.trim()).toBe(NONE);
  });

  it('returns exactly one result with --limit 1, in the text mode and in the vector mode', async () => {
    const text = await search(['--limit', '1', '--text', DOCKER]);
    expect(text.stdout).toMatch(/^Found 1 relevant conversation:/m);
    expect(text.hits.length).toBe(1);
    const vector = await search(['--limit', '1', '--vector', 'docker container build pipeline']);
    expect(vector.stdout).toMatch(/^Found 1 relevant conversation:/m);
    expect(vector.hits.length).toBe(1);
  });

  it('answers a multi-concept search with the long transcript among the matches, and names both concepts', async () => {
    // The multi-concept AND runs vector search per concept (search.ts searchMultipleConcepts). The index is small, so the
    // alpha conversation can also pass both concepts: the case asserts the long transcript is present, not exclusivity.
    const both = await search([DOCKER, 'build']);
    expect(both.stdout).toContain(`matching all concepts [${DOCKER} + build]`);
    expect(projectsOf(both.stdout)).toContain(BETA);
    // Both concepts reach the search: the output names them, whether or not a conversation matches.
    const pair = await search([DOCKER, AUTH]);
    expect(pair.stdout).toMatch(new RegExp(`(\\[${DOCKER} \\+ ${AUTH}\\]|all concepts: ${DOCKER}, ${AUTH})`));
  });
});

describe('lifecycle: the default mode of search', () => {
  it('finds two distinct rows in each mode on its own, so the merge of the default mode has two lists to merge', async () => {
    // The precondition of D1: at --limit 2, vector alone and text alone each return two rows.
    const vector = await search(['--vector', '--limit', '2', 'docker build']);
    const text = await search(['--text', '--limit', '2', 'docker build']);
    expect(vector.stdout).toMatch(/^Found 2 relevant conversations:/m);
    expect(text.stdout).toMatch(/^Found 2 relevant conversations:/m);
  });

  // Before the D1 fix, `search --limit 2 "docker build"` printed `Found 3`: the merge appended the text rows
  // to the vector rows and made no cut to `limit`.
  it('default mode --limit 2 "docker build" returns at most 2 conversations (D1)', async () => {
    const { stdout } = await search(['--limit', '2', 'docker build']);
    const found = /^Found (\d+) relevant conversations?:/m.exec(stdout);
    expect(found, stdout).not.toBeNull();
    expect(Number(found![1])).toBeLessThanOrEqual(2);
  });});

describe('lifecycle: search --both', () => {
  // D2: the help text documents `--both`. Before the fix, no branch read it, and it became a second concept.
  it('search --both "docker build" runs the default mode, not a two-concept search (D2)', async () => {
    const both = await search(['--both', 'docker build']);
    expect(both.stdout).not.toContain('matching all concepts');
    const plain = await search(['docker build']);
    expect(both.hits).toEqual(plain.hits);
  });
});

describe('lifecycle: recall (MCP)', () => {
  it('searches over MCP in JSON, then reads the returned archive path by a line range', async () => {
    const client = await McpClient.start(sb, { env: { EPISODIC_MEMORY_OLLAMA_URL: ollama.url } });
    let code: number | null = null;
    try {
      const found = await client.call('search', { query: DOCKER, mode: 'text', limit: 5, response_format: 'json' });
      expect(found.isError, textOf(found)).not.toBe(true);
      // The JSON format is { results: [{ exchange: { project, archivePath, lineStart, lineEnd }, ... }], count, mode }.
      const body = JSON.parse(textOf(found)) as { results: Array<{ exchange: { project: string; archivePath: string; lineStart: number; lineEnd: number } }>; count: number };
      expect(body.count).toBeGreaterThan(0);
      const target = body.results[0].exchange;
      expect(target.project).toBe(BETA);
      expect(target.archivePath.endsWith(`${LONG_SESSION}.jsonl`)).toBe(true);
      const read = await client.call('read', { path: target.archivePath, startLine: target.lineStart, endLine: target.lineEnd });
      expect(read.isError, textOf(read)).not.toBe(true);
      expect(textOf(read).toLowerCase()).toContain(DOCKER);
      // A path outside the archive is refused. The file sits under the sandbox tmp folder, not in the source folder:
      // `index --cleanup` reads the source folder, so a file seeded there would be indexed by a later case.
      const outside = path.join(sb.tmp, 'outside.jsonl');
      writeFileSync(outside, readFileSync(fixturePath('tiny-conversation.jsonl')));
      const refused = await client.call('read', { path: outside });
      expect(refused.isError, textOf(refused)).toBe(true);
    } finally {
      code = await client.close();
    }
    expect(code).toBe(0);
  });
});

/** The archived copy of the long transcript: the file that `show` and the repair cases name. */
function longArchive(): string {
  const file = archivedFiles().find((f) => f.endsWith(`${LONG_SESSION}.jsonl`));
  expect(file, 'the long transcript is archived').toBeDefined();
  return file!;
}

/** The session id of the small transcript that the html case writes under the sandbox tmp folder. */
const LINKED_SESSION = '5e2e0001-0000-4000-8000-00000000c0de';

/** A two-line transcript: a Markdown link, a script tag and a javascript link. `show` reads any path. */
function linkedTranscript(): string {
  const stamp = '2025-10-08T10:00:00.000Z';
  const base = { isSidechain: false, userType: 'external', cwd: '/e2e/alpha', sessionId: LINKED_SESSION, version: '2.0.9' };
  const lines = [
    { ...base, uuid: 'e2e-user-1', parentUuid: null, type: 'user', timestamp: stamp,
      message: { role: 'user', content: [{ type: 'text', text: 'Where is the guide?' }] } },
    { ...base, uuid: 'e2e-agent-1', parentUuid: 'e2e-user-1', type: 'assistant', timestamp: stamp,
      // A heading makes isMarkdown() true (show.ts), so the text takes the Markdown path that emits hrefs.
      message: { role: 'assistant', content: [{ type: 'text', text: '# Guide\n\nSee [the guide](https://example.com/guide). <script>alert(1)</script> [bad](javascript:alert(1))' }] } },
  ];
  const file = path.join(sb.tmp, 'linked.jsonl');
  writeFileSync(file, `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`, 'utf-8');
  return file;
}

describe('lifecycle: show', () => {
  it('shows an archived conversation as markdown: the title, the session id and the transcript text', async () => {
    const result = await cli(['show', longArchive()]);
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toContain('# Conversation');
    expect(result.stdout).toContain(`**Session ID:** ${LONG_SESSION}`);
    expect(result.stdout.toLowerCase()).toContain(DOCKER);
  });

  it('renders the same conversation as html with no script element', async () => {
    const result = await cli(['show', '--format', 'html', longArchive()]);
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).not.toContain('<script');
  });

  it('renders a Markdown link as an https href, and refuses the script tag and the javascript link', async () => {
    // The long fixture carries its URLs only as escaped tool text, never as a Markdown link. This small transcript does.
    const result = await cli(['show', '--format', 'html', linkedTranscript()]);
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toContain('href="https://example.com/guide"');
    expect(result.stdout).not.toContain('<script');
    expect(result.stdout).not.toMatch(/href="javascript:/i);
  });
});

describe('lifecycle: index --verify', () => {
  it('verifies the summarised index as healthy with exit 0', async () => {
    const result = await cli(['index', '--verify']);
    expect(result.code, result.stdout + result.stderr).toBe(0);
    expect(result.stdout).toContain('Missing summaries: 0');
    expect(result.stdout).toContain('Index is healthy');
  });
});

/** The `exchanges` count of the `index prune` output. */
function prunedExchanges(stdout: string): number {
  const found = /exchanges\s*: (\d+)/.exec(stdout);
  expect(found, stdout).not.toBeNull();
  return Number(found![1]);
}

/** The exclude list of the index folder (src/paths.ts getExcludeConfigPath). */
const EXCLUDE_FILE = (): string => path.join(sb.index, 'exclude.txt');

describe('lifecycle: organize (prune)', () => {
  it('dry-runs a prune of one project: the counts print, and no row changes', async () => {
    const before = totalRows();
    const alpha = rowsOf(ALPHA);
    expect(alpha).toBeGreaterThan(0);
    const result = await cli(['index', 'prune', '--dry-run', '--project', ALPHA]);
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toContain(`Pruning 1 project(s): ${ALPHA}`);
    expect(prunedExchanges(result.stdout)).toBe(alpha);
    expect(result.stdout).toContain('Dry run');
    expect(totalRows()).toBe(before);
    expect(rowsOf(ALPHA)).toBe(alpha);
  });

  it('prunes one project with --project: its rows go, and the other project keeps its rows', async () => {
    const alpha = rowsOf(ALPHA);
    const beta = rowsOf(BETA);
    const result = await cli(['index', 'prune', '--project', ALPHA]);
    expect(result.code, result.stderr).toBe(0);
    expect(prunedExchanges(result.stdout)).toBe(alpha);
    expect(result.stdout).toContain('Rows removed');
    expect(rowsOf(ALPHA)).toBe(0);
    expect(rowsOf(BETA)).toBe(beta);
  });

  it('prunes the projects that exclude.txt names with --excluded, after a dry run that counts them', async () => {
    writeFileSync(EXCLUDE_FILE(), `# projects the index must not hold\n${BETA}\n`, 'utf-8');
    const beta = rowsOf(BETA);
    const dry = await cli(['index', 'prune', '--excluded', '--dry-run']);
    expect(dry.code, dry.stderr).toBe(0);
    expect(dry.stdout).toContain(`Pruning 1 project(s): ${BETA}`);
    expect(prunedExchanges(dry.stdout)).toBe(beta);
    expect(rowsOf(BETA)).toBe(beta);
    const real = await cli(['index', 'prune', '--excluded']);
    expect(real.code, real.stderr).toBe(0);
    expect(prunedExchanges(real.stdout)).toBe(beta);
    expect(rowsOf(BETA)).toBe(0);
  });

  it('keeps an excluded project out of the index while CONVERSATION_SEARCH_EXCLUDE_PROJECTS names it, and restores it after', async () => {
    // exclude.txt would still hide beta from the rebuild, so it goes first (the variable has priority, paths.ts).
    rmSync(EXCLUDE_FILE(), { force: true });
    const env = { CONVERSATION_SEARCH_EXCLUDE_PROJECTS: BETA };
    const rebuild = await cli(['index', '--rebuild', '--yes'], { env });
    expect(rebuild.code, rebuild.stderr).toBe(0);
    expect(rowsOf(BETA)).toBe(0);
    expect(rowsOf(ALPHA)).toBeGreaterThan(0);
    // The hidden project is not searchable: the docker word lives only in beta.
    expect((await search(['--text', DOCKER])).stdout.trim()).toBe(NONE);
    // The variable only governs indexing: the rows come back once it is gone.
    const cleanup = await cli(['index', '--cleanup', '--no-summaries']);
    expect(cleanup.code, cleanup.stderr).toBe(0);
    expect(rowsOf(BETA)).toBeGreaterThan(0);
  });
});

describe('lifecycle: organize (vacuum)', () => {
  it('vacuums the index database with exit 0, reports the size before and after, and keeps every row', async () => {
    const before = totalRows();
    const result = await cli(['index', 'vacuum']);
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toContain('size before');
    expect(result.stdout).toContain('size after');
    expect(totalRows()).toBe(before);
  });
});

describe('lifecycle: rebuild', () => {
  it('rebuilds the whole index with --rebuild --yes: exit 0, and the rows return to the baseline of the first sync', async () => {
    const result = await cli(['index', '--rebuild', '--yes']);
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toContain('Deleted existing database');
    expect(totalRows()).toBe(baselineRows);
    expect(rowsOf(ALPHA)).toBeGreaterThan(0);
    expect(rowsOf(BETA)).toBeGreaterThan(0);
    expect(archivedFiles().length).toBe(3);
  });

  it('rebuilds with the rebuild subcommand and --yes: exit 0, and the same rows', async () => {
    const result = await cli(['index', 'rebuild', '--yes']);
    expect(result.code, result.stderr).toBe(0);
    expect(totalRows()).toBe(baselineRows);
  });

  it('refuses rebuild without --yes at the index-cli entry: exit 2, one line, and no row deleted', async () => {
    const before = totalRows();
    const result = await runCli(sb, path.join(DIST_DIR, 'index-cli.js'), ['rebuild'], { timeoutMs: CHILD_MS });
    expect(result.code).toBe(EXIT_USAGE);
    expect(oneLine(result.stderr)).toContain('needs --yes');
    expect(totalRows()).toBe(before);
  });

  it('deletes nothing when the umbrella rebuild has no --yes and its stdin is closed', async () => {
    // The umbrella asks the question. A closed stdin gives no answer, so the command refuses and the database stays.
    const before = totalRows();
    const result = await cli(['index', 'rebuild'], { timeoutMs: CHILD_MS });
    expect(result.code).toBe(EXIT_USAGE);
    expect(result.stdout).toContain('Are you sure?');
    expect(existsSync(path.join(sb.index, 'db.sqlite'))).toBe(true);
    expect(totalRows()).toBe(before);
  });

  // Before the D6 fix, `index --rebuild` with no --yes and a closed stdin printed the question and exited 0.
  it('index --rebuild with no --yes and a closed stdin exits 2 with one refusal line (D6)', async () => {
    const result = await cli(['index', '--rebuild'], { timeoutMs: CHILD_MS });
    expect(result.code).toBe(EXIT_USAGE);
    expect(oneLine(result.stderr)).toContain('--yes');
  });
});

describe('lifecycle: the index lock', () => {
  it('exits 75 with one line when a live holder has the sync lock, and leaves the lock with its holder', async () => {
    const lock = syncLockPath(sb);
    writeFileSync(lock, String(process.pid), 'utf-8');
    const now = new Date();
    utimesSync(lock, now, now);
    try {
      const direct = await runCli(sb, path.join(DIST_DIR, 'index-cli.js'), ['verify'], { timeoutMs: CHILD_MS });
      expect(direct.code).toBe(EXIT_LOCKED);
      expect(oneLine(direct.stderr)).toContain(`pid ${process.pid}`);
      // The command does no work and does not take the lock: the file still names this process.
      expect(readFileSync(lock, 'utf-8').trim()).toBe(String(process.pid));
    } finally {
      unlinkSync(lock);
    }
  });

  // D5: before the fix, both wrappers (cli/index-conversations.js and cli/episodic-memory.js) added
  // "Error: Command failed with exit code 75" after the index-cli line. The refusal names one cause, so one line.
  it('index under a held lock via the umbrella exits 75 with one stderr line (D5)', async () => {
    const lock = syncLockPath(sb);
    writeFileSync(lock, String(process.pid), 'utf-8');
    const now = new Date();
    utimesSync(lock, now, now);
    try {
      const result = await cli(['index']);
      expect(result.code).toBe(EXIT_LOCKED);
      expect(oneLine(result.stderr)).toContain(`pid ${process.pid}`);
    } finally {
      unlinkSync(lock);
    }
  });

  it('exits 75 through the umbrella too, and names the holder pid in its stderr', async () => {
    const lock = syncLockPath(sb);
    writeFileSync(lock, String(process.pid), 'utf-8');
    const now = new Date();
    utimesSync(lock, now, now);
    try {
      const result = await cli(['index']);
      expect(result.code).toBe(EXIT_LOCKED);
      expect(result.stderr).toContain('another sync or index command is running');
      expect(result.stderr).toContain(`pid ${process.pid}`);
    } finally {
      unlinkSync(lock);
    }
    expect(totalRows()).toBe(baselineRows);
  });
});

/** The archived transcript of one session, named by its session id. */
function archiveOf(session: string): string {
  const file = archivedFiles().find((f) => f.endsWith(`${session}.jsonl`));
  expect(file, `session ${session} is archived`).toBeDefined();
  return file!;
}

describe('lifecycle: the other index commands and flags', () => {
  it('--verify names a deleted summary (exit 1), and --repair writes it back with a new summary request', async () => {
    // The rebuild left the exchange-less medium transcript without a summary too (D7), so the case names the file it deleted.
    const short = archiveOf(SHORT_SESSION);
    const summary = short.replace(/\.jsonl$/, '-summary.txt');
    expect(existsSync(summary)).toBe(true);
    unlinkSync(summary);
    const verify = await cli(['index', '--verify']);
    expect(verify.code).toBe(EXIT_FAIL);
    expect(verify.stdout).toContain(`${SHORT_SESSION}.jsonl`);
    const requests = ollama.requests.filter((r) => r.kind === 'summary').length;
    const repair = await cli(['index', '--repair']);
    expect(repair.code, repair.stderr).toBe(0);
    expect(existsSync(summary)).toBe(true);
    expect(readFileSync(summary, 'utf-8')).toContain('E2E summary MARKER');
    expect(ollama.requests.filter((r) => r.kind === 'summary').length).toBeGreaterThan(requests);
    const again = await cli(['index', '--verify']);
    expect(again.stdout).not.toContain(`${SHORT_SESSION}.jsonl`);
  });

  it('--session re-indexes one session by its id: exit 0, names the session, and adds no row', async () => {
    const before = totalRows();
    const result = await cli(['index', '--session', SHORT_SESSION]);
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toContain(`Indexed session ${SHORT_SESSION}`);
    expect(totalRows()).toBe(before);
  });

  it('index-all re-runs the whole index with exit 0, and adds no row', async () => {
    const before = totalRows();
    const result = await cli(['index', 'index-all', '--no-summaries']);
    expect(result.code, result.stderr).toBe(0);
    expect(totalRows()).toBe(before);
  });

  it('index-session re-indexes the named session with exit 0, and names it', async () => {
    const before = totalRows();
    const result = await cli(['index', 'index-session', LONG_SESSION, '--no-summaries']);
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toContain(`Indexed session ${LONG_SESSION}`);
    expect(totalRows()).toBe(before);
  });

  it('index-cleanup processes the unindexed conversations with exit 0, and adds no row to a complete index', async () => {
    const before = totalRows();
    const result = await cli(['index', 'index-cleanup', '--no-summaries']);
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toContain('Finding unprocessed conversations');
    expect(totalRows()).toBe(before);
  });

  it('verify (the subcommand) gives the same exit code and the same findings as --verify', async () => {
    const flag = await cli(['index', '--verify']);
    const sub = await cli(['index', 'verify']);
    expect(sub.code).toBe(flag.code);
    const findings = (out: string): string => out.slice(out.indexOf('=== Verification Results ==='));
    expect(findings(sub.stdout)).toBe(findings(flag.stdout));
  });

  it('repair (the subcommand) verifies first and exits 0', async () => {
    const result = await cli(['index', 'repair']);
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toContain('Verifying conversation index');
  });

  // Measured: `sync` writes the summary of the exchange-less medium transcript. `index --rebuild --yes` deletes every
  // summary file (index-cli.ts:199-201) and the indexer writes none for a transcript with no exchange. Then
  // `index --verify` exits 1 and names that summary as missing (verify.ts:94), and `index --repair` prints
  // "Skipped (no exchanges)" (verify.ts:198), so the summary never comes back. Before the rebuild, verify exits 0.
  // Two paths disagree on the same transcript: sync writes the file, the indexer does not.
  it.skip('D7 pending: index --rebuild --yes then index --verify -> exit 1, the exchange-less transcript summary missing (expected exit 0)', async () => {
    const result = await cli(['index', '--verify']);
    expect(result.code, result.stdout).toBe(0);
    expect(result.stdout).toContain('Index is healthy');
  });
});

