/**
 * The MCP server over stdio, end to end: `dist/mcp-server.js` through `McpClient`, and the
 * wrapper `cli/mcp-server-wrapper.js`. Each case asserts an effect: the project of a hit, the lines
 * of a read, a refused path, a directory that was or was not created, a process that is gone.
 * A refused call is asserted by its error text and its `isError` flag, never by a status alone.
 *
 * A case that fails because the PRODUCT is wrong is `it.skip('Dn pending: ...')`, with the
 * measured input and output in its title. No assertion is weakened to make a case pass.
 */
import { existsSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { insertKnowledgeEntry } from '../../src/learn/knowledge-db.js';
import { openKnowledgeStore } from '../../src/learn/knowledge-store.js';
import { MCP_TOOLS } from './cases.js';
import {
  MCP_SERVER_JS, McpClient, REPO_ROOT, assertRepoPreconditions, cliBin, diffListings, fakeOllama, listTree, makeSandbox,
  openIndexDb, removeSandbox, runCli, seedDigestableSession, seedTranscript, textOf, withSandboxEnv,
  type CliResult, type FakeOllama, type McpCallResult, type Sandbox,
} from './harness.js';
import { useIsolation } from './isolation.js';

useIsolation();

/** The project of the short transcript (alpha) and of the long transcript (beta). */
const ALPHA = 'e2e-alpha';
const BETA = 'e2e-beta';
/** The project of the generated transcript whose lines carry one marker each. */
const LINES = 'e2e-lines';
/** The session ids that the fixtures carry in their lines. */
const SHORT_SESSION = '982581eb-41b9-46da-86c1-ac34168117a8';
const LONG_SESSION = '9a9eadc8-c1f1-493e-a0f1-884aa996b05b';
/** A word that only the long transcript (beta) holds, and a word that only the short one (alpha) holds. */
const DOCKER = 'docker';
const AUTH = 'authentication';
/** One marker per user line of the generated transcript: exchange 0, 1 and 2. */
const MARKS = ['E2EMARKONE', 'E2EMARKTWO', 'E2EMARKTHREE'] as const;
/** The seeding and the first sync load the model. */
const HEAVY_MS = 600_000;
/** The child timeout. It stays under the 120 s case timeout of vitest.e2e.config.ts. */
const CHILD_MS = 100_000;
/** How long a process may take to appear or to exit after a close. */
const PROCESS_MS = 20_000;

/** The MCP tool names the source registers: each `server.registerTool('<name>'` call of mcp-server.ts. */
function registeredToolNames(): string[] {
  const source = readFileSync(path.join(REPO_ROOT, 'src', 'mcp-server.ts'), 'utf-8');
  return [...source.matchAll(/server\.registerTool\(\s*'([a-z_]+)'/g)].map((m) => m[1]);
}

/** One generated transcript: three exchanges. User line i carries MARKS[i] and the assistant line answers it. */
function markedLines(): string[] {
  const base = { isSidechain: false, userType: 'external', cwd: `/e2e/${LINES}`, sessionId: '5e2e0c40-0000-4000-8000-00000000d00d', version: '2.0.9' };
  const lines: string[] = [];
  let parent: string | null = null;
  for (let i = 0; i < MARKS.length; i++) {
    const stamp = new Date(Date.UTC(2025, 9, 8, 10, 0, i)).toISOString();
    const userUuid = `e2e-mu-${i}`;
    const agentUuid = `e2e-ma-${i}`;
    lines.push(JSON.stringify({
      ...base, uuid: userUuid, parentUuid: parent, type: 'user', timestamp: stamp,
      message: { role: 'user', content: [{ type: 'text', text: `Question ${MARKS[i]}: how does the release step ${i} get its approval before the tag is cut?` }] },
    }));
    lines.push(JSON.stringify({
      ...base, uuid: agentUuid, parentUuid: userUuid, type: 'assistant', timestamp: stamp,
      message: { role: 'assistant', content: [{ type: 'text', text: `Answer ${i}: the approval comes from the reviewer, and the tag follows the merge of step ${i}.` }] },
    }));
    parent = agentUuid;
  }
  return lines;
}

/** The pids of the processes whose command line holds `needle`. Built from pieces, so the probe does not match itself. */
function pidsNaming(needle: string): number[] {
  if (process.platform === 'win32') {
    const script = "Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like ('*' + $env:E2E_NEEDLE + '*') } | ForEach-Object { $_.ProcessId }";
    const result = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], {
      encoding: 'utf-8', windowsHide: true, timeout: 60_000, env: { ...process.env, E2E_NEEDLE: needle },
    });
    if (result.status !== 0) throw new Error(`process list failed (${result.status}): ${result.stderr}`);
    return result.stdout.split(/\r?\n/).map((line) => line.trim()).filter((line) => line !== '').map(Number);
  }
  const result = spawnSync('ps', ['-eo', 'pid=,args='], { encoding: 'utf-8', timeout: 60_000 });
  if (result.status !== 0) throw new Error(`process list failed (${result.status}): ${result.stderr}`);
  return result.stdout.split('\n').filter((line) => line.includes(needle)).map((line) => Number(line.trim().split(/\s+/)[0]));
}

let ollama: FakeOllama;
let sb: Sandbox;

beforeAll(async () => {
  assertRepoPreconditions();
  ollama = await fakeOllama('ok');
  sb = makeSandbox();
  seedTranscript(sb, ALPHA, 'short-conversation.jsonl', { sessionId: SHORT_SESSION });
  seedTranscript(sb, BETA, 'long-conversation.jsonl', { sessionId: LONG_SESSION });
  seedTranscript(sb, LINES, markedLines());
  const sync: CliResult = await runCli(sb, cliBin('episodic-memory.js'), ['sync'], {
    env: { EPISODIC_MEMORY_OLLAMA_URL: ollama.url },
    timeoutMs: CHILD_MS,
  });
  expect(sync.code, sync.stderr).toBe(0);
}, HEAVY_MS);

afterAll(async () => {
  if (ollama) await ollama.close();
  if (sb) removeSandbox(sb);
});

describe('mcp: tools/list', () => {
  it('lists every tool the source registers, each with an object input schema', async () => {
    const source = registeredToolNames();
    expect(source.length).toBeGreaterThan(0);
    const client = await McpClient.start(sb);
    let tools: Array<{ name: string; inputSchema?: { type?: string; properties?: Record<string, unknown>; required?: string[] } }> = [];
    try {
      tools = (await client.request('tools/list', {})).tools;
    } finally {
      await client.close();
    }
    expect([...tools.map((t) => t.name)].sort()).toEqual([...source].sort());
    // The registry of the coverage gate lists the same tools as the source does.
    expect([...source].sort()).toEqual([...MCP_TOOLS].sort());
    for (const tool of tools) {
      expect(tool.inputSchema?.type, `${tool.name} has an input schema`).toBe('object');
      expect(Object.keys(tool.inputSchema?.properties ?? {}).length, `${tool.name} lists its inputs`).toBeGreaterThan(0);
    }
    const search = tools.find((t) => t.name === 'search')!;
    expect(search.inputSchema!.properties).toHaveProperty('query');
    expect(search.inputSchema!.properties).toHaveProperty('limit');
    expect(search.inputSchema!.required ?? []).toContain('query');
  });
});

describe('mcp: strict input schemas', () => {
  it('refuses an unknown argument, a wrong type and a missing required argument as error results, and keeps answering', async () => {
    const client = await McpClient.start(sb);
    try {
      const unknown: McpCallResult = await client.call('search', { query: AUTH, mode: 'text', bogus: 1 });
      expect(unknown.isError, textOf(unknown)).toBe(true);
      // The SDK validates the arguments against the input schema before the handler runs.
      expect(textOf(unknown)).toMatch(/Input validation error/);
      expect(textOf(unknown)).toContain('bogus');

      const wrongType: McpCallResult = await client.call('search', { query: AUTH, mode: 'text', limit: 'abc' });
      expect(wrongType.isError, textOf(wrongType)).toBe(true);
      expect(textOf(wrongType)).toContain('limit');

      const missing: McpCallResult = await client.call('search', { mode: 'text' });
      expect(missing.isError, textOf(missing)).toBe(true);
      expect(textOf(missing)).toContain('query');

      const topicsExtra: McpCallResult = await client.call('topics', { action: 'list', extra: true });
      expect(topicsExtra.isError, textOf(topicsExtra)).toBe(true);
      expect(textOf(topicsExtra)).toContain('extra');

      // The server still answers after four refusals: a valid search finds the alpha transcript.
      const after = await client.call('search', { query: AUTH, mode: 'text', response_format: 'json' });
      expect(after.isError, textOf(after)).not.toBe(true);
      const body = JSON.parse(textOf(after)) as { results: Array<{ exchange: { project: string } }> };
      expect(body.results.map((r) => r.exchange.project)).toContain(ALPHA);
    } finally {
      const code = await client.close();
      expect(code).toBe(0);
    }
  });
});

/** The JSON body of a search result. */
interface SearchBody {
  results: Array<{ exchange: { project: string; sessionId?: string; archivePath: string; lineStart: number; lineEnd: number } }>;
  count: number;
  mode?: string;
  concepts?: string[];
}

/** One search call over MCP in JSON format. The call must not be an error. */
async function searchJson(client: McpClient, args: Record<string, unknown>): Promise<SearchBody> {
  const result = await client.call('search', { response_format: 'json', ...args });
  expect(result.isError, textOf(result)).not.toBe(true);
  return JSON.parse(textOf(result)) as SearchBody;
}

describe('mcp: search', () => {
  let client: McpClient;

  beforeAll(async () => {
    client = await McpClient.start(sb);
  }, CHILD_MS);

  afterAll(async () => {
    await client.close();
  });

  it('finds the long transcript by text, and the short one by its own word, in JSON', async () => {
    const docker = await searchJson(client, { query: DOCKER, mode: 'text', limit: 5 });
    expect(docker.count).toBeGreaterThan(0);
    expect(docker.results.every((r) => r.exchange.project === BETA)).toBe(true);
    expect(docker.mode).toBe('text');
    const auth = await searchJson(client, { query: AUTH, mode: 'text', limit: 5 });
    expect(auth.count).toBeGreaterThan(0);
    expect(auth.results.every((r) => r.exchange.project === ALPHA)).toBe(true);
    expect(auth.count).toBe(auth.results.length);
  });

  it('finds the same exchanges by vector, and reports the vector mode', async () => {
    const vector = await searchJson(client, { query: 'docker build', mode: 'vector', limit: 5 });
    expect(vector.mode).toBe('vector');
    expect(vector.count).toBeGreaterThan(0);
    expect(vector.results.map((r) => r.exchange.project)).toContain(BETA);
  });

  it('answers the default mode and the markdown format with the project of each hit', async () => {
    const result = await client.call('search', { query: AUTH, mode: 'text' });
    expect(result.isError, textOf(result)).not.toBe(true);
    const text = textOf(result);
    expect(text).toContain(ALPHA);
    expect(text).not.toContain(BETA);
    // The default mode runs both methods: the vector ranking adds nearest exchanges of any project,
    // so the case asserts that the alpha exchange is among the hits, not that no other project appears.
    const both = await searchJson(client, { query: AUTH });
    expect(both.mode).toBe('both');
    expect(both.results.map((r) => r.exchange.project)).toContain(ALPHA);
  });

  it('search mode both, query "approval" in project e2e-lines, limit 1 returns at most 1 row (D1)', async () => {
    const one = await searchJson(client, { query: 'approval', project: LINES, limit: 1 });
    expect(one.results.length, `rows ${one.results.length}, count ${one.count}`).toBeLessThanOrEqual(1);
  });

  // The positive control of D1. A cut that keeps only the vector rows also passes the case above, and makes
  // the default mode the vector mode. The control needs a query whose top text row is not among the top two
  // vector rows: only a merge that gives each mode a place then puts both top rows in a limit of 2. Which
  // query meets that condition depends on the model, so the case takes the first one of a fixed list.
  it('search mode both in project e2e-lines, limit 2 keeps the top vector row and the top text row', async () => {
    const ids = (r: Awaited<ReturnType<typeof searchJson>>) => r.results.map((row) => row.exchange.id);
    const candidates = ['approval', 'reviewer', 'merge', 'tag', ...MARKS.map((m) => `approval ${m}`)];
    let chosen: string | undefined;
    let vectorTop: string[] = [];
    let textTop: string[] = [];
    for (const query of candidates) {
      const vector = ids(await searchJson(client, { query, project: LINES, mode: 'vector', limit: 2 }));
      const text = ids(await searchJson(client, { query, project: LINES, mode: 'text', limit: 1 }));
      if (text.length === 1 && !vector.includes(text[0])) { chosen = query; vectorTop = vector; textTop = text; break; }
    }
    expect(chosen, `no query of ${JSON.stringify(candidates)} has its top text row outside the vector top two`).toBeDefined();
    const both = await searchJson(client, { query: chosen!, project: LINES, limit: 2 });
    expect(ids(both)).toEqual([vectorTop[0], textTop[0]]);
  });

  it('applies the project and session filters, and an empty filter answers zero rows', async () => {
    const inProject = await searchJson(client, { query: AUTH, mode: 'text', project: ALPHA });
    expect(inProject.count).toBeGreaterThan(0);
    const wrongProject = await searchJson(client, { query: AUTH, mode: 'text', project: BETA });
    expect(wrongProject.count).toBe(0);
    const session = await searchJson(client, { query: DOCKER, mode: 'text', session_id: LONG_SESSION });
    expect(session.count).toBeGreaterThan(0);
    expect(session.results.every((r) => r.exchange.sessionId === LONG_SESSION)).toBe(true);
    const otherSession = await searchJson(client, { query: DOCKER, mode: 'text', session_id: SHORT_SESSION });
    expect(otherSession.count).toBe(0);
  });

  it('applies the date filters and the branch filter', async () => {
    const future = await searchJson(client, { query: DOCKER, mode: 'text', after: '2999-01-01' });
    expect(future.count).toBe(0);
    const past = await searchJson(client, { query: DOCKER, mode: 'text', before: '2999-01-01' });
    expect(past.count).toBeGreaterThan(0);
    const branch = await searchJson(client, { query: DOCKER, mode: 'text', git_branch: 'no-such-branch-e2e' });
    expect(branch.count).toBe(0);
  });

  it('caps a text search at the limit', async () => {
    const one = await searchJson(client, { query: 'approval', mode: 'text', project: LINES, limit: 1 });
    expect(one.count).toBe(1);
    expect(one.results.length).toBe(1);
    const two = await searchJson(client, { query: 'approval', mode: 'text', project: LINES, limit: 2 });
    expect(two.results.length).toBe(2);
  });

  it('runs a multi-concept AND search and echoes the concepts', async () => {
    // Each concept runs a vector search, and a conversation is kept when every concept reaches its
    // top hits (search.ts searchMultipleConcepts). The index is small, so the case asserts that the
    // marked conversation is among the matches, not that the others are excluded.
    const body = await searchJson(client, { query: [MARKS[1], 'reviewer'] });
    expect(body.concepts).toEqual([MARKS[1], 'reviewer']);
    expect(body.count).toBeGreaterThan(0);
    expect(body.results.map((r) => r.exchange.project)).toContain(LINES);
    const text = await client.call('search', { query: [MARKS[1], 'reviewer'], response_format: 'markdown' });
    expect(text.isError, textOf(text)).not.toBe(true);
    expect(textOf(text)).toContain(`matching all concepts [${MARKS[1]} + reviewer]`);
  });
});

/** The result of one read call over MCP. */
async function readCall(client: McpClient, args: Record<string, unknown>): Promise<McpCallResult> {
  return client.call('read', args);
}

describe('mcp: read', () => {
  let client: McpClient;
  /** The archived copy of the marked transcript. The search that finds it names its archive path. */
  let linesArchive = '';

  beforeAll(async () => {
    client = await McpClient.start(sb);
    const found = await searchJson(client, { query: MARKS[0], mode: 'text', project: LINES, limit: 1 });
    expect(found.count).toBeGreaterThan(0);
    linesArchive = found.results[0].exchange.archivePath;
    expect(path.basename(linesArchive).endsWith('.jsonl')).toBe(true);
  }, CHILD_MS);

  afterAll(async () => {
    await client.close();
  });

  it('reads the whole transcript when no line range is given', async () => {
    const result = await readCall(client, { path: linesArchive });
    expect(result.isError, textOf(result)).not.toBe(true);
    const text = textOf(result);
    for (const mark of MARKS) expect(text).toContain(mark);
  });

  it('reads only the lines of a range: lines 3 and 4 hold the second question', async () => {
    const result = await readCall(client, { path: linesArchive, startLine: 3, endLine: 4 });
    expect(result.isError, textOf(result)).not.toBe(true);
    const text = textOf(result);
    expect(text).toContain(MARKS[1]);
    expect(text).not.toContain(MARKS[0]);
    expect(text).not.toContain(MARKS[2]);
  });

  it('answers a range past the end with no transcript text, and keeps answering', async () => {
    const past = await readCall(client, { path: linesArchive, startLine: 999 });
    const text = textOf(past);
    for (const mark of MARKS) expect(text).not.toContain(mark);
    const again = await readCall(client, { path: linesArchive, startLine: 1, endLine: 1 });
    expect(again.isError, textOf(again)).not.toBe(true);
    expect(textOf(again)).toContain(MARKS[0]);
  });

  it('refuses a range whose end line is before its start line', async () => {
    const result = await readCall(client, { path: linesArchive, startLine: 4, endLine: 2 });
    expect(result.isError, textOf(result)).toBe(true);
    expect(textOf(result)).toMatch(/endLine/);
  });

  it('refuses a .jsonl path outside the archive', async () => {
    const outside = outsideFile();
    const result = await readCall(client, { path: outside });
    expect(result.isError, textOf(result)).toBe(true);
    expect(textOf(result)).toMatch(/outside the conversation archive/);
  });

  it('refuses a dot-dot path that leaves the archive', async () => {
    outsideFile();
    // Not normalised by this test: the server must resolve the dot-dot segments itself.
    const traversal = `${sb.archive}${path.sep}..${path.sep}..${path.sep}outside.jsonl`;
    const result = await readCall(client, { path: traversal });
    expect(result.isError, textOf(result)).toBe(true);
    expect(textOf(result)).toMatch(/outside the conversation archive/);
  });

  it('refuses a file inside the archive that does not end in .jsonl', async () => {
    const note = path.join(sb.archive, 'note.txt');
    writeFileSync(note, 'not a conversation\n');
    const result = await readCall(client, { path: note });
    expect(result.isError, textOf(result)).toBe(true);
    expect(textOf(result)).toMatch(/\.jsonl/);
  });

  it('refuses a symlink inside the archive that points outside it', async () => {
    const link = path.join(sb.archive, 'escape.jsonl');
    try {
      symlinkSync(outsideFile(), link, 'file');
    } catch (err) {
      // Windows refuses a file symlink without Developer Mode or elevation. Say so, never pass silently.
      if ((err as NodeJS.ErrnoException).code === 'EPERM') {
        console.warn('[e2e] symlink case not run: this host cannot create a file symlink (EPERM)');
        return;
      }
      throw err;
    }
    const result = await readCall(client, { path: link });
    expect(result.isError, textOf(result)).toBe(true);
    expect(textOf(result)).toMatch(/symlink escape|outside the conversation archive/);
  });
});

/**
 * The transcript outside the archive that the refusal cases read. Each case creates it, so a case
 * run alone with -t needs no earlier case.
 */
function outsideFile(): string {
  const outside = path.join(sb.root, 'outside.jsonl');
  if (!existsSync(outside)) writeFileSync(outside, readFileSync(path.join(REPO_ROOT, 'test', 'fixtures', 'tiny-conversation.jsonl')));
  return outside;
}

/** The token of the auth cases. The env value carries spaces, which the server trims (src/mcp-auth.ts). */
const TOKEN = 'e2e-token-7f3a91';
const TOKEN_ENV = `  ${TOKEN}  `;

describe('mcp: auth token', () => {
  let client: McpClient;

  beforeAll(async () => {
    client = await McpClient.start(sb, { env: { EPISODIC_MEMORY_MCP_TOKEN: TOKEN_ENV } });
  }, CHILD_MS);

  afterAll(async () => {
    await client.close();
  });

  it('refuses a search that presents no token, and a search with a wrong token', async () => {
    const none = await client.call('search', { query: AUTH, mode: 'text' });
    expect(none.isError, textOf(none)).toBe(true);
    expect(textOf(none)).toMatch(/Unauthorized: valid auth_token required/);
    const wrong = await client.call('search', { query: AUTH, mode: 'text', auth_token: 'not-the-token' });
    expect(wrong.isError, textOf(wrong)).toBe(true);
    expect(textOf(wrong)).toMatch(/Unauthorized/);
  });

  it('refuses a read and a digest call that present no token', async () => {
    const read = await client.call('read', { path: path.join(sb.archive, 'missing.jsonl') });
    expect(read.isError, textOf(read)).toBe(true);
    expect(textOf(read)).toMatch(/Unauthorized/);
    const digest = await client.call('digest', { project: ALPHA });
    expect(digest.isError, textOf(digest)).toBe(true);
    expect(textOf(digest)).toMatch(/Unauthorized/);
  });

  it('answers a search that presents the right token, with the trimmed value of the env', async () => {
    const found = await searchJson(client, { query: AUTH, mode: 'text', auth_token: TOKEN });
    expect(found.count).toBeGreaterThan(0);
    expect(found.results.every((r) => r.exchange.project === ALPHA)).toBe(true);
  });

  it('lists the tools without a token, since listing is not a tool call', async () => {
    expect((await client.listTools()).sort()).toEqual([...MCP_TOOLS].sort());
  });
});

describe('mcp: wrapper', () => {
  /** The pids of the processes that run the wrapper or the server of this repo. */
  const wrapperPath = cliBin('mcp-server-wrapper.js');
  /** The poll gap of a process list. Each poll on win32 starts PowerShell, so it is not 100 ms. */
  const POLL_MS = 1_000;

  /** Poll until `predicate` holds. Throws with `label` when it does not hold in time. */
  async function pollUntil(predicate: () => boolean, label: string): Promise<void> {
    const deadline = Date.now() + PROCESS_MS;
    while (!predicate()) {
      if (Date.now() > deadline) throw new Error(`timed out after ${PROCESS_MS} ms waiting for: ${label}`);
      await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    }
  }

  it('starts the server through the wrapper, answers tools/list, and leaves no process when stdin closes', async () => {
    const wrapperBefore = pidsNaming(wrapperPath);
    const serverBefore = pidsNaming(MCP_SERVER_JS);
    const client = await McpClient.start(sb, { entry: 'wrapper' });
    let names: string[] = [];
    let code: number | null = null;
    try {
      // The wrapper runs the server as a child: a new server process must appear while the client is open.
      await pollUntil(() => pidsNaming(MCP_SERVER_JS).some((pid) => !serverBefore.includes(pid)), 'the server child of the wrapper');
      names = await client.listTools();
    } finally {
      code = await client.close();
    }
    expect([...names].sort()).toEqual([...MCP_TOOLS].sort());
    expect(code).toBe(0);
    // No orphan: the wrapper and its server child are gone, and the pids of the earlier runs are unchanged.
    await pollUntil(() => pidsNaming(MCP_SERVER_JS).every((pid) => serverBefore.includes(pid)), 'the server child to exit');
    await pollUntil(() => pidsNaming(wrapperPath).every((pid) => wrapperBefore.includes(pid)), 'the wrapper to exit');
  }, CHILD_MS);
});

/** The text of an empty digest, of an empty topic memory and of a flag-off skills call. */
const NO_TOPICS = 'Topic memory has no documents yet.';
const LEARN_OFF = 'Learning is off';

describe('mcp: digest, topics and skills on an empty index', () => {
  let empty: Sandbox;
  let client: McpClient;

  beforeAll(async () => {
    empty = makeSandbox();
    client = await McpClient.start(empty);
  }, CHILD_MS);

  afterAll(async () => {
    await client.close();
    removeSandbox(empty);
  });

  it('answers the empty digest text for a project with no entries', async () => {
    const result = await client.call('digest', { project: 'e2e-empty' });
    expect(result.isError, textOf(result)).not.toBe(true);
    expect(textOf(result)).toBe('No digest entries for e2e-empty.');
  });

  it('answers the no-documents text for topics on a fresh install', async () => {
    const result = await client.call('topics', { action: 'list', project: 'e2e-empty' });
    expect(result.isError, textOf(result)).not.toBe(true);
    expect(textOf(result)).toBe(NO_TOPICS);
  });

  it('answers the learning-off text for skills when the flag is unset', async () => {
    const result = await client.call('skills', {});
    expect(result.isError, textOf(result)).not.toBe(true);
    expect(textOf(result)).toContain(LEARN_OFF);
  });

  it('answers the no-skills text for skills with the flag on and an empty store', async () => {
    const learning = await McpClient.start(empty, { env: { EPISODIC_MEMORY_LEARN: '1' } });
    try {
      const result = await learning.call('skills', { project: 'e2e-empty' });
      expect(result.isError, textOf(result)).not.toBe(true);
      // No store file yet: the tool answers the first-run text (skills-tool.ts NO_SKILLS_MESSAGE).
      expect(textOf(result)).toContain('No learned skills yet');
    } finally {
      await learning.close();
    }
  });

  it('creates nothing when skills runs with the flag unset: the config folder listing and the index folder are unchanged', async () => {
    const pristine = makeSandbox();
    const probe = await McpClient.start(pristine);
    try {
      const before = listTree([pristine.cfg]);
      const result = await probe.call('skills', { project: 'e2e-empty' });
      expect(textOf(result)).toContain(LEARN_OFF);
      expect(diffListings(before, listTree([pristine.cfg]))).toEqual([]);
      expect(existsSync(path.join(pristine.cfg, 'conversation-index'))).toBe(false);
    } finally {
      await probe.close();
      removeSandbox(pristine);
    }
  });

  // Measured 2026-11-13 on an empty config folder, one fresh server per call: `digest` with the flag
  // unset answered the empty text and created conversation-index/db.sqlite (131072 bytes).
  it('a digest read on an empty config folder creates no file (D9)', async () => {
    const pristine = makeSandbox();
    const probe = await McpClient.start(pristine);
    try {
      const before = listTree([pristine.cfg]);
      await probe.call('digest', { project: 'e2e-empty' });
      expect(diffListings(before, listTree([pristine.cfg]))).toEqual([]);
    } finally {
      await probe.close();
      removeSandbox(pristine);
    }
  });

  // D10: before the fix, getDbPath created the conversation-index folder, so a read left a new folder behind.
  it('topics list on an empty config folder creates no folder (D10)', async () => {
    const pristine = makeSandbox();
    const probe = await McpClient.start(pristine);
    try {
      await probe.call('topics', { action: 'list', project: 'e2e-empty' });
      expect(existsSync(path.join(pristine.cfg, 'conversation-index'))).toBe(false);
    } finally {
      await probe.close();
      removeSandbox(pristine);
    }
  });
});

/** The project of the seeded digest and topic session. Its transcript is older than the quiet window. */
const DIGEST_PROJECT = 'e2e-digest';
/** The text that the fake digest and topic replies carry (ollama fake, src/digest-prompts and topic-prompts). */
const DIGEST_LINE = 'The user asked about X.';
const TOPIC_SLUG = 'e2e-topic';
const TOPIC_LINE = 'The build runs on a Linux runner.';

describe('mcp: digest and topics on a seeded index', () => {
  let seeded: Sandbox;
  let client: McpClient;

  beforeAll(async () => {
    seeded = makeSandbox();
    seedDigestableSession(seeded, DIGEST_PROJECT, { exchanges: 2, ageMinutes: 60 });
    const before = ollama.requests.length;
    const sync = await runCli(seeded, cliBin('episodic-memory.js'), ['sync'], {
      // The first topic run starts at `since` (topic-job.ts sinceTime): an older start covers the seeded session.
      env: {
        EPISODIC_MEMORY_OLLAMA_URL: ollama.url, EPISODIC_MEMORY_DIGEST: '1', EPISODIC_MEMORY_TOPICS: '1',
        EPISODIC_MEMORY_TOPICS_SINCE: '2025-01-01T00:00:00.000Z',
      },
      timeoutMs: CHILD_MS,
    });
    expect(sync.code, sync.stderr).toBe(0);
    // The fake answered the digest prompt and the topic prompt: a zero-write run would not show it.
    const kinds = ollama.requests.slice(before).map((r) => r.kind);
    expect(kinds).toContain('digest');
    expect(kinds).toContain('topic');
    client = await McpClient.start(seeded);
  }, HEAVY_MS);

  afterAll(async () => {
    if (client) await client.close();
    if (seeded) removeSandbox(seeded);
  });

  it('wrote one digest row and one topic document into the index', () => {
    const db = openIndexDb(seeded);
    try {
      const digest = db.prepare('SELECT COUNT(*) AS n FROM digest_entry WHERE project = ?').get(DIGEST_PROJECT) as { n: number };
      expect(digest.n).toBeGreaterThan(0);
      const docs = db.prepare('SELECT COUNT(*) AS n FROM topic_doc WHERE project = ?').get(DIGEST_PROJECT) as { n: number };
      expect(docs.n).toBeGreaterThanOrEqual(1);
    } finally {
      db.close();
    }
  });

  it('shows the digest of the project, with the lines the digest wrote', async () => {
    const result = await client.call('digest', { project: DIGEST_PROJECT });
    expect(result.isError, textOf(result)).not.toBe(true);
    const text = textOf(result);
    expect(text).toContain(DIGEST_LINE);
    expect(text).toContain('The agent fixed Y.');
    expect(text).not.toContain('No digest entries');
  });

  it('searches the digest and answers the no-match text for a word that no entry holds', async () => {
    const hit = await client.call('digest', { query: 'fixed', project: DIGEST_PROJECT });
    expect(hit.isError, textOf(hit)).not.toBe(true);
    expect(textOf(hit)).toContain('The agent fixed Y.');
    const miss = await client.call('digest', { query: 'zzqqxx', project: DIGEST_PROJECT });
    expect(textOf(miss)).toBe('No digest entries match "zzqqxx".');
  });

  it('expands a [#id] mark of the digest into the archive path and line range that read accepts', async () => {
    const shown = textOf(await client.call('digest', { project: DIGEST_PROJECT }));
    // An exchange id is a hex digest, so the mark pattern takes hex characters only (the header says [#id]).
    const mark = /\[#([0-9a-f]{8,})\]/.exec(shown);
    expect(mark, `a hex mark in: ${JSON.stringify(shown)}`).not.toBeNull();
    const expanded = textOf(await client.call('digest', { expand: mark![1] }));
    expect(expanded).toMatch(/^Exchange \S+ \(/);
    const archive = /^path: (.+)$/m.exec(expanded)?.[1] ?? '';
    const start = Number(/^startLine: (\d+)$/m.exec(expanded)?.[1]);
    const end = Number(/^endLine: (\d+)$/m.exec(expanded)?.[1]);
    expect(archive.endsWith('.jsonl')).toBe(true);
    const read = await client.call('read', { path: archive, startLine: start, endLine: end });
    expect(read.isError, textOf(read)).not.toBe(true);
    expect(textOf(read)).toContain('Digest seed');
  });

  it('stores a handoff note and shows it in the next digest of the project', async () => {
    const note = 'E2E next step: check the cache';
    const saved = await client.call('digest', { handoff: note, project: DIGEST_PROJECT });
    expect(textOf(saved)).toBe(`Handoff note saved for ${DIGEST_PROJECT}.`);
    expect(textOf(await client.call('digest', { project: DIGEST_PROJECT }))).toContain(note);
  });

  it('lists the topic document, reads its text and searches its paragraphs', async () => {
    const list = await client.call('topics', { action: 'list', project: DIGEST_PROJECT });
    expect(list.isError, textOf(list)).not.toBe(true);
    expect(textOf(list)).toContain(TOPIC_SLUG);
    const read = await client.call('topics', { action: 'read', project: DIGEST_PROJECT, slug: TOPIC_SLUG });
    expect(textOf(read)).toContain(TOPIC_LINE);
    const missing = await client.call('topics', { action: 'read', project: DIGEST_PROJECT, slug: 'nope' });
    expect(textOf(missing)).toBe(`No topic document "nope" in ${DIGEST_PROJECT}.`);
    const search = await client.call('topics', { action: 'search', project: DIGEST_PROJECT, query: 'runner' });
    expect(search.isError, textOf(search)).not.toBe(true);
    expect(textOf(search)).toContain(TOPIC_SLUG);
  });

  it('answers the links of one paragraph and the timeline of the document', async () => {
    const search = textOf(await client.call('topics', { action: 'search', project: DIGEST_PROJECT, query: 'runner' }));
    const unit = /unit ([0-9a-f]{8})/.exec(search)?.[1];
    expect(unit, `a unit id in: ${search}`).toBeDefined();
    const links = textOf(await client.call('topics', { action: 'links', project: DIGEST_PROJECT, unit }));
    expect(links).toContain(`Outgoing links of ${unit}:`);
    expect(links).toContain(`Backlinks of ${unit}:`);
    const timeline = textOf(await client.call('topics', { action: 'timeline', project: DIGEST_PROJECT }));
    expect(timeline).toContain('2025-09-19');
  });

  it('refuses a topics call that lacks the argument its action needs, and a reversed time range', async () => {
    const noUnit = await client.call('topics', { action: 'links', project: DIGEST_PROJECT });
    expect(noUnit.isError, textOf(noUnit)).toBe(true);
    expect(textOf(noUnit)).toContain('unit is required for action links');
    const reversed = await client.call('topics', { action: 'timeline', project: DIGEST_PROJECT, from: '2025-10', to: '2025-01' });
    expect(reversed.isError, textOf(reversed)).toBe(true);
    expect(textOf(reversed)).toContain('to must not be before from');
  });
});

/** The project and the one skill of the learned-skills case. A candidate is seeded, then approved by the CLI. */
const SKILLS_PROJECT = 'e2e-skills';
const SKILL_SLUG = 'release-checklist';
const SKILL_DESCRIPTION = 'Checklist of the release steps';
const SKILL_BODY = 'Write the changelog entry first, then bump the manifest.';
/** A validation record that clears every refusal of `approve` (the same record as learn.test). */
const VALIDATED = {
  targeted: [1], sample: [1], passedBefore: 0, passedAfter: 1, regressions: [],
  judgedAt: '2025-10-08T12:00:00.000Z', meanTurnsBefore: null, meanTurnsAfter: 2,
  usdBefore: null, usdAfter: null, gradedBefore: 1, gradedAfter: 1,
};

describe('mcp: skills on a seeded store', () => {
  let skillsSb: Sandbox;
  let client: McpClient;
  let entryName = '';

  beforeAll(async () => {
    skillsSb = makeSandbox();
    // No offline producer of candidates exists: the test process seeds one through the store API.
    entryName = await withSandboxEnv(skillsSb, async () => {
      const store = openKnowledgeStore();
      try {
        const name = await insertKnowledgeEntry(store, {
          project: SKILLS_PROJECT, confidence: 'high', trust: 'unverified', sources: [], status: 'candidate', runId: 'run-e2e-mcp',
          kind: 'skill', slug: SKILL_SLUG, title: 'Release checklist', description: SKILL_DESCRIPTION,
          scope: 'release of this project', body: SKILL_BODY,
        });
        await store.setValidation(name, VALIDATED);
        return name;
      } finally {
        store.close();
      }
    });
    const approve = await runCli(skillsSb, cliBin('episodic-memory.js'), ['learn', 'approve', entryName, '--yes'], {
      env: { EPISODIC_MEMORY_LEARN: '1', EPISODIC_MEMORY_OLLAMA_URL: ollama.url },
      timeoutMs: CHILD_MS,
    });
    expect(approve.code, approve.stderr).toBe(0);
    client = await McpClient.start(skillsSb, { env: { EPISODIC_MEMORY_LEARN: '1' } });
  }, HEAVY_MS);

  afterAll(async () => {
    if (client) await client.close();
    if (skillsSb) removeSandbox(skillsSb);
  });

  it('lists the approved skill of the project with its description', async () => {
    const result = await client.call('skills', { project: SKILLS_PROJECT });
    expect(result.isError, textOf(result)).not.toBe(true);
    expect(textOf(result)).toContain(`${SKILL_SLUG}: ${SKILL_DESCRIPTION}`);
  });

  it('loads the body of the skill by its slug', async () => {
    const result = await client.call('skills', { get: SKILL_SLUG, project: SKILLS_PROJECT });
    expect(result.isError, textOf(result)).not.toBe(true);
    expect(textOf(result)).toContain(SKILL_BODY);
  });

  it('searches the skills, and answers the no-match and unknown-slug texts', async () => {
    const hit = await client.call('skills', { query: 'changelog', project: SKILLS_PROJECT });
    expect(textOf(hit)).toContain(SKILL_SLUG);
    const miss = await client.call('skills', { query: 'zzqqxx', project: SKILLS_PROJECT });
    expect(textOf(miss)).toBe('No learned skills match "zzqqxx".');
    const unknown = await client.call('skills', { get: 'nope', project: SKILLS_PROJECT });
    expect(textOf(unknown)).toBe('No learned skill "nope".');
  });

  it('lists no skill for another project', async () => {
    const result = await client.call('skills', { project: 'e2e-other' });
    expect(textOf(result)).toBe('No learned skills for e2e-other.');
    expect(entryName).toContain(SKILLS_PROJECT);
  });
});
